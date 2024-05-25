'use strict';

const sha512 = require('js-sha512');
const { v4: uuidv4 } = require('uuid');
const webSocket = require('ws');
const axios = require('axios');

class HmCloudAPI {
    constructor(configDataOrApId, pin) {
        if (configDataOrApId !== undefined) {
            this.parseConfigData(configDataOrApId, pin);
        }

        this.eventRaised = null;
    }

    parseConfigData(configDataOrApId, pin, deviceId) {
        if (typeof configDataOrApId === 'string') {
            this._accessPointSgtin = configDataOrApId.replace(/[^a-fA-F0-9 ]/g, '');
            this._clientAuthToken = sha512(`${this._accessPointSgtin}jiLpVitHvWnIGD1yo7MA`).toUpperCase();
            this._authToken = '';
            this._clientId = '';

            this._urlREST = '';
            this._urlWebSocket = '';
            this._deviceId = deviceId || uuidv4();
            this._pin = pin;
        } else {
            this._authToken = configDataOrApId.authToken;
            this._clientAuthToken = configDataOrApId.clientAuthToken;
            this._clientId = configDataOrApId.clientId;
            this._accessPointSgtin = configDataOrApId.accessPointSgtin.replace(/[^a-fA-F0-9 ]/g, '');
            this._pin = configDataOrApId.pin;
            this._deviceId = configDataOrApId.deviceId || uuidv4();
        }

        this._clientCharacteristics = {
            clientCharacteristics: {
                apiVersion: '12',
                applicationIdentifier: 'iobroker',
                applicationVersion: '1.0',
                deviceManufacturer: 'none',
                deviceType: 'Computer',
                language: 'en_US',
                osType: 'Linux',
                osVersion: 'NT',
            },
            id: this._accessPointSgtin
        };
    }

    getSaveData() {
        return {
            authToken: this._authToken,
            clientAuthToken: this._clientAuthToken,
            clientId: this._clientId,
            accessPointSgtin: this._accessPointSgtin,
            pin: this._pin,
            deviceId: this._deviceId,
        };
    }

    async getHomematicHosts() {
        let res;
        try {
            const response = await axios.post('https://lookup.homematic.com:48335/getHost', this._clientCharacteristics);
            res = response.data;
        } catch (err) {
            this.requestError && this.requestError(err);
        }
        if (res && typeof res === 'object') {
            this._urlREST = res.urlREST;
            this._urlWebSocket = res.urlWebSocket;
            if (this._urlWebSocket.startsWith('http')) {
                this._urlWebSocket = `ws${this._urlWebSocket.substring(4)}`; // make sure it is ws:// or wss://
            }
        }
        if (!this._urlREST || !this._urlWebSocket) {
            throw new Error('Could not get host details. Please check the SGTIN.');
        }
    }

    // =========== API for Token generation ===========

    async auth1connectionRequest(deviceName = 'hmipnodejs') {
        const headers = {
            'content-type': 'application/json',
            accept: 'application/json',
            VERSION: '12',
            CLIENTAUTH: this._clientAuthToken,
        };
        if (this._pin) {
            headers['PIN'] = this._pin;
        }
        const body = {
            deviceId: this._deviceId,
            deviceName,
            sgtin: this._accessPointSgtin,
        };
        try {
            const response = await axios.post(`${this._urlREST}/hmip/auth/connectionRequest`, body, {
                headers,
                validateStatus: status => status < 400,
            });
            return response.data;
        } catch (err) {
            this.requestError && this.requestError(err);
            return null;
        }
    }

    async auth2isRequestAcknowledged() {
        const headers = {
            'content-type': 'application/json',
            accept: 'application/json',
            VERSION: '12',
            CLIENTAUTH: this._clientAuthToken,
        };
        const body = { deviceId: this._deviceId };
        try {
            await axios.post(`${this._urlREST}/hmip/auth/isRequestAcknowledged`, body, {
                headers,
                validateStatus: status => status === 200,
            });
            return true;
        } catch (err) {
            this.requestError && this.requestError(err);
            return false;
        }
    }

