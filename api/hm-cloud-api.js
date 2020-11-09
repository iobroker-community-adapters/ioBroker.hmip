/* jshint -W097 */// jshint strict:false
/*jslint node: true */
'use strict';

const rq = require('request-promise-native');
const sha512 = require('js-sha512');
const {v4: uuidv4} = require('uuid');
const webSocket = require('ws');

class HmCloudAPI {
    constructor(configDataOrApId, pin) {
        if (configDataOrApId != null) {
            this.parseConfigData(configDataOrApId, pin);
        }

        this.eventRaised = null;
    }

    parseConfigData(configDataOrApId, pin, deviceId) {
        if (typeof configDataOrApId === 'string') {
            this._accessPointSgtin = configDataOrApId.replace(/[^a-fA-F0-9 ]/g, '');
            this._clientAuthToken = sha512(this._accessPointSgtin + "jiLpVitHvWnIGD1yo7MA").toUpperCase();
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
            "clientCharacteristics":
            {
                "apiVersion": "12",
                "applicationIdentifier": "iobroker",
                "applicationVersion": "1.0",
                "deviceManufacturer": "none",
                "deviceType": "Computer",
                "language": 'en_US',
                "osType": 'Linux',
                "osVersion": 'NT',
            },
            "id": this._accessPointSgtin
        };
    }

    getSaveData() {
        return {
            'authToken': this._authToken,
            'clientAuthToken': this._clientAuthToken,
            'clientId': this._clientId,
            'accessPointSgtin': this._accessPointSgtin,
            'pin': this._pin,
            'deviceId': this._deviceId
        }
    }

    async getHomematicHosts() {
        let res;
        try {
            res = await rq("https://lookup.homematic.com:48335/getHost", {
                method: 'POST',
                json: true,
                body: this._clientCharacteristics
            });
        } catch (err) {
            this.requestError && this.requestError(err);
        }
        if (res && typeof res === 'object') {
            this._urlREST = res.urlREST;
            this._urlWebSocket = res.urlWebSocket;
        }
    }

    // =========== API for Token generation ===========

    async auth1connectionRequest(devicename = 'hmipnodejs') {
        const headers = { 'content-type': 'application/json', 'accept': 'application/json', 'VERSION': '12', 'CLIENTAUTH': this._clientAuthToken };
        if (this._pin)
            headers['PIN'] = this._pin;
        const body = { "deviceId": this._deviceId, "deviceName": devicename, "sgtin": this._accessPointSgtin };
        let res;
        try {
            res = await rq(this._urlREST + "/hmip/auth/connectionRequest", { method: 'POST', json: true, body: body, headers: headers, simple: false, resolveWithFullResponse: true });
        } catch (err) {
            this.requestError && this.requestError(err);
        }
        if (!res || res.statusCode != 200)
            throw "error";
    }

    async auth2isRequestAcknowledged() {
        const headers = { 'content-type': 'application/json', 'accept': 'application/json', 'VERSION': '12', 'CLIENTAUTH': this._clientAuthToken };
        const body = { "deviceId": this._deviceId };
        let res;
        try {
            res = await rq(this._urlREST + "/hmip/auth/isRequestAcknowledged", { method: 'POST', json: true, body: body, headers: headers, simple: false, resolveWithFullResponse: true });
        } catch (err) {
            this.requestError && this.requestError(err);
        }
        return res && typeof res === 'object' && res.statusCode == 200;
    }

    async auth3requestAuthToken() {
        let headers = { 'content-type': 'application/json', 'accept': 'application/json', 'VERSION': '12', 'CLIENTAUTH': this._clientAuthToken };
        let body = { "deviceId": this._deviceId };
        let res;
        try {
            res = await rq(this._urlREST + "/hmip/auth/requestAuthToken", { method: 'POST', json: true, body: body, headers: headers });
            this._authToken = res.authToken;
            body = { "deviceId": this._deviceId, "authToken": this._authToken };
            res = await rq(this._urlREST + "/hmip/auth/confirmAuthToken", { method: 'POST', json: true, body: body, headers: headers });
            this._clientId = res.clientId;
        } catch (err) {
            this.requestError && this.requestError(err);
        }
    }