    async auth3requestAuthToken() {
        let headers = {
            'content-type': 'application/json',
            accept: 'application/json',
            VERSION: '12',
            CLIENTAUTH: this._clientAuthToken,
        };
        let body = { deviceId: this._deviceId };
        let res;
        try {
            let response = await axios.post(`${this._urlREST}/hmip/auth/requestAuthToken`, body, {
                headers,
                validateStatus: status => status < 400,
            });
            res = response.data;
            this._authToken = res.authToken;
            body = {
                deviceId: this._deviceId,
                authToken: this._authToken,
            };
            response = await axios.post(`${this._urlREST}/hmip/auth/confirmAuthToken`, body, {
                headers,
                validateStatus: status => status => status < 400,
            });
            res = response.data;
            this._clientId = res.clientId;
        } catch (err) {
            this.requestError && this.requestError(err);
        }
    }

    async callRestApi(path, data) {
        let headers = {
            'content-type': 'application/json',
            accept: 'application/json',
            VERSION: '12',
            AUTHTOKEN: this._authToken,
            CLIENTAUTH: this._clientAuthToken,
        };
        try {
            const response = await axios.post(`${this._urlREST}/hmip/${path}`, data, { headers });
            return response.data;
        } catch (err) {
            this.requestError && this.requestError(err);
        }
    }

    // =========== API for HM ===========
    async loadCurrentConfig() {
        let state = await this.callRestApi('home/getCurrentState', this._clientCharacteristics);
        if (state) {
            this.home = state.home;
            this.groups = state.groups;
            this.clients = state.clients;
            this.devices = state.devices;
        } else {
            throw new Error('No current State received');
        }
    }

    // =========== Event Handling ===========

    dispose() {
        this.isClosed = true;
        if (this._ws) {
            this._ws.close();
        }
        if (this._connectTimeout) {
            clearTimeout(this._connectTimeout);
        }
        if (this._pingInterval) {
            clearInterval(this._pingInterval);
        }
    }

    connectWebsocket() {
        if (this._pingInterval) {
            clearInterval(this._pingInterval);
            this._pingInterval = null;
        }
        this._ws = new webSocket(this._urlWebSocket, {
            headers: {
                'AUTHTOKEN': this._authToken,
                'CLIENTAUTH': this._clientAuthToken,
            },
            perMessageDeflate: false,
        });

        this._ws.on('open', () => {
            this.opened && this.opened();

            this._pingInterval && clearInterval(this._pingInterval);
            this._pingInterval = setInterval(() =>
                this._ws.ping(() => { }), 5000);
        });

        this._ws.on('close', (code, reason) => {
            this.closed && this.closed(code, reason.toString('utf8'));
            if (this._pingInterval) {
                clearInterval(this._pingInterval);
                this._pingInterval = null;
            }
            if (!this.isClosed) {
                this._connectTimeout && clearTimeout(this._connectTimeout);
                this._connectTimeout = setTimeout(() => {
                    this._connectTimeout = null;
                    this.connectWebsocket()
                }, 10000);
            }
        });

        this._ws.on('error', (error) => {
            this.errored && this.errored(error);
            if (this._pingInterval) {
                clearInterval(this._pingInterval);
                this._pingInterval = null;
            }
            if (!this.isClosed) {
                this._connectTimeout && clearTimeout(this._connectTimeout);
                this._connectTimeout = setTimeout(() => {
                    this._connectTimeout = null;
                    this.connectWebsocket()
                }, 10000);
            }
        });

        this._ws.on('unexpected-response', (request, response) => {
            this.unexpectedResponse && this.unexpectedResponse(request, response);
            if (this._pingInterval) {
                clearInterval(this._pingInterval);
                this._pingInterval = null;
            }
            if (!this.isClosed) {
                this._connectTimeout && clearTimeout(this._connectTimeout);
                this._connectTimeout = setTimeout(() => {
                    this._connectTimeout = null;
                    this.connectWebsocket();
                }, 10000);
            }
        });

        this._ws.on('message', (d) => {
            const dString = d.toString('utf8');
            this.dataReceived && this.dataReceived(dString);
            const data = JSON.parse(dString);
            this._parseEventdata(data);
        });

        this._ws.on('ping', () => this.dataReceived && this.dataReceived('ping'));

        this._ws.on('pong', () => this.dataReceived && this.dataReceived('pong'));
    }

    _parseEventdata(data) {
        for (let i in data.events) {
            let ev = data.events[i];
            switch (ev.pushEventType) {
                case 'DEVICE_ADDED':
                case 'DEVICE_CHANGED':
                    if (ev.device) {
                        this.devices[ev.device.id] = ev.device;
                    }
                    break;
                case 'GROUP_ADDED':
                case 'GROUP_CHANGED':
                    if (ev.group) {
                        this.groups[ev.group.id] = ev.group;
                    }
                    break;
                case 'CLIENT_ADDED':
                case 'CLIENT_CHANGED':
                    if (ev.client) {
                        this.clients[ev.client.id] = ev.client;
                    }
                    break;
                case 'DEVICE_REMOVED':
                    ev.device && delete this.devices[ev.device.id];
                    break;
                case 'GROUP_REMOVED':
                    ev.group && delete this.clients[ev.group.id];
                    break;
                case 'CLIENT_REMOVED':
                    ev.client && delete this.groups[ev.client.id];
                    break;
                case 'HOME_CHANGED':
                    this.home = ev.home;
                    break;
            }
            this.eventRaised && this.eventRaised(ev);
        }
    }

    // =========== API for HM Devices ===========

    // boolean
    async deviceControlSetSwitchState(deviceId, on, channelIndex = 1) {
        const data = {
            deviceId,
            on,
            channelIndex,
        };
        await this.callRestApi('device/control/setSwitchState', data);
    }

    // door commands as number: 1 = open; 2 = stop; 3 = close; 4 = ventilation position
    // DoorState
    //     CLOSED = auto()
    //     OPEN = auto()
    //     VENTILATION_POSITION = auto()
    //     POSITION_UNKNOWN = auto()
    //
    // DoorCommand
    //     OPEN = auto()
    //     STOP = auto()
    //     CLOSE = auto()
    //     PARTIAL_OPEN = auto()
    async deviceControlSendDoorCommand(deviceId, doorCommand, channelIndex = 1) {
        let data = { deviceId, channelIndex, doorCommand };
        await this.callRestApi('device/control/sendDoorCommand', data);
    }

    async deviceControlSetLockState(deviceId, lockState, pin, channelIndex = 1) {
        let data = { deviceId, channelIndex, authorizationPin: pin.toString(), targetLockState: lockState };
        await this.callRestApi('device/control/setLockState', data);
    }

    async deviceControlResetEnergyCounter(deviceId, channelIndex = 1) {
        let data = { deviceId, channelIndex };
        await this.callRestApi('device/control/resetEnergyCounter', data);
    }

    async deviceConfigurationSetOperationLock(deviceId, operationLock, channelIndex = 1) {
        let data = { deviceId, channelIndex, 'operationLock': operationLock };
        await this.callRestApi('device/configuration/setOperationLock', data);
    }

    // ClimateControlDisplay
    //     ACTUAL = auto()
    //     SETPOINT = auto()
    //     ACTUAL_HUMIDITY = auto()
    async deviceConfigurationSetClimateControlDisplay(deviceId, display, channelIndex = 1) {
        let data = { deviceId, channelIndex, display };
        await this.callRestApi('device/configuration/setClimateControlDisplay', data);
    }

    // float 0.0-1.0
    async deviceConfigurationSetMinimumFloorHeatingValvePosition(deviceId, minimumFloorHeatingValvePosition, channelIndex = 1) {
        let data = { deviceId, channelIndex, minimumFloorHeatingValvePosition };
        await this.callRestApi('device/configuration/setMinimumFloorHeatingValvePosition', data);
    }

    // float 0.0-1.0??
    async deviceControlSetDimLevel(deviceId, dimLevel, channelIndex = 1) {
        let data = { deviceId, channelIndex, dimLevel };
        await this.callRestApi('device/control/setDimLevel', data);
    }

    // float 0.0-1.0??
    async deviceControlSetRgbDimLevel(deviceId, rgb, dimLevel, channelIndex = 1) {
        let data = { deviceId, channelIndex, 'simpleRGBColorState': rgb, dimLevel };
        await this.callRestApi('device/control/setSimpleRGBColorDimLevel', data);
    }