    async callRestApi(path, data) {
        let headers = { 'content-type': 'application/json', 'accept': 'application/json', 'VERSION': '12', 'AUTHTOKEN': this._authToken, 'CLIENTAUTH': this._clientAuthToken };
        let res;
        try {
            res = await rq(this._urlREST + "/hmip/" + path, { method: 'POST', json: true, body: data, headers: headers });
            return res;
        } catch (err) {
            this.requestError && this.requestError(err);
        }
    }

    // =========== API for HM ===========

    async loadCurrentConfig() {
        let state = await this.callRestApi('home/getCurrentState', this._clientCharacteristics);
        this.home = state.home;
        this.groups = state.groups;
        this.clients = state.clients;
        this.devices = state.devices;
    }

    // =========== Event Handling ===========

    dispose() {
        this.isClosed = true;
        if (this._connectTimeout)
            clearTimeout(this._connectTimeout);
        if (this._pingInterval)
            clearInterval(this._pingInterval);
    }

    connectWebsocket() {
        if (this._pingInterval) {
            clearInterval(this._pingInterval);
            this._pingInterval = null;
        }
        this._ws = new webSocket(this._urlWebSocket, {
            headers: {
                'AUTHTOKEN': this._authToken, 'CLIENTAUTH': this._clientAuthToken
            },
            perMessageDeflate: false
        });

        this._ws.on('open', () => {
            if (this.opened)
                this.opened();

            this._pingInterval && clearInterval(this._pingInterval);
            this._pingInterval = setInterval(() => {
                this._ws.ping(() => { });
            }, 5000);
        });

        this._ws.on('close', (code, reason) => {
            if (this.closed)
                this.closed(code, reason);
            if (this._pingInterval) {
                clearInterval(this._pingInterval);
                this._pingInterval = null;
            }
            if (!this.isClosed) {
                this._connectTimeout && clearTimeout(this._connectTimeout);
                this._connectTimeout = setTimeout(() => this.connectWebsocket(), 1000);
            }
        });

        this._ws.on('error', (error) => {
            if (this.errored)
                this.errored(error);
            if (!this.isClosed) {
                this._connectTimeout && clearTimeout(this._connectTimeout);
                this._connectTimeout = setTimeout(() => this.connectWebsocket(), 1000);
            }
        });

        this._ws.on('unexpected-response', (request, response) => {
            if (this.unexpectedResponse)
                this.unexpectedResponse(request, response);
            if (!this.isClosed) {
                this._connectTimeout && clearTimeout(this._connectTimeout);
                this._connectTimeout = setTimeout(() => this.connectWebsocket(), 1000);
            }
        });

        this._ws.on('message', (d) => {
            let dString = d.toString('utf8');
            if (this.dataReceived)
                this.dataReceived(dString);
            let data = JSON.parse(dString);
            this._parseEventdata(data);
        });

        this._ws.on('ping', () => {
            if (this.dataReceived)
                this.dataReceived("ping");
        });

        this._ws.on('pong', () => {
            if (this.dataReceived)
                this.dataReceived("pong");
        });
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
            if (this.eventRaised)
                this.eventRaised(ev);
        }
    }

    // =========== API for HM Devices ===========

    async deviceControlSetSwitchState(deviceId, on, channelIndex = 1) {
        let data = { "deviceId": deviceId, "on": on, "channelIndex": channelIndex };
        await this.callRestApi('device/control/setSwitchState', data);
    }
    
    //door commands as number: 1 = open; 2 = stop; 3 = close; 4 = ventilation position
    async deviceControlSendDoorCommand(deviceId, doorCommand, channelIndex = 1) {
        let data = { "deviceId": deviceId, "channelIndex": channelIndex, 'doorCommand': doorCommand };
        await this.callRestApi('device/control/sendDoorCommand', data);
    }

    async deviceControlResetEnergyCounter(deviceId, channelIndex = 1) {
        let data = { "deviceId": deviceId, "channelIndex": channelIndex };
        await this.callRestApi('device/control/resetEnergyCounter', data);
    }

    async deviceConfigurationSetOperationLock(deviceId, operationLock, channelIndex = 1) {
        let data = { "deviceId": deviceId, "channelIndex": channelIndex, 'operationLock': operationLock };
        await this.callRestApi('device/configuration/setOperationLock', data);
    }

    async deviceConfigurationSetClimateControlDisplay(deviceId, display, channelIndex = 1) {
        let data = { "deviceId": deviceId, "channelIndex": channelIndex, 'display': display };
        await this.callRestApi('device/configuration/setClimateControlDisplay', data);
    }

    async deviceConfigurationSetMinimumFloorHeatingValvePosition(deviceId, minimumFloorHeatingValvePosition, channelIndex = 1) {
        let data = { "deviceId": deviceId, "channelIndex": channelIndex, 'minimumFloorHeatingValvePosition': minimumFloorHeatingValvePosition };
        await this.callRestApi('device/configuration/setMinimumFloorHeatingValvePosition', data);
    }

    async deviceControlSetDimLevel(deviceId, dimLevel, channelIndex = 1) {
        let data = { "deviceId": deviceId, "channelIndex": channelIndex, 'dimLevel': dimLevel };
        await this.callRestApi('device/control/setDimLevel', data);
    }

    async deviceControlSetRgbDimLevel(deviceId, rgb, dimLevel, channelIndex = 1) {
        let data = { "deviceId": deviceId, "channelIndex": channelIndex, 'simpleRGBColorState': rgb, 'dimLevel': dimLevel };
        await this.callRestApi('device/control/setSimpleRGBColorDimLevel', data);
    }

    async deviceControlSetShutterLevel(deviceId, shutterLevel, channelIndex = 1) {
        let data = { "deviceId": deviceId, "channelIndex": channelIndex, 'shutterLevel': shutterLevel };
        await this.callRestApi('device/control/setShutterLevel', data);
    }

    async deviceControlSetSlatsLevel(deviceId, slatsLevel, shutterLevel, channelIndex = 1) {
        let data = { "deviceId": deviceId, "channelIndex": channelIndex, 'slatsLevel': slatsLevel, 'shutterLevel': shutterLevel };
        await this.callRestApi('device/control/setSlatsLevel', data);
    }

    async deviceControlStop(deviceId, channelIndex = 1) {
        let data = { "deviceId": deviceId, "channelIndex": channelIndex };
        await this.callRestApi('device/control/stop', data);
    }

    async deviceControlSetPrimaryShadingLevel(deviceId, primaryShadingLevel, channelIndex = 1) {
        let data = { "deviceId": deviceId, "channelIndex": channelIndex, 'primaryShadingLevel': primaryShadingLevel };
        await this.callRestApi('device/control/setPrimaryShadingLevel', data);
    }

    async deviceControlSetSecondaryShadingLevel(deviceId, primaryShadingLevel, secondaryShadingLevel, channelIndex = 1) {
        let data = { "deviceId": deviceId, "channelIndex": channelIndex, 'primaryShadingLevel': primaryShadingLevel, 'secondaryShadingLevel': secondaryShadingLevel };
        await this.callRestApi('device/control/setSecondaryShadingLevel', data);
    }

    async deviceConfigurationSetRouterModuleEnabled(deviceId, routerModuleEnabled, channelIndex = 1) {
        let data = { "deviceId": deviceId, "routerModuleEnabled": routerModuleEnabled, "channelIndex": channelIndex };
        await this.callRestApi('device/configuration/setRouterModuleEnabled', data);
    }

    async deviceDeleteDevice(deviceId) {
        let data = { "deviceId": deviceId };
        await this.callRestApi('device/deleteDevice', data);
    }

    async deviceSetDeviceLabel(deviceId, label) {
        let data = { "deviceId": deviceId, "label": label };
        await this.callRestApi('device/setDeviceLabel', data);
    }

    async deviceIsUpdateApplicable(deviceId) {
        let data = { "deviceId": deviceId };
        await this.callRestApi('device/isUpdateApplicable', data);
    }

    async deviceAuthorizeUpdate(deviceId) {
        let data = { "deviceId": deviceId };
        await this.callRestApi('device/authorizeUpdate', data);
    }

    // =========== API for HM Groups ===========

    async groupHeatingSetPointTemperature(groupId, setPointTemperature) {
        let data = { "groupId": groupId, "setPointTemperature": setPointTemperature };
        await this.callRestApi('group/heating/setSetPointTemperature', data);
    }

    async groupHeatingSetBoostDuration(groupId, boostDuration) {
        let data = { "groupId": groupId, "boostDuration": boostDuration };
        await this.callRestApi('group/heating/setBoostDuration', data);
    }

    async groupHeatingSetBoost(groupId, boost) {
        let data = { "groupId": groupId, "boost": boost };
        await this.callRestApi('group/heating/setBoost', data);
    }

    async groupHeatingSetControlMode(groupId, controlMode) {
        let data = { "groupId": groupId, "controlMode": controlMode };
        //AUTOMATIC,MANUAL
        await this.callRestApi('group/heating/setControlMode', data);
    }

    async groupHeatingSetActiveProfile(groupId, profileIndex) {
        let data = { "groupId": groupId, "profileIndex": profileIndex };
        await this.callRestApi('group/heating/setActiveProfile', data);
    }

    async groupSwitchingAlarmSetOnTime(groupId, onTime) {
        let data ={"groupId": groupId, "onTime": onTime};
        await this.callRestApi('group/switching/alarm/setOnTime', data);
    }

    async groupSwitchingAlarmTestSignalOptical(groupId, signalOptical) {
        let data = { "groupId": groupId, "signalOptical": signalOptical };
        await this.callRestApi('group/switching/alarm/testSignalOptical', data);
    }

    async groupSwitchingAlarmSetSignalOptical(groupId, signalOptical) {
        let data = { "groupId": groupId, "signalOptical": signalOptical };
        await this.callRestApi('group/switching/alarm/setSignalOptical', data);
    }

    async groupSwitchingAlarmTestSignalAcoustic(groupId, signalAcoustic) {
        let data = { "groupId": groupId, "signalAcoustic": signalAcoustic };
        await this.callRestApi('group/switching/alarm/testSignalAcoustic', data);
    }

    async groupSwitchingAlarmSetSignalAcoustic(groupId, signalAcoustic) {
        let data = { "groupId": groupId, "signalAcoustic": signalAcoustic };
        await this.callRestApi('group/switching/alarm/setSignalAcoustic', data);
    }

    // =========== API for HM Clients ===========

    async clientDeleteClient(clientId) {
        let data = { "clientId": clientId };
        await this.callRestApi('client/deleteClient', data);
    }

    // =========== API for HM Home ===========

    async homeHeatingActivateAbsenceWithPeriod(endTime) {
        let data = { "endTime": endTime };
        await this.callRestApi('home/heating/activateAbsenceWithPeriod', data);
    }

    async homeHeatingActivateAbsenceWithDuration(duration) {
        let data = { "duration": duration };
        await this.callRestApi('home/heating/activateAbsenceWithDuration', data);
    }

    async homeHeatingDeactivateAbsence() {
        await this.callRestApi('home/heating/deactivateAbsence');
    }

    async homeHeatingActivateVacation(temperature, endtime) {
        let data = { "temperature": temperature, "endtime": endtime };
        await this.callRestApi('home/heating/activateVacation', data);
    }

    async homeHeatingDeactivateVacation() {
        await this.callRestApi('home/heating/deactivateVacation');
    }

    async homeSetIntrusionAlertThroughSmokeDetectors(intrusionAlertThroughSmokeDetectors) {
        let data = { "intrusionAlertThroughSmokeDetectors": intrusionAlertThroughSmokeDetectors};
        await this.callRestApi('home/security/setIntrusionAlertThroughSmokeDetectors', data);
    }

    async homeSetZonesActivation(internal, external) {
        let data = { "zonesActivation": { "INTERNAL": internal, "EXTERNAL": external } };
        await this.callRestApi('home/security/setZonesActivation', data);
    }
};

module.exports = HmCloudAPI;