    // float 0.0-1.0??
    // not used right now
    async deviceControlSetRgbDimLevelWithTime(deviceId, rgb, dimLevel, onTime, rampTime, channelIndex = 1) {
        let data = { deviceId, channelIndex, simpleRGBColorState: rgb, dimLevel, onTime, rampTime };
        await this.callRestApi('device/control/setSimpleRGBColorDimLevelWithTime', data);
    }

    // float 0.0 = open - 1.0 = closed
    async deviceControlSetShutterLevel(deviceId, shutterLevel, channelIndex = 1) {
        let data = { deviceId, channelIndex, shutterLevel };
        await this.callRestApi('device/control/setShutterLevel', data);
    }

    async deviceControlStartImpulse(deviceId, channelIndex = 1) {
        let data = { deviceId, channelIndex };
        await this.callRestApi('device/control/startImpulse', data);
    }

    // float 0.0 = open - 1.0 = closed
    async deviceControlSetSlatsLevel(deviceId, slatsLevel, shutterLevel, channelIndex = 1) {
        let data = { deviceId, channelIndex, slatsLevel, shutterLevel };
        await this.callRestApi('device/control/setSlatsLevel', data);
    }

    async deviceControlStop(deviceId, channelIndex = 1) {
        let data = { deviceId, channelIndex };
        await this.callRestApi('device/control/stop', data);
    }

    async deviceControlSetPrimaryShadingLevel(deviceId, primaryShadingLevel, channelIndex = 1) {
        let data = { deviceId, channelIndex, 'primaryShadingLevel': primaryShadingLevel };
        await this.callRestApi('device/control/setPrimaryShadingLevel', data);
    }

    async deviceControlSetSecondaryShadingLevel(deviceId, primaryShadingLevel, secondaryShadingLevel, channelIndex = 1) {
        let data = { deviceId, channelIndex, primaryShadingLevel, secondaryShadingLevel };
        await this.callRestApi('device/control/setSecondaryShadingLevel', data);
    }

    // AcousticAlarmSignal
    //     DISABLE_ACOUSTIC_SIGNAL = auto()
    //     FREQUENCY_RISING = auto()
    //     FREQUENCY_FALLING = auto()
    //     FREQUENCY_RISING_AND_FALLING = auto()
    //     FREQUENCY_ALTERNATING_LOW_HIGH = auto()
    //     FREQUENCY_ALTERNATING_LOW_MID_HIGH = auto()
    //     FREQUENCY_HIGHON_OFF = auto()
    //     FREQUENCY_HIGHON_LONGOFF = auto()
    //     FREQUENCY_LOWON_OFF_HIGHON_OFF = auto()
    //     FREQUENCY_LOWON_LONGOFF_HIGHON_LONGOFF = auto()
    //     LOW_BATTERY = auto()
    //     DISARMED = auto()
    //     INTERNALLY_ARMED = auto()
    //     EXTERNALLY_ARMED = auto()
    //     DELAYED_INTERNALLY_ARMED = auto()
    //     DELAYED_EXTERNALLY_ARMED = auto()
    //     EVENT = auto()
    //     ERROR = auto()
    async deviceConfigurationSetAcousticAlarmSignal(deviceId, acousticAlarmSignal, channelIndex = 1) {
        let data = { deviceId, acousticAlarmSignal, channelIndex };
        await this.callRestApi('device/configuration/setAcousticAlarmSignal', data);
    }

    // AcousticAlarmTiming
    //     PERMANENT = auto()
    //     THREE_MINUTES = auto()
    //     SIX_MINUTES = auto()
    //     ONCE_PER_MINUTE = auto()
    async deviceConfigurationSetAcousticAlarmTiming(deviceId, acousticAlarmTiming, channelIndex = 1) {
        let data = { deviceId, acousticAlarmTiming, channelIndex };
        await this.callRestApi('device/configuration/setAcousticAlarmTiming', data);
    }

    // WaterAlarmTrigger
    //     NO_ALARM = auto()
    //     MOISTURE_DETECTION = auto()
    //     WATER_DETECTION = auto()
    //     WATER_MOISTURE_DETECTION = auto()
    async deviceConfigurationSetAcousticWaterAlarmTrigger(deviceId, acousticWaterAlarmTrigger, channelIndex = 1) {
        let data = { deviceId, acousticWaterAlarmTrigger, channelIndex };
        await this.callRestApi('device/configuration/setAcousticWaterAlarmTrigger', data);
    }

    // WaterAlarmTrigger
    //     NO_ALARM = auto()
    //     MOISTURE_DETECTION = auto()
    //     WATER_DETECTION = auto()
    //     WATER_MOISTURE_DETECTION = auto()
    async deviceConfigurationSetInAppWaterAlarmTrigger(deviceId, inAppWaterAlarmTrigger, channelIndex = 1) {
        let data = { deviceId, inAppWaterAlarmTrigger, channelIndex };
        await this.callRestApi('device/configuration/setInAppWaterAlarmTrigger', data);
    }

    // WaterAlarmTrigger
    //     NO_ALARM = auto()
    //     MOISTURE_DETECTION = auto()
    //     WATER_DETECTION = auto()
    //     WATER_MOISTURE_DETECTION = auto()
    async deviceConfigurationSetSirenWaterAlarmTrigger(deviceId, sirenWaterAlarmTrigger, channelIndex = 1) {
        let data = { deviceId, sirenWaterAlarmTrigger, channelIndex };
        await this.callRestApi('device/configuration/setSirenWaterAlarmTrigger', data);
    }

    // AccelerationSensorMode
    //     ANY_MOTION = auto()
    //     FLAT_DECT = auto()
    async deviceConfigurationSetAccelerationSensorMode(deviceId, accelerationSensorMode, channelIndex = 1) {
        let data = { deviceId, accelerationSensorMode, channelIndex };
        await this.callRestApi('device/configuration/setAccelerationSensorMode', data);
    }

    // AccelerationSensorNeutralPosition
    //     HORIZONTAL = auto()
    //     VERTICAL = auto()
    async deviceConfigurationSetAccelerationSensorNeutralPosition(deviceId, accelerationSensorNeutralPosition, channelIndex = 1) {
        let data = { deviceId, accelerationSensorNeutralPosition, channelIndex };
        await this.callRestApi('device/configuration/setAccelerationSensorNeutralPosition', data);
    }

    // accelerationSensorTriggerAngle = int
    async deviceConfigurationSetAccelerationSensorTriggerAngle(deviceId, accelerationSensorTriggerAngle, channelIndex = 1) {
        let data = { deviceId, accelerationSensorTriggerAngle, channelIndex };
        await this.callRestApi('device/configuration/setAccelerationSensorTriggerAngle', data);
    }

    // AccelerationSensorSensitivity
    //     SENSOR_RANGE_16G = auto()
    //     SENSOR_RANGE_8G = auto()
    //     SENSOR_RANGE_4G = auto()
    //     SENSOR_RANGE_2G = auto()
    //     SENSOR_RANGE_2G_PLUS_SENS = auto()
    //     SENSOR_RANGE_2G_2PLUS_SENSE = auto()
    async deviceConfigurationSetAccelerationSensorSensitivity(deviceId, accelerationSensorSensitivity, channelIndex = 1) {
        let data = { deviceId, accelerationSensorSensitivity, channelIndex };
        await this.callRestApi('device/configuration/setAccelerationSensorSensitivity', data);
    }

    // accelerationSensorEventFilterPeriod = float
    async deviceConfigurationSetAccelerationSensorEventFilterPeriod(deviceId, accelerationSensorEventFilterPeriod, channelIndex = 1) {
        let data = { deviceId, accelerationSensorEventFilterPeriod, channelIndex };
        await this.callRestApi('device/configuration/setAccelerationSensorEventFilterPeriod', data);
    }

    // NotificationSoundType
    //     SOUND_NO_SOUND = auto()
    //     SOUND_SHORT = auto()
    //     SOUND_SHORT_SHORT = auto()
    //     SOUND_LONG = auto()
    async deviceConfigurationSetNotificationSoundTyp(deviceId, notificationSoundType, isHighToLow, channelIndex = 1) {
        let data = { deviceId, notificationSoundType, isHighToLow, channelIndex };
        await this.callRestApi('device/configuration/setNotificationSoundTyp', data);
    }

    async deviceConfigurationSetRouterModuleEnabled(deviceId, routerModuleEnabled, channelIndex = 1) {
        let data = { deviceId, routerModuleEnabled, channelIndex };
        await this.callRestApi('device/configuration/setRouterModuleEnabled', data);
    }

    async deviceDeleteDevice(deviceId) {
        let data = { deviceId };
        await this.callRestApi('device/deleteDevice', data);
    }

    async deviceSetDeviceLabel(deviceId, label) {
        let data = { deviceId, label };
        await this.callRestApi('device/setDeviceLabel', data);
    }

    async deviceIsUpdateApplicable(deviceId) {
        let data = { deviceId };
        await this.callRestApi('device/isUpdateApplicable', data);
    }

    async deviceAuthorizeUpdate(deviceId) {
        let data = { deviceId };
        await this.callRestApi('device/authorizeUpdate', data);
    }

    // =========== API for HM Groups ===========

    async groupHeatingSetPointTemperature(groupId, setPointTemperature) {
        let data = { groupId, setPointTemperature };
        await this.callRestApi('group/heating/setSetPointTemperature', data);
    }

    async groupHeatingSetBoostDuration(groupId, boostDuration) {
        let data = { groupId, boostDuration };
        await this.callRestApi('group/heating/setBoostDuration', data);
    }

    async groupHeatingSetBoost(groupId, boost) {
        let data = { groupId, boost };
        await this.callRestApi('group/heating/setBoost', data);
    }

    async groupHeatingSetControlMode(groupId, controlMode) {
        let data = { groupId, controlMode };
        //AUTOMATIC,MANUAL
        await this.callRestApi('group/heating/setControlMode', data);
    }

    async groupHeatingSetActiveProfile(groupId, profileIndex) {
        let data = { groupId, profileIndex };
        await this.callRestApi('group/heating/setActiveProfile', data);
    }

    async groupSwitchingAlarmSetOnTime(groupId, onTime) {
        let data ={groupId, onTime};
        await this.callRestApi('group/switching/alarm/setOnTime', data);
    }

    async groupSwitchingAlarmTestSignalOptical(groupId, signalOptical) {
        let data = { groupId, signalOptical };
        await this.callRestApi('group/switching/alarm/testSignalOptical', data);
    }

    async groupSwitchingAlarmSetSignalOptical(groupId, signalOptical) {
        let data = { groupId, signalOptical };
        await this.callRestApi('group/switching/alarm/setSignalOptical', data);
    }

    async groupSwitchingAlarmTestSignalAcoustic(groupId, signalAcoustic) {
        let data = { groupId, signalAcoustic };
        await this.callRestApi('group/switching/alarm/testSignalAcoustic', data);
    }

    async groupSwitchingAlarmSetSignalAcoustic(groupId, signalAcoustic) {
        let data = { groupId, signalAcoustic };
        await this.callRestApi('group/switching/alarm/setSignalAcoustic', data);
    }

    // =========== API for HM Clients ===========

    async clientDeleteClient(clientId) {
        let data = { clientId };
        await this.callRestApi('client/deleteClient', data);
    }

    // =========== API for HM Home ===========

    async homeHeatingActivateAbsenceWithPeriod(endTime) {
        let data = { endTime };
        await this.callRestApi('home/heating/activateAbsenceWithPeriod', data);
    }

    async homeHeatingActivateAbsenceWithDuration(duration) {
        let data = { duration };
        await this.callRestApi('home/heating/activateAbsenceWithDuration', data);
    }

    async homeHeatingActivateAbsencePermanent() {
        await this.callRestApi('home/heating/activateAbsencePermanent');
    }

    async homeHeatingDeactivateAbsence() {
        await this.callRestApi('home/heating/deactivateAbsence');
    }

    async homeHeatingActivateVacation(temperature, endtime) {
        let data = { temperature, endtime };
        await this.callRestApi('home/heating/activateVacation', data);
    }

    async homeHeatingDeactivateVacation() {
        await this.callRestApi('home/heating/deactivateVacation');
    }

    async homeSetIntrusionAlertThroughSmokeDetectors(intrusionAlertThroughSmokeDetectors) {
        let data = { intrusionAlertThroughSmokeDetectors };
        await this.callRestApi('home/security/setIntrusionAlertThroughSmokeDetectors', data);
    }

    async homeSetZonesActivation(internal, external) {
        let data = { zonesActivation: { INTERNAL: internal, EXTERNAL: external } };
        await this.callRestApi('home/security/setZonesActivation', data);
    }
}

module.exports = HmCloudAPI;
