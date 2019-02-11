/* jshint -W097 */// jshint strict:false
/*jslint node: true */
'use strict';

const utils = require('@iobroker/adapter-core'); // Get common adapter utils
const apiClass = require('./api/hm-cloud-api.js');
const delay = require('delay');

const adapterName = require('./package.json').name.split('.').pop();

class HmIpCloudAccesspointAdapter extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: adapterName });

        this._api = new apiClass();
        this._api.eventRaised = this._eventRaised.bind(this);
        this._api.opened = this._opened.bind(this);
        this._api.closed = this._closed.bind(this);

        this.on('unload', this._unload);
        this.on('objectChange', this._objectChange);
        this.on('stateChange', this._stateChange);
        this.on('message', this._message);
        this.on('ready', this._ready);

        this._unloaded = false;
        this._requestTokenState = { state: 'idle' };
    }

    _unload(callback) {
        this._unloaded = true;
        this._api.isClosed = true;
        try {
            this.log.info('cleaned everything up...');
            callback();
        } catch (e) {
            callback();
        }
    }

    _objectChange(id, obj) {
        this.log.info('objectChange ' + id + ' ' + JSON.stringify(obj));
    }

    async _message(msg) {
        this.log.debug('message recieved - ' + JSON.stringify(msg));
        switch (msg.command) {
            case 'requestToken':
                this._requestTokenState = { state: 'startedTokenCreation' };
                this.sendTo(msg.from, msg.command, this._requestTokenState, msg.callback);
                await this._startTokenRequest(msg);
                break;
            case 'requestTokenState':
                this.sendTo(msg.from, msg.command, this._requestTokenState, msg.callback);
                break;
        }
    }

    async _startTokenRequest(msg) {
        try {
            this.log.info('started token request');
            let config = msg.message;
            this._api.parseConfigData(config.accessPointSgtin, config.pin, config.clientId);
            await this._api.getHomematicHosts();
            this.log.info('auth step 1');
            await this._api.auth1connectionRequest(config.deviceName);
            this.log.info('auth step 2');
            while (!await this._api.auth2isRequestAcknowledged() && !this._unloaded) {
                this._requestTokenState = { state: 'waitForBlueButton' };
                await delay(2000);
            }
            if (!this._unloaded) {
                this._requestTokenState = { state: 'confirmToken' };
                this.log.info('auth step 3');
                await this._api.auth3requestAuthToken();
                let saveData = this._api.getSaveData();
                saveData.state = 'tokenCreated';
                this._requestTokenState = saveData;
            }
        }
        catch (err) {
            this._requestTokenState = { state: 'errorOccured' };
            this.log.error('error requesting token: ' + err);
        }
    }

    async _ready() {
        this.log.debug('ready');
        this.setState('info.connection', false, true);

        if (this.config.accessPointSgtin && this.config.authToken && this.config.clientAuthToken && this.config.clientId) {
            try {
                await this._startupHomematic();
            } catch (err) {
                this.log.error('error starting homematic: ' +  err);
            }
        } else {
            this.log.info('token not yet created');
        }
    }

    async _startupHomematic() {
        this._api.parseConfigData({
            authToken: this.config.authToken,
            clientAuthToken: this.config.clientAuthToken,
            clientId: this.config.clientId,
            accessPointSgtin: this.config.accessPointSgtin,
            pin: this.config.pin
        });
        await this._api.getHomematicHosts();
        await this._api.loadCurrentConfig();
        this.log.debug('createObjectsForDevices');
        await this._createObjectsForDevices();
        this.log.debug('createObjectsForGroups');
        await this._createObjectsForGroups();
        this.log.debug('createObjectsForClients');
        await this._createObjectsForClients();
        this.log.debug('createObjectsForHomes');
        await this._createObjectsForHomes();
        this.log.debug('connectWebsocket');
        this._api.connectWebsocket();
        this.log.debug('updateDeviceStates');
        for (let d in this._api.devices) {
            await this._updateDeviceStates(this._api.devices[d]);
        }
        for (let g in this._api.groups) {
            await this._updateGroupStates(this._api.groups[g]);
        }
        for (let c in this._api.clients) {
            await this._updateClientStates(this._api.clients[c]);
        }
        await this._updateHomeStates(this._api.home);

        this.log.debug('subscribeStates');
        this.subscribeStates('*');

        this.setState('info.connection', true, true);
        this.log.info('hmip adapter connected and ready');
    }

    async _stateChange(id, state) {
        if (!id || !state || state.ack) return;

        let o = await this.getObjectAsync(id);
        if (o.native.parameter) {
            this.log.info('state change - ' + o.native.parameter + ' - id ' + (o.native.id ? o.native.id : '') + ' - value ' + state.val);
            switch (o.native.parameter) {
                case 'switchState':
                    this._api.deviceControlSetSwitchState(o.native.id, state.val, o.native.channel);
                    break;
                case 'resetEnergyCounter':
                    this._api.deviceControlResetEnergyCounter(o.native.id, o.native.channel);
                    break;
                case 'shutterlevel':
                    this._api.deviceControlSetShutterLevel(o.native.id, state.val, o.native.channel);
                    break;
                case 'slatsLevel':
                    let slats = await this.getStateAsync('devices.' + o.native.id + '.channels.' + o.native.channel + '.slatsLevel');
                    let shutter = await this.getStateAsync('devices.' + o.native.id + '.channels.' + o.native.channel + '.shutterLevel');
                    this._api.deviceControlSetSlatsLevel(o.native.id, slats.val, shutter.val, o.native.channel);
                    break;
                case 'stop':
                    this._api.deviceControlStop(o.native.id, o.native.channel);
                    break;
                case 'setPointTemperature':
                    for (let id of o.native.id)
                        this._api.groupHeatingSetPointTemperature(id, state.val);
                    break;
                case 'setBoost':
                    for (let id of o.native.id)
                        this._api.groupHeatingSetBoost(id, state.val);
                    break;
                case 'setDimLevel':
                    this._api.deviceControlSetDimLevel(o.native.id, state.val, o.native.channel);
                    break;
                case 'changeOverDelay':
                    //this._api.deviceConfigurationChangeOverDelay(o.native.id, state.val, o.native.channel)
                    break;
                case 'setAbsenceEndTime':
                    this._api.homeHeatingActivateAbsenceWithPeriod(state.val);
                    break;
                case 'setAbsenceDuration':
                    this._api.homeHeatingActivateAbsenceWithDuration(state.val);
                    break;
                case 'deactivateAbsence':
                    this._api.homeHeatingDeactivateAbsence();
                    break;
                case 'setIntrusionAlertThroughSmokeDetectors':
                    this._api.homeSetIntrusionAlertThroughSmokeDetectors(state.val);
                    break;
                case 'activateVacation':
                    let vacTemp = await this.getState('homes.' + o.native.id + '.functionalHomes.indoorClimate.vacationTemperature').val;
                    this._api.homeHeatingActivateVacation(vacTemp, state.val);
                    break;
                case 'deactivateVacation':
                    this._api.homeHeatingDeactivateVacation();
                    break;
                case 'setSecurityZonesActivationNone':
                    this._api.homeSetZonesActivation(false, false);
                    break;
                case 'setSecurityZonesActivationInternal':
                    this._api.homeSetZonesActivation(true, false);
                    break;
                case 'setSecurityZonesActivationExternal':
                    this._api.homeSetZonesActivation(false, true);
                    break;
                case 'setSecurityZonesActivationInternalAndExternal':
                    this._api.homeSetZonesActivation(true, true);
                    break;
                case 'setOnTime':
                    for (let id of o.native.id)
                        this._api.groupSwitchingAlarmSetOnTime(id, state.val);
                    break;
                case 'testSignalOptical':
                    for (let id of o.native.id)
                        this._api.groupSwitchingAlarmTestSignalOptical(id, state.val);
                    break;
                case 'setSignalOptical':
                    for (let id of o.native.id)
                        this._api.groupSwitchingAlarmSetSignalOptical(id, state.val);
                    break;
                case 'testSignalAcoustic':
                    for (let id of o.native.id)
                        this._api.groupSwitchingAlarmTestSignalAcoustic(id, state.val);
                    break;
                case 'setSignalAcoustic':
                    for (let id of o.native.id)
                        this._api.groupSwitchingAlarmSetSignalAcoustic(id, state.val);
                    break;
            }
        }
    }

    _dataReceived(data) {
        this.log.silly("data received - " + data);
    }

    _opened() {
        this.log.info("ws connection opened");
    }

    _closed(code, reason) { 
        this.log.warn("ws connection closed - code: " + code + " - reason: " + reason);
    }

    async _eventRaised(ev) {
        switch (ev.pushEventType) {
            case 'DEVICE_ADDED':
                await this._createObjectsForDevice(ev.device);
                await this._updateDeviceStates(ev.device);
                break;
            case 'DEVICE_CHANGED':
                await this._updateDeviceStates(ev.device);
                break;
            case 'GROUP_ADDED':
                await this._createObjectsForGroup(ev.group);
                await this._updateGroupStates(ev.group);
                break;
            case 'GROUP_CHANGED':
                await this._updateGroupStates(ev.group);
                break;
            case 'CLIENT_ADDED':
                await this._createObjectsForClient(ev.client);
                await this._updateClientStates(ev.client);
                break;
            case 'CLIENT_CHANGED':
                await this._updateClientStates(ev.client);
                break;
            case 'DEVICE_REMOVED':
                break;
            case 'GROUP_REMOVED':
                break;
            case 'CLIENT_REMOVED':
                break;
            case 'HOME_CHANGED':
                await this._updateHomeStates(ev.home);
                break;
            default:
                this.log.warn("unhandled event - " + JSON.stringify(ev));
        }
    }

    _updateDeviceStates(device) {
        this.log.silly("updateDeviceStates - " + device.type + " - " + JSON.stringify(device));
        let promises = [];
        promises.push(this.setStateAsync('devices.' + device.id + '.info.type', device.type, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.info.modelType', device.modelType, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.info.label', device.label, true));
        switch (device.type) {
            /*case 'PLUGABLE_SWITCH': {
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.on', device.functionalChannels['1'].on, true));
                break;
            }*/
            default: {
                break;
            }
        }

        for (let i in device.functionalChannels) {
            let fc = device.functionalChannels[i];
            promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + i + '.functionalChannelType', fc.functionalChannelType, true));

            switch (fc.functionalChannelType) {

                case 'DEVICE_OPERATIONLOCK':
                    promises.push(...this._updateDeviceOperationLockChannelStates(device, i));
                    break;
                case 'DEVICE_SABOTAGE':
                    promises.push(...this._updateDeviceSabotageChannelStates(device, i));
                    break;
                case 'HEATING_THERMOSTAT_CHANNEL':
                    promises.push(...this._updateHeatingThermostatChannelStates(device, i));
                    break;
                case 'SHUTTER_CONTACT_CHANNEL':
                    promises.push(...this._updateShutterContactChannelStates(device, i));
                    break;
                case 'SMOKE_DETECTOR':
                    promises.push(...this._updateSmokeDetectorChannelStates(device, i));
                    break;
                case 'DIMMER_CHANNEL':
                    promises.push(...this._updateDimmerChannelStates(device, i));
                    break;
                case 'WATER_SENSOR_CHANNEL':
                    promises.push(...this._updateWaterSensorChannelStates(device, i));
                    break;
                case 'WEATHER_SENSOR_CHANNEL':
                    promises.push(...this._updateWeatherSensorChannelStates(device, i));
                    break;
                case 'WEATHER_SENSOR_PLUS_CHANNEL':
                    promises.push(...this._updateWeatherSensorPlusChannelStates(device, i));
                    break;
                case 'WEATHER_SENSOR_PRO_CHANNEL':
                    promises.push(...this._updateWeatherSensorProChannelStates(device, i));
                    break;
                case 'SHUTTER_CHANNEL':
                    promises.push(...this._updateShutterChannelStates(device, i));
                    break;
                case 'MOTION_DETECTION_CHANNEL':
                    promises.push(...this._updateMotionDetectionChannelStates(device, i));
                    break;
                case 'ALARM_SIREN_CHANNEL':
                    promises.push(...this._updateAlarmSirenChannelStates(device, i));
                    break;
                case 'DEVICE_PERMANENT_FULL_RX':
                    promises.push(...this._updateDevicePermanentFullRxChannelStates(device, i));
                    break;
                case 'SINGLE_KEY_CHANNEL':
                    promises.push(...this._updateSingleKeyChannelStates(device, i));
                    break;
                case 'DEVICE_BASE':
                    promises.push(...this._updateDeviceBaseChannelStates(device, i));
                    break;
                case 'WALL_MOUNTED_THERMOSTAT_WITHOUT_DISPLAY_CHANNEL':
                    promises.push(...this._updateWallMountedThermostatWithoutDisplayStates(device, i));
                    break; 
                case 'WALL_MOUNTED_THERMOSTAT_PRO_CHANNEL':
                    promises.push(...this._updateWallMountedThermostatProChannelStates(device, i));
                    break;
                case 'CLIMATE_SENSOR_CHANNEL':
                    promises.push(...this._updateClimateSensorChannelStates(device, i));
                    break;
                case 'SWITCH_MEASURING_CHANNEL':
                    promises.push(...this._updateSwitchMeasuringChannelStates(device, i));
                    break;
                case 'SWITCH_CHANNEL':
                    promises.push(...this._updateSwitchChannelStates(device, i));
                    break;
                case 'BLIND_CHANNEL':
                    promises.push(...this._updateBlindChannelStates(device, i));
                    break;
                case 'ROTARY_HANDLE_CHANNEL':
                    promises.push(...this._updateRotaryHandleChannelStates(device, i));
                    break;
                case 'MULTI_MODE_INPUT_CHANNEL':
                    promises.push(...this._updateMultiModeInputChannelStates(device, i));
                    break;
                case 'SMOKE_DETECTOR_CHANNEL':
                    promises.push(...this._updateSmokeDetectorChannelStates(device, i));
                    break;
                case 'INTERNAL_SWITCH_CHANNEL':
                    promises.push(...this._updateInternalSwitchChannelStates(device, i));
                    break;
                default:
                    this.log.info("unkown channel type - " + fc.functionalChannelType + " - " + JSON.stringify(device));
                    break;
            }
        }
        return Promise.all(promises);
    }

    /* Start Channel Types */

    _updateInternalSwitchChannelStates(device, channel) {
        let promises = [];
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.frostProtectionTemperature', device.functionalChannels[channel].frostProtectionTemperature, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.heatingValveType', device.functionalChannels[channel].heatingValveType, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.internalSwitchOutputEnabled', device.functionalChannels[channel].internalSwitchOutputEnabled, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.valveProtectionDuration', device.functionalChannels[channel].valveProtectionDuration, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.valveProtectionSwitchingInterval', device.functionalChannels[channel].valveProtectionSwitchingInterval, true));

        return promises;
    }

    _updateSmokeDetectorChannelStates(device, channel) {
        let promises = [];
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.smokeDetectorAlarmType', device.functionalChannels[channel].smokeDetectorAlarmType, true));
        return promises;
    }

    _updateMultiModeInputChannelStates(device, channel) {
        let promises = [];
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.binaryBehaviorType', device.functionalChannels[channel].binaryBehaviorType, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.multiModeInputMode', device.functionalChannels[channel].multiModeInputMode, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.windowState', device.functionalChannels[channel].windowState, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.windowOpen', device.functionalChannels[channel].windowState == 'OPEN', true));
        return promises;
    }

    _updateDeviceBaseChannelStates(device, channel) {
        let promises = [];
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.configPending', device.functionalChannels[channel].configPending, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.dutyCycle', device.functionalChannels[channel].dutyCycle, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.lowBat', device.functionalChannels[channel].lowBat, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.routerModuleEnabled', device.functionalChannels[channel].routerModuleEnabled, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.routerModuleSupported', device.functionalChannels[channel].routerModuleSupported, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.rssiDeviceValue', device.functionalChannels[channel].rssiDeviceValue, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.rssiPeerValue', device.functionalChannels[channel].rssiPeerValue, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.unreach', device.functionalChannels[channel].unreach, true));
        return promises;
    }

    _updateDeviceSabotageChannelStates(device, channel) {
        let promises = [];
        promises.push(...this._updateDeviceBaseChannelStates(device, channel));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.sabotage', device.functionalChannels[channel].sabotage, true));
        return promises;
    }

    _updateDeviceOperationLockChannelStates(device, channel) {
        let promises = [];
        promises.push(...this._updateDeviceBaseChannelStates(device, channel));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.operationLockActive', device.functionalChannels[channel].operationLockActive, true));
        return promises;
    }

    _updateDevicePermanentFullRxChannelStates(device, channel) {
        let promises = [];
        promises.push(...this._updateDeviceBaseChannelStates(device, channel));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.permanentFullRx', device.functionalChannels[channel].permanentFullRx, true));
        return promises;
    }

    _updateRotaryHandleChannelStates(device, channel) {
        let promises = [];
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.windowState', device.functionalChannels[channel].windowState, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.windowOpen', device.functionalChannels[channel].windowState == 'OPEN', true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.eventDelay', device.functionalChannels[channel].eventDelay, true));
        return promises;
    }

    _updateBlindChannelStates(device, channel) {
        let promises = [];
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.shutterLevel', device.functionalChannels[channel].shutterLevel, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.previousShutterLevel', device.functionalChannels[channel].previousShutterLevel, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.processing', device.functionalChannels[channel].processing, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.selfCalibrationInProgress', device.functionalChannels[channel].selfCalibrationInProgress, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.topToBottomReferenceTime', device.functionalChannels[channel].topToBottomReferenceTime, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.bottomToTopReferenceTime', device.functionalChannels[channel].bottomToTopReferenceTime, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.changeOverDelay', device.functionalChannels[channel].changeOverDelay, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.supportingSelfCalibration', device.functionalChannels[channel].supportingSelfCalibration, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.endpositionAutoDetectionEnabled', device.functionalChannels[channel].endpositionAutoDetectionEnabled, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.supportingEndpositionAutoDetection', device.functionalChannels[channel].supportingEndpositionAutoDetection, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.delayCompensationValue', device.functionalChannels[channel].delayCompensationValue, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.supportingDelayCompensation', device.functionalChannels[channel].supportingDelayCompensation, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.profileMode', device.functionalChannels[channel].profileMode, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.userDesiredProfileMode', device.functionalChannels[channel].userDesiredProfileMode, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.slatsLevel', device.functionalChannels[channel].slatsLevel, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.previousSlatsLevel', device.functionalChannels[channel].previousSlatsLevel, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.slatsReferenceTime', device.functionalChannels[channel].slatsReferenceTime, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.blindModeActive', device.functionalChannels[channel].blindModeActive, true));
        return promises;
    }

    _updateSwitchChannelStates(device, channel) {
        let promises = [];
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.on', device.functionalChannels[channel].on, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.profileMode', device.functionalChannels[channel].profileMode, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.userDesiredProfileMode', device.functionalChannels[channel].userDesiredProfileMode, true));
        return promises;
    }

    _updateSwitchMeasuringChannelStates(device, channel) {
        let promises = [];
        promises.push(...this._updateSwitchChannelStates(device, channel));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.energyCounter', device.functionalChannels[channel].energyCounter, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.currentPowerConsumption', device.functionalChannels[channel].currentPowerConsumption, true));
        return promises;
    }

    _updateShutterContactChannelStates(device, channel) {
        let promises = [];
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.windowState', device.functionalChannels[channel].windowState, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.windowOpen', device.functionalChannels[channel].windowState == 'OPEN', true));
        return promises;
    }

    _updateDimmerChannelStates(device, channel) {
        let promises = [];
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.dimLevel', device.functionalChannels[channel].dimLevel, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.on', device.functionalChannels[channel].on, true));
        return promises;
    }

    _updateWaterSensorChannelStates(device, channel) {
        let promises = [];
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.moistureDetected', device.functionalChannels[channel].moistureDetected, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.waterlevelDetected', device.functionalChannels[channel].waterlevelDetected, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.sirenWaterAlarmTrigger', device.functionalChannels[channel].sirenWaterAlarmTrigger, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.inAppWaterAlarmTrigger', device.functionalChannels[channel].inAppWaterAlarmTrigger, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.acousticAlarmSignal', device.functionalChannels[channel].acousticAlarmSignal, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.acousticAlarmTiming', device.functionalChannels[channel].acousticAlarmTiming, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.acousticWaterAlarmTrigger', device.functionalChannels[channel].acousticWaterAlarmTrigger, true));
        return promises;
    }

    _updateWeatherSensorChannelStates(device, channel) {
        let promises = [];
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.actualTemperature', device.functionalChannels[channel].actualTemperature, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.humidity', device.functionalChannels[channel].humidity, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.illumination', device.functionalChannels[channel].illumination, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.illuminationThresholdSunshine', device.functionalChannels[channel].illuminationThresholdSunshine, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.storm', device.functionalChannels[channel].storm, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.sunshine', device.functionalChannels[channel].sunshine, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.todaySunshineDuration', device.functionalChannels[channel].todaySunshineDuration, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.totalSunshineDuration', device.functionalChannels[channel].totalSunshineDuration, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.windSpeed', device.functionalChannels[channel].windSpeed, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.windValueType', device.functionalChannels[channel].windValueType, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.yesterdaySunshineDuration', device.functionalChannels[channel].yesterdaySunshineDuration, true));
        return promises;
    }

    _updateWeatherSensorPlusChannelStates(device, channel) {
        let promises = [];
        promises.push(...this._updateWeatherSensorChannelStates(device, channel));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.raining', device.functionalChannels[channel].raining, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.todayRainCounter', device.functionalChannels[channel].todayRainCounter, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.totalRainCounter', device.functionalChannels[channel].totalRainCounter, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.yesterdayRainCounter', device.functionalChannels[channel].yesterdayRainCounter, true));
        return promises;
    }

    _updateWeatherSensorProChannelStates(device, channel) {
        let promises = [];
        promises.push(...this._updateWeatherSensorPlusChannelStates(device, channel));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.weathervaneAlignmentNeeded', device.functionalChannels[channel].weathervaneAlignmentNeeded, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.windDirection', device.functionalChannels[channel].windDirection, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.windDirectionVariation', device.functionalChannels[channel].windDirectionVariation, true));
        return promises;
    }

    _updateSingleKeyChannelStates(device, channel) {
        let promises = [];
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.on', device.functionalChannels[channel].on, true));
        return promises;
    }

    _updateShutterChannelStates(device, channel) {
        let promises = [];
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.shutterLevel', device.functionalChannels[channel].shutterLevel, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.previousShutterLevel', device.functionalChannels[channel].previousShutterLevel, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.processing', device.functionalChannels[channel].processing, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.selfCalibrationInProgress', device.functionalChannels[channel].selfCalibrationInProgress, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.topToBottomReferenceTime', device.functionalChannels[channel].topToBottomReferenceTime, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.bottomToTopReferenceTime', device.functionalChannels[channel].bottomToTopReferenceTime, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.changeOverDelay', device.functionalChannels[channel].changeOverDelay, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.endpositionAutoDetectionEnabled', device.functionalChannels[channel].endpositionAutoDetectionEnabled, true));
        return promises;
    }

    _updateSmokeDetectorChannelStates(device, channel) {
        let promises = [];
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.smokeDetectorAlarmType', device.functionalChannels[channel].smokeDetectorAlarmType, true));
        return promises;
    }

    _updateHeatingThermostatChannelStates(device, channel) {
        let promises = [];
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.temperatureOffset', device.functionalChannels[channel].temperatureOffset, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.valvePosition', device.functionalChannels[channel].valvePosition, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.setPointTemperature', device.functionalChannels[channel].setPointTemperature, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.valveState', device.functionalChannels[channel].valveState, true));
        return promises;
    }

    _updateClimateSensorChannelStates(device, channel) {
        let promises = [];
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.actualTemperature', device.functionalChannels[channel].actualTemperature, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.humidity', device.functionalChannels[channel].humidity, true));
        return promises;
    }

    _updateWallMountedThermostatWithoutDisplayStates(device, channel) {
        let promises = [];
        promises.push(...this._updateClimateSensorChannelStates(device, channel));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.temperatureOffset', device.functionalChannels[channel].temperatureOffset, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.setPointTemperature', device.functionalChannels[channel].setPointTemperature, true));
        return promises;
    }

    _updateWallMountedThermostatProChannelStates(device, channel) {
        let promises = [];
        promises.push(...this._updateWallMountedThermostatWithoutDisplayStates(device, channel));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.display', device.functionalChannels[channel].display, true));
        return promises;
    }

    _updateAlarmSirenChannelStates(device, channel) {
        let promises = [];
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.on', device.functionalChannels[channel].on, true));
        return promises;
    }

    _updateMotionDetectionChannelStates(device, channel) {
        let promises = [];
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.motionDetected', device.functionalChannels[channel].motionDetected, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.illumination', device.functionalChannels[channel].illumination, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.currentIllumination', device.functionalChannels[channel].currentIllumination, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.motionDetectionSendInterval', device.functionalChannels[channel].motionDetectionSendInterval, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + channel + '.motionBufferActive', device.functionalChannels[channel].motionBufferActive, true));
        return promises;
    }

    /* End Channel Types */

    _updateGroupStates(group) {
        this.log.silly("_updateGroupStates - " + JSON.stringify(group));
        let promises = [];
        promises.push(this.setStateAsync('groups.' + group.id + '.info.type', group.type, true));
        promises.push(this.setStateAsync('groups.' + group.id + '.info.label', group.label, true));

        switch (group.type) {
            case 'HEATING': {
                promises.push(this.setStateAsync('groups.' + group.id + '.windowOpenTemperature', group.windowOpenTemperature, true));
                promises.push(this.setStateAsync('groups.' + group.id + '.setPointTemperature', group.setPointTemperature, true));
                promises.push(this.setStateAsync('groups.' + group.id + '.minTemperature', group.minTemperature, true));
                promises.push(this.setStateAsync('groups.' + group.id + '.maxTemperature', group.maxTemperature, true));
                promises.push(this.setStateAsync('groups.' + group.id + '.windowState', group.windowState, true));
                promises.push(this.setStateAsync('groups.' + group.id + '.cooling', group.cooling, true));
                promises.push(this.setStateAsync('groups.' + group.id + '.partyMode', group.partyMode, true));
                promises.push(this.setStateAsync('groups.' + group.id + '.controlMode', group.controlMode, true));
                promises.push(this.setStateAsync('groups.' + group.id + '.boostMode', group.boostMode, true));
                promises.push(this.setStateAsync('groups.' + group.id + '.boostDuration', group.boostDuration, true));
                promises.push(this.setStateAsync('groups.' + group.id + '.actualTemperature', group.actualTemperature, true));
                promises.push(this.setStateAsync('groups.' + group.id + '.humidity', group.humidity, true));
                promises.push(this.setStateAsync('groups.' + group.id + '.coolingAllowed', group.coolingAllowed, true));
                promises.push(this.setStateAsync('groups.' + group.id + '.coolingIgnored', group.coolingIgnored, true));
                promises.push(this.setStateAsync('groups.' + group.id + '.ecoAllowed', group.ecoAllowed, true));
                promises.push(this.setStateAsync('groups.' + group.id + '.ecoIgnored', group.ecoIgnored, true));
                promises.push(this.setStateAsync('groups.' + group.id + '.controllable', group.controllable, true));
                promises.push(this.setStateAsync('groups.' + group.id + '.floorHeatingMode', group.floorHeatingMode, true));
                promises.push(this.setStateAsync('groups.' + group.id + '.humidityLimitEnabled', group.humidityLimitEnabled, true));
                promises.push(this.setStateAsync('groups.' + group.id + '.humidityLimitValue', group.humidityLimitValue, true));
                promises.push(this.setStateAsync('groups.' + group.id + '.externalClockEnabled', group.externalClockEnabled, true));
                promises.push(this.setStateAsync('groups.' + group.id + '.externalClockHeatingTemperature', group.externalClockHeatingTemperature, true));
                promises.push(this.setStateAsync('groups.' + group.id + '.externalClockCoolingTemperature', group.externalClockCoolingTemperature, true));
                promises.push(this.setStateAsync('groups.' + group.id + '.valvePosition', group.valvePosition, true));
                promises.push(this.setStateAsync('groups.' + group.id + '.sabotage', group.sabotage, true));             
                break;
            }
            case 'SWITCHING': {
                promises.push(this.setStateAsync('groups.' + group.id + '.on', group.on, true));
                break;
            }
        }

        return Promise.all(promises);
    }

    _updateClientStates(client) {
        this.log.silly("_updateClientStates - " + JSON.stringify(client));
        let promises = [];
        promises.push(this.setStateAsync('clients.' + client.id + '.info.label', client.label, true));
        return Promise.all(promises);
    }

    _updateHomeStates(home) {
        this.log.silly("_updateHomeStates - " + JSON.stringify(home));
        let promises = [];

        promises.push(this.setStateAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.alarmEventTimestamp', home.functionalHomes.SECURITY_AND_ALARM.alarmEventTimestamp, true));
        promises.push(this.setStateAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.alarmEventDeviceId', home.functionalHomes.SECURITY_AND_ALARM.alarmEventDeviceId, true));
        promises.push(this.setStateAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.alarmEventTriggerId', home.functionalHomes.SECURITY_AND_ALARM.alarmEventTriggerId, true));
        promises.push(this.setStateAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.alarmEventDeviceChannel', home.functionalHomes.SECURITY_AND_ALARM.alarmEventDeviceChannel, true));
        promises.push(this.setStateAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.alarmSecurityJournalEntryType', home.functionalHomes.SECURITY_AND_ALARM.alarmSecurityJournalEntryType, true));
        promises.push(this.setStateAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.alarmActive', home.functionalHomes.SECURITY_AND_ALARM.alarmActive, true));
        promises.push(this.setStateAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.zoneActivationDelay', home.functionalHomes.SECURITY_AND_ALARM.zoneActivationDelay, true));
        promises.push(this.setStateAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.intrusionAlertThroughSmokeDetectors', home.functionalHomes.SECURITY_AND_ALARM.intrusionAlertThroughSmokeDetectors, true));
        promises.push(this.setStateAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.securityZoneActivationMode', home.functionalHomes.SECURITY_AND_ALARM.securityZoneActivationMode, true));
        promises.push(this.setStateAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.solution', home.functionalHomes.SECURITY_AND_ALARM.solution, true));
        promises.push(this.setStateAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.activationInProgress', home.functionalHomes.SECURITY_AND_ALARM.activationInProgress, true));
        promises.push(this.setStateAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.active', home.functionalHomes.SECURITY_AND_ALARM.active, true));
        promises.push(this.setStateAsync('homes.' + home.id + '.functionalHomes.indoorClimate.absenceType', home.functionalHomes.INDOOR_CLIMATE.absenceType, true));
        promises.push(this.setStateAsync('homes.' + home.id + '.functionalHomes.indoorClimate.absenceEndTime', home.functionalHomes.INDOOR_CLIMATE.absenceEndTime, true));
        promises.push(this.setStateAsync('homes.' + home.id + '.functionalHomes.indoorClimate.ecoTemperature', home.functionalHomes.INDOOR_CLIMATE.ecoTemperature, true));
        promises.push(this.setStateAsync('homes.' + home.id + '.functionalHomes.indoorClimate.coolingEnabled', home.functionalHomes.INDOOR_CLIMATE.coolingEnabled, true));
        promises.push(this.setStateAsync('homes.' + home.id + '.functionalHomes.indoorClimate.ecoDuration', home.functionalHomes.INDOOR_CLIMATE.ecoDuration, true));
        promises.push(this.setStateAsync('homes.' + home.id + '.functionalHomes.indoorClimate.optimumStartStopEnabled', home.functionalHomes.INDOOR_CLIMATE.optimumStartStopEnabled, true));
        promises.push(this.setStateAsync('homes.' + home.id + '.functionalHomes.indoorClimate.solution', home.functionalHomes.INDOOR_CLIMATE.solution, true));
        promises.push(this.setStateAsync('homes.' + home.id + '.functionalHomes.indoorClimate.active', home.functionalHomes.INDOOR_CLIMATE.active, true));
        promises.push(this.setStateAsync('homes.' + home.id + '.functionalHomes.lightAndShadow.active', home.functionalHomes.LIGHT_AND_SHADOW.active, true));
        promises.push(this.setStateAsync('homes.' + home.id + '.functionalHomes.weatherAndEnvironment.active', home.functionalHomes.WEATHER_AND_ENVIRONMENT.active, true));

        return Promise.all(promises);
    }

    async _createObjectsForDevices() {
        for (let i in this._api.devices) {
            await this._createObjectsForDevice(this._api.devices[i]);
        }
    }

    async _createObjectsForGroups() {
        for (let i in this._api.groups) {
            await this._createObjectsForGroup(this._api.groups[i]);
        }
    }

    async _createObjectsForClients() {
        for (let i in this._api.clients) {
            await this._createObjectsForClient(this._api.clients[i]);
        }
    }

    async _createObjectsForHomes() {
        await this._createObjectsForHome(this._api.home);
    }


    _createObjectsForDevice(device) {
        this.log.silly("createObjectsForDevice - " + device.type + " - " + JSON.stringify(device));
        let promises = [];
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id, { type: 'device', common: { name: device.label }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.info.type', { type: 'state', common: { name: 'type', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.info.modelType', { type: 'state', common: { name: 'type', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.info.label', { type: 'state', common: { name: 'type', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        switch (device.type) {
            /*case 'PLUGABLE_SWITCH': {
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1', { type: 'channel', common: {}, native: {} }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.on', { type: 'state', common: { name: 'on', type: 'boolean', role: 'switch', read: true, write: true }, native: { id: device.id, channel: 1, parameter: 'switchState' } }));
                break;
            }*/
            default:
                break;
        }
        for (let i in device.functionalChannels) {
            let fc = device.functionalChannels[i];
            promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + i, { type: 'channel', common: {}, native: {} }));
            promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + i + '.functionalChannelType', { type: 'state', common: { name: 'functionalChannelType', type: 'string', role: 'info', read: true, write: false }, native: {} }));
            switch (fc.functionalChannelType) {

                case 'DEVICE_OPERATIONLOCK':
                    promises.push(...this._createDeviceOperationLockChannel(device, i));
                    break;
                case 'DEVICE_SABOTAGE':
                    promises.push(...this._createDeviceSabotageChannel(device, i));
                    break;
                case 'HEATING_THERMOSTAT_CHANNEL':
                    promises.push(...this._createHeatingThermostatChannel(device, i));
                    break;
                case 'SHUTTER_CONTACT_CHANNEL':
                    promises.push(...this._createShutterContactChannel(device, i));
                    break;
                case 'SMOKE_DETECTOR':
                    promises.push(...this._createSmokeDetectorChannel(device, i));
                    break;
                case 'DIMMER_CHANNEL':
                    promises.push(...this._createDimmerChannel(device, i));
                    break;
                case 'WATER_SENSOR_CHANNEL':
                    promises.push(...this._createWaterSensorChannel(device, i));
                    break;
                case 'WEATHER_SENSOR_CHANNEL':
                    promises.push(...this._createWeatherSensorChannel(device, i));
                    break;
                case 'WEATHER_SENSOR_PLUS_CHANNEL':
                    promises.push(...this._createWeatherSensorPlusChannel(device, i));
                    break;
                case 'WEATHER_SENSOR_PRO_CHANNEL':
                    promises.push(...this._createWeatherSensorProChannel(device, i));
                    break;
                case 'SHUTTER_CHANNEL':
                    promises.push(...this._createShutterChannel(device, i));
                    break;
                case 'MOTION_DETECTION_CHANNEL':
                    promises.push(...this._createMotionDetectionChannel(device, i));
                    break;
                case 'ALARM_SIREN_CHANNEL':
                    promises.push(...this._createAlarmSirenChannel(device, i));
                    break;
                case 'DEVICE_PERMANENT_FULL_RX':
                    promises.push(...this._createDevicePermanentFullRxChannel(device, i));
                    break;
                case 'SINGLE_KEY_CHANNEL':
                    promises.push(...this._createSingleKeyChannel(device, i));
                    break;
                case 'DEVICE_BASE':
                    promises.push(...this._createDeviceBaseChannel(device, i));
                    break;
                case 'WALL_MOUNTED_THERMOSTAT_WITHOUT_DISPLAY_CHANNEL':
                    promises.push(...this._createWallMountedThermostatWithoutDisplay(device, i));
                    break;        
                case 'WALL_MOUNTED_THERMOSTAT_PRO_CHANNEL':
                    promises.push(...this._createWallMountedThermostatProChannel(device, i));
                    break;
                case 'CLIMATE_SENSOR_CHANNEL':
                    promises.push(...this._createClimateSensorChannel(device, i));
                    break;
                case 'SWITCH_MEASURING_CHANNEL':
                    promises.push(...this._createSwitchMeasuringChannel(device, i));
                    break;
                case 'SWITCH_CHANNEL':
                    promises.push(...this._createSwitchChannel(device, i));
                    break;
                case 'BLIND_CHANNEL':
                    promises.push(...this._createBlindChannel(device, i));
                    break;
                case 'ROTARY_HANDLE_CHANNEL':
                    promises.push(...this._createRotaryHandleChannel(device, i));
                    break;
                case 'MULTI_MODE_INPUT_CHANNEL':
                    promises.push(...this._createMultiModeInputChannel(device, i));
                    break;
                case 'SMOKE_DETECTOR_CHANNEL':
                    promises.push(...this._createSmokeDetectorChannel(device, i));
                    break;
                case 'INTERNAL_SWITCH_CHANNEL':
                    promises.push(...this._createInternalSwitchChannel(device, i));
                    break;

                default:
                    this.log.info("unkown channel type - " + fc.functionalChannelType + " - " + JSON.stringify(device));
                    break;

            }
        }
        return Promise.all(promises);;
    }

    /* Start Channel Types */

    _createInternalSwitchChannel(device, channel) {
        let promises = [];
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.frostProtectionTemperature', { type: 'state', common: { name: 'frostProtectionTemperature', type: 'number', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.heatingValveType', { type: 'state', common: { name: 'heatingValveType', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.internalSwitchOutputEnabled', { type: 'state', common: { name: 'internalSwitchOutputEnabled', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.valveProtectionDuration', { type: 'state', common: { name: 'valveProtectionDuration', type: 'number', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.valveProtectionSwitchingInterval', { type: 'state', common: { name: 'valveProtectionSwitchingInterval', type: 'number', role: 'info', read: true, write: false }, native: {} }));
        return promises;
    }

    _createSmokeDetectorChannel(device, channel) {
        let promises = [];
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.smokeDetectorAlarmType', { type: 'state', common: { name: 'smokeDetectorAlarmType', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        return promises;
    }

    _createMultiModeInputChannel(device, channel) {
        let promises = [];
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.binaryBehaviorType', { type: 'state', common: { name: 'binaryBehaviorType', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.multiModeInputMode', { type: 'state', common: { name: 'multiModeInputMode', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.windowState', { type: 'state', common: { name: 'windowState', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.windowOpen', { type: 'state', common: { name: 'windowOpen', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
        return promises;
    }

    _createDeviceBaseChannel(device, channel) {
        let promises = [];
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.configPending', { type: 'state', common: { name: 'configPending', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.dutyCycle', { type: 'state', common: { name: 'dutyCycle', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.lowBat', { type: 'state', common: { name: 'lowBat', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.routerModuleEnabled', { type: 'state', common: { name: 'routerModuleEnabled', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.routerModuleSupported', { type: 'state', common: { name: 'routerModuleSupported', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.rssiDeviceValue', { type: 'state', common: { name: 'rssiDeviceValue', type: 'number', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.rssiPeerValue', { type: 'state', common: { name: 'rssiPeerValue', type: 'number', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.unreach', { type: 'state', common: { name: 'unreach', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
        return promises;
    }

    _createDeviceSabotageChannel(device, channel) {
        let promises = [];
        promises.push(...this._createDeviceBaseChannel(device, channel));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.sabotage', { type: 'state', common: { name: 'sabotage', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
        return promises;
    }

    _createDeviceOperationLockChannel(device, channel) {
        let promises = [];
        promises.push(...this._createDeviceBaseChannel(device, channel));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.operationLockActive', { type: 'state', common: { name: 'operationLockActive', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
        return promises;
    }

    _createDevicePermanentFullRxChannel(device, channel) {
        let promises = [];
        promises.push(...this._createDeviceBaseChannel(device, channel));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.permanentFullRx', { type: 'state', common: { name: 'permanentFullRx', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
        return promises;
    }

    _createRotaryHandleChannel(device, channel) {
        let promises = [];
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.windowState', { type: 'state', common: { name: 'windowState', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.windowOpen', { type: 'state', common: { name: 'windowOpen', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.eventDelay', { type: 'state', common: { name: 'eventDelay', type: 'number', role: 'info', read: true, write: false }, native: {} }));
        return promises;
    }

    _createBlindChannel(device, channel) {
        let promises = [];
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.stop', { type: 'state', common: { name: 'on', type: 'boolean', role: 'button', read: false, write: true }, native: { id: device.id, channel: channel, parameter: 'stop' } }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.previousShutterLevel', { type: 'state', common: { name: 'previousShutterLevel', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.processing', { type: 'state', common: { name: 'processing', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.selfCalibrationInProgress', { type: 'state', common: { name: 'selfCalibrationInProgress', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.topToBottomReferenceTime', { type: 'state', common: { name: 'topToBottomReferenceTime', type: 'number', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.bottomToTopReferenceTime', { type: 'state', common: { name: 'bottomToTopReferenceTime', type: 'number', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.changeOverDelay', { type: 'state', common: { name: 'changeOverDelay', type: 'number', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.supportingSelfCalibration', { type: 'state', common: { name: 'supportingSelfCalibration', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.endpositionAutoDetectionEnabled', { type: 'state', common: { name: 'endpositionAutoDetectionEnabled', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.supportingEndpositionAutoDetection', { type: 'state', common: { name: 'supportingEndpositionAutoDetection', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.delayCompensationValue', { type: 'state', common: { name: 'delayCompensationValue', type: 'number', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.supportingDelayCompensation', { type: 'state', common: { name: 'supportingDelayCompensation', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.profileMode', { type: 'state', common: { name: 'profileMode', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.userDesiredProfileMode', { type: 'state', common: { name: 'userDesiredProfileMode', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.previousSlatsLevel', { type: 'state', common: { name: 'previousSlatsLevel', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.slatsReferenceTime', { type: 'state', common: { name: 'slatsReferenceTime', type: 'number', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.blindModeActive', { type: 'state', common: { name: 'blindModeActive', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.slatsLevel', { type: 'state', common: { name: 'slatsLevel', type: 'number', role: 'info', read: true, write: false }, native: { id: device.id, channel: channel, parameter: 'slatsLevel' } }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.shutterLevel', { type: 'state', common: { name: 'shutterLevel', type: 'number', role: 'info', read: true, write: false }, native: { id: device.id, channel: channel, parameter: 'slatsLevel' } }));
        return promises;
    }

    _createHeatingThermostatChannel(device, channel) {
        let promises = [];
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.temperatureOffset', { type: 'state', common: { name: 'temperatureOffset', type: 'number', role: 'thermo', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.valvePosition', { type: 'state', common: { name: 'valvePosition', type: 'number', role: 'thermo', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.setPointTemperature', { type: 'state', common: { name: 'setPointTemperature', type: 'number', role: 'thermo', read: true, write: true }, native: { id: device.functionalChannels[channel].groups, parameter: 'setPointTemperature' } }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.valveState', { type: 'state', common: { name: 'valveState', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        return promises;
    }

    _createShutterContactChannel(device, channel) {
        let promises = [];
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.windowState', { type: 'state', common: { name: 'windowState', type: 'string', role: 'sensor.window', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.windowOpen', { type: 'state', common: { name: 'windowOpen', type: 'boolean', role: 'sensor.window', read: true, write: false }, native: {} }));
        return promises;
    }

    _createSmokeDetectorChannel(device, channel) {
        let promises = [];
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.smokeDetectorAlarmType', { type: 'state', common: { name: 'smokeDetectorAlarmType', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        return promises;
    }

    _createDimmerChannel(device, channel) {
        let promises = [];
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.dimLevel', { type: 'state', common: { name: 'dimLevel', type: 'number', role: 'level.dimmer', read: true, write: false }, native: { id: device.id, channel: channel, parameter: 'setDimLevel' } }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.on', { type: 'state', common: { name: 'on', type: 'boolean', role: 'switch', read: true, write: true }, native: { id: device.id, channel: channel, parameter: 'switchState' } }));
        return promises;
    }

    _createWaterSensorChannel(device, channel) {
        let promises = [];
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.moistureDetected', { type: 'state', common: { name: 'moistureDetected', type: 'boolean', role: 'level', read: true, write: true }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.waterlevelDetected', { type: 'state', common: { name: 'waterlevelDetected', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.sirenWaterAlarmTrigger', { type: 'state', common: { name: 'sirenWaterAlarmTrigger', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.inAppWaterAlarmTrigger', { type: 'state', common: { name: 'inAppWaterAlarmTrigger', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.acousticAlarmSignal', { type: 'state', common: { name: 'acousticAlarmSignal', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.acousticAlarmTiming', { type: 'state', common: { name: 'acousticAlarmTiming', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.acousticWaterAlarmTrigger', { type: 'state', common: { name: 'acousticWaterAlarmTrigger', type: 'string', role: 'info', read: true, write: true }, native: {} }));
        return promises;
    }

    _createWeatherSensorChannel(device, channel) {
        let promises = [];
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.actualTemperature', { type: 'state', common: { name: 'raining', type: 'boolean', role: 'info', read: true, write: true }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.humidity', { type: 'state', common: { name: 'todayRainCounter', type: 'number', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.illumination', { type: 'state', common: { name: 'totalRainCounter', type: 'number', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.illuminationThresholdSunshine', { type: 'state', common: { name: 'yesterdayRainCounter', type: 'number', role: 'level', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.storm', { type: 'state', common: { name: 'yesterdayRainCounter', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.sunshine', { type: 'state', common: { name: 'yesterdayRainCounter', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.todaySunshineDuration', { type: 'state', common: { name: 'yesterdayRainCounter', type: 'number', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.totalSunshineDuration', { type: 'state', common: { name: 'yesterdayRainCounter', type: 'number', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.windSpeed', { type: 'state', common: { name: 'yesterdayRainCounter', type: 'number', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.windValueType', { type: 'state', common: { name: 'yesterdayRainCounter', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.yesterdaySunshineDuration', { type: 'state', common: { name: 'yesterdayRainCounter', type: 'number', role: 'info', read: true, write: false }, native: {} }));
        return promises;
    }

    _createWeatherSensorPlusChannel(device, channel) {
        let promises = [];
        promises.push(...this._createWaterSensorChannel(device, channel));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.raining', { type: 'state', common: { name: 'raining', type: 'boolean', role: 'info', read: true, write: true }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.todayRainCounter', { type: 'state', common: { name: 'todayRainCounter', type: 'number', role: 'level', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.totalRainCounter', { type: 'state', common: { name: 'totalRainCounter', type: 'number', role: 'level', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.yesterdayRainCounter', { type: 'state', common: { name: 'yesterdayRainCounter', type: 'number', role: 'level', read: true, write: false }, native: {} }));
        return promises;
    }

    _createWeatherSensorProChannel(device, channel) {
        let promises = [];
        promises.push(...this._createWeatherSensorPlusChannel(device, channel));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.weathervaneAlignmentNeeded', { type: 'state', common: { name: 'weathervaneAlignmentNeeded', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.windDirection', { type: 'state', common: { name: 'windDirection', type: 'number', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.windDirectionVariation', { type: 'state', common: { name: 'windDirectionVariation', type: 'number', role: 'info', read: true, write: false }, native: {} }));
        return promises;
    }

    _createShutterChannel(device, channel) {
        let promises = [];
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.stop', { type: 'state', common: { name: 'on', type: 'boolean', role: 'button', read: false, write: true }, native: { id: device.id, channel: channel, parameter: 'stop' } }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.shutterLevel', { type: 'state', common: { name: 'shutterLevel', type: 'number', role: 'level', read: true, write: true }, native: { id: device.id, channel: channel, parameter: 'shutterlevel' } }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.previousShutterLevel', { type: 'state', common: { name: 'previousShutterLevel', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.processing', { type: 'state', common: { name: 'processing', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.selfCalibrationInProgress', { type: 'state', common: { name: 'selfCalibrationInProgress', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.topToBottomReferenceTime', { type: 'state', common: { name: 'topToBottomReferenceTime', type: 'number', role: 'seconds', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.bottomToTopReferenceTime', { type: 'state', common: { name: 'bottomToTopReferenceTime', type: 'number', role: 'seconds', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.changeOverDelay', { type: 'state', common: { name: 'changeOverDelay', type: 'number', role: 'seconds', read: true, write: true }, native: { id: device.id, channel: channel, parameter: 'changeOverDelay' } }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.endpositionAutoDetectionEnabled', { type: 'state', common: { name: 'endpositionAutoDetectionEnabled', type: 'string', role: 'switch', read: true, write: true }, native: { id: device.id, channel: channel, parameter: 'switchState' } }));
        return promises;
    }

    _createSingleKeyChannel(device, channel) {
        let promises = [];
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.on', { type: 'state', common: { name: 'on', type: 'boolean', role: 'switch', read: true, write: true }, native: { } }));
        return promises;
    }

    _createSwitchChannel(device, channel) {
        let promises = [];
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.on', { type: 'state', common: { name: 'on', type: 'boolean', role: 'switch', read: true, write: true }, native: { id: device.id, channel: channel, parameter: 'switchState' } }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.profileMode', { type: 'state', common: { name: 'profileMode', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.userDesiredProfileMode', { type: 'state', common: { name: 'userDesiredProfileMode', type: 'string', role: 'button', read: false, write: true }, native: { id: device.id, channel: channel, parameter: 'resetEnergyCounter' } }));
        return promises;
    }

    _createSwitchMeasuringChannel(device, channel) {
        let promises = [];
        promises.push(...this._createSwitchChannel(device, channel));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.energyCounter', { type: 'state', common: { name: 'energyCounter', type: 'number', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.currentPowerConsumption', { type: 'state', common: { name: 'currentPowerConsumption', type: 'number', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.resetEnergyCounter', { type: 'state', common: { name: 'on', type: 'boolean', role: 'button', read: false, write: true }, native: { id: device.id, channel: channel, parameter: 'resetEnergyCounter' } }));
        return promises;
    }

    _createClimateSensorChannel(device, channel) {
        let promises = [];
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.actualTemperature', { type: 'state', common: { name: 'actualTemperature', type: 'number', role: 'thermo', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.humidity', { type: 'state', common: { name: 'humidity', type: 'number', role: 'thermo', read: true, write: false }, native: {} }));
        return promises;
    }

    _createWallMountedThermostatWithoutDisplay(device, channel) {
        let promises = [];
        promises.push(...this._createClimateSensorChannel(device, channel));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.temperatureOffset', { type: 'state', common: { name: 'temperatureOffset', type: 'number', role: 'thermo', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.setPointTemperature', { type: 'state', common: { name: 'setPointTemperature', type: 'number', role: 'thermo', read: true, write: true }, native: { id: device.functionalChannels[channel].groups, parameter: 'setPointTemperature' } }));
        return promises;
    }

    _createWallMountedThermostatProChannel(device, channel) {
        let promises = [];
        promises.push(...this._createWallMountedThermostatWithoutDisplay(device, channel));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.display', { type: 'state', common: { name: 'display', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        return promises;
    }

    _createAlarmSirenChannel(device, channel) {
        let promises = [];
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.on', { type: 'state', common: { name: 'on', type: 'boolean', role: 'switch', read: true, write: true }, native: { id: device.id, channel: channel, parameter: 'switchState' } }));
        return promises;
    }

    _createMotionDetectionChannel(device, channel) {
        let promises = [];
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.motionDetected', { type: 'state', common: { name: 'motionDetected', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.illumination', { type: 'state', common: { name: 'illumination', type: 'number', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.currentIllumination', { type: 'state', common: { name: 'currentIllumination', type: 'number', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.motionDetectionSendInterval', { type: 'state', common: { name: 'motionDetectionSendInterval', type: 'string', role: 'info', read: false, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + channel + '.motionBufferActive', { type: 'state', common: { name: 'motionBufferActive', type: 'boolean', role: 'switch', read: false, write: true }, native: { id: device.id, channel: channel, parameter: 'switchState' } }));
        return promises;
    }

    /* End Channel Types */

    _createObjectsForGroup(group) {
        this.log.silly("createObjectsForGroup - " + JSON.stringify(group));
        let promises = [];
        promises.push(this.setObjectNotExistsAsync('groups.' + group.id, { type: 'device', common: { name: group.label }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.info.type', { type: 'state', common: { name: 'type', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.info.label', { type: 'state', common: { name: 'label', type: 'string', role: 'info', read: true, write: false }, native: {} }));

        switch (group.type) {
            case 'HEATING': {
                promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.windowOpenTemperature', { type: 'state', common: { name: 'actualTemperature', type: 'number', role: 'thermo', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.setPointTemperature', { type: 'state', common: { name: 'setPointTemperature', type: 'number', role: 'thermo', read: true, write: true }, native: { id: [group.id], parameter: 'setPointTemperature' } }));
                promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.minTemperature', { type: 'state', common: { name: 'minTemperature', type: 'number', role: 'info', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.maxTemperature', { type: 'state', common: { name: 'maxTemperature', type: 'number', role: 'thermo', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.windowState', { type: 'state', common: { name: 'windowState', type: 'string', role: 'thermo', read: true, write: true }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.cooling', { type: 'state', common: { name: 'cooling', type: 'string', role: 'info', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.partyMode', { type: 'state', common: { name: 'partyMode', type: 'string', role: 'thermo', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.controlMode', { type: 'state', common: { name: 'controlMode', type: 'string', role: 'thermo', read: true, write: true }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.boostMode', { type: 'state', common: { name: 'boostMode', type: 'boolean', role: 'info', read: true, write: false }, native:  { id: [group.id], parameter: 'setBoost' } }));
                promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.boostDuration', { type: 'state', common: { name: 'boostDuration', type: 'number', role: 'thermo', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.actualTemperature', { type: 'state', common: { name: 'actualTemperature', type: 'number', role: 'thermo', read: true, write: true }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.humidity', { type: 'state', common: { name: 'humidity', type: 'number', role: 'info', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.coolingAllowed', { type: 'state', common: { name: 'coolingAllowed', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.coolingIgnored', { type: 'state', common: { name: 'coolingIgnored', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.ecoAllowed', { type: 'state', common: { name: 'ecoAllowed', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.ecoIgnored', { type: 'state', common: { name: 'ecoIgnored', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.controllable', { type: 'state', common: { name: 'controllable', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.floorHeatingMode', { type: 'state', common: { name: 'floorHeatingMode', type: 'string', role: 'info', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.humidityLimitEnabled', { type: 'state', common: { name: 'humidityLimitEnabled', type: 'number', role: 'info', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.humidityLimitValue', { type: 'state', common: { name: 'humidityLimitValue', type: 'number', role: 'info', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.externalClockEnabled', { type: 'state', common: { name: 'externalClockEnabled', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.externalClockHeatingTemperature', { type: 'state', common: { name: 'externalClockHeatingTemperature', type: 'number', role: 'info', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.externalClockCoolingTemperature', { type: 'state', common: { name: 'externalClockCoolingTemperature', type: 'number', role: 'info', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.valvePosition', { type: 'state', common: { name: 'valvePosition', type: 'number', role: 'info', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.sabotage', { type: 'state', common: { name: 'sabotage', type: 'string', role: 'info', read: true, write: false }, native: {} }));
                break;
            }
            case 'ALARM_SWITCHING': {
                promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.setOnTime', { type: 'state', common: { name: 'setOnTime', type: 'string', role: 'info', read: true, write: true }, native: { id: [group.id], parameter: 'setOnTime' } }));
                promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.testSignalOptical', { type: 'state', common: { name: 'testSignalOptical', type: 'string', role: 'info', read: true, write: true, states: { DISABLE_OPTICAL_SIGNAL: 'DISABLE_OPTICAL_SIGNAL', BLINKING_ALTERNATELY_REPEATING: 'BLINKING_ALTERNATELY_REPEATING', BLINKING_BOTH_REPEATING: 'BLINKING_BOTH_REPEATING', DOUBLE_FLASHING_REPEATING: 'DOUBLE_FLASHING_REPEATING', FLASHING_BOTH_REPEATING: 'FLASHING_BOTH_REPEATING', CONFIRMATION_SIGNAL_0: 'CONFIRMATION_SIGNAL_0', CONFIRMATION_SIGNAL_1: 'CONFIRMATION_SIGNAL_1', CONFIRMATION_SIGNAL_2: 'CONFIRMATION_SIGNAL_2' } }, native: { id: [group.id], parameter: 'testSignalOptical' } }));
                promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.setSignalOptical', { type: 'state', common: { name: 'setSignalOptical', type: 'string', role: 'info', read: true, write: true, states: { DISABLE_OPTICAL_SIGNAL: 'DISABLE_OPTICAL_SIGNAL', BLINKING_ALTERNATELY_REPEATING: 'BLINKING_ALTERNATELY_REPEATING', BLINKING_BOTH_REPEATING: 'BLINKING_BOTH_REPEATING', DOUBLE_FLASHING_REPEATING: 'DOUBLE_FLASHING_REPEATING', FLASHING_BOTH_REPEATING: 'FLASHING_BOTH_REPEATING', CONFIRMATION_SIGNAL_0: 'CONFIRMATION_SIGNAL_0', CONFIRMATION_SIGNAL_1: 'CONFIRMATION_SIGNAL_1', CONFIRMATION_SIGNAL_2: 'CONFIRMATION_SIGNAL_2' } }, native: { id: [group.id], parameter: 'setSignalOptical' } }));
                promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.testSignalAcoustic', { type: 'state', common: { name: 'testSignalAcoustic', type: 'string', role: 'info', read: true, write: true, states: { DISABLE_ACOUSTIC_SIGNAL: 'DISABLE_ACOUSTIC_SIGNAL', FREQUENCY_RISING: 'FREQUENCY_RISING', FREQUENCY_FALLING: 'FREQUENCY_FALLING', FREQUENCY_RISING_AND_FALLING: 'FREQUENCY_RISING_AND_FALLING', FREQUENCY_ALTERNATING_LOW_HIGH: 'FREQUENCY_ALTERNATING_LOW_HIGH', FREQUENCY_ALTERNATING_LOW_MID_HIGH: 'FREQUENCY_ALTERNATING_LOW_MID_HIGH', FREQUENCY_HIGHON_OFF: 'FREQUENCY_HIGHON_OFF', FREQUENCY_HIGHON_LONGOFF: 'FREQUENCY_HIGHON_LONGOFF', FREQUENCY_LOWON_OFF_HIGHON_OFF: 'FREQUENCY_LOWON_OFF_HIGHON_OFF', FREQUENCY_LOWON_LONGOFF_HIGHON_LONGOFF: 'FREQUENCY_LOWON_LONGOFF_HIGHON_LONGOFF', LOW_BATTERY: 'LOW_BATTERY', DISARMED: 'DISARMED', INTERNALLY_ARMED: 'INTERNALLY_ARMED', EXTERNALLY_ARMED: 'EXTERNALLY_ARMED', DELAYED_INTERNALLY_ARMED: 'DELAYED_INTERNALLY_ARMED', DELAYED_EXTERNALLY_ARMED: 'DELAYED_EXTERNALLY_ARMED', EVENT: 'EVENT', ERROR: 'ERROR' } }, native: { id: [group.id], parameter: 'testSignalAcoustic' } }));
                promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.setSignalAcoustic', { type: 'state', common: { name: 'setSignalAcoustic', type: 'string', role: 'info', read: true, write: true, states: { DISABLE_ACOUSTIC_SIGNAL: 'DISABLE_ACOUSTIC_SIGNAL', FREQUENCY_RISING: 'FREQUENCY_RISING', FREQUENCY_FALLING: 'FREQUENCY_FALLING', FREQUENCY_RISING_AND_FALLING: 'FREQUENCY_RISING_AND_FALLING', FREQUENCY_ALTERNATING_LOW_HIGH: 'FREQUENCY_ALTERNATING_LOW_HIGH', FREQUENCY_ALTERNATING_LOW_MID_HIGH: 'FREQUENCY_ALTERNATING_LOW_MID_HIGH', FREQUENCY_HIGHON_OFF: 'FREQUENCY_HIGHON_OFF', FREQUENCY_HIGHON_LONGOFF: 'FREQUENCY_HIGHON_LONGOFF', FREQUENCY_LOWON_OFF_HIGHON_OFF: 'FREQUENCY_LOWON_OFF_HIGHON_OFF', FREQUENCY_LOWON_LONGOFF_HIGHON_LONGOFF: 'FREQUENCY_LOWON_LONGOFF_HIGHON_LONGOFF', LOW_BATTERY: 'LOW_BATTERY', DISARMED: 'DISARMED', INTERNALLY_ARMED: 'INTERNALLY_ARMED', EXTERNALLY_ARMED: 'EXTERNALLY_ARMED', DELAYED_INTERNALLY_ARMED: 'DELAYED_INTERNALLY_ARMED', DELAYED_EXTERNALLY_ARMED: 'DELAYED_EXTERNALLY_ARMED', EVENT: 'EVENT', ERROR: 'ERROR' } }, native: { id: [group.id], parameter: 'setSignalAcoustic' } }));
                break;
            }
            case 'SWITCHING': {
                promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.on', { type: 'state', common: { name: 'on', type: 'boolean', role: 'info', read: true, write: true }, native: { } }));
                break;
            }
        }

        return Promise.all(promises);
    }

    _createObjectsForClient(client) {
        this.log.silly("createObjectsForClient - " + JSON.stringify(client));
        let promises = [];
        promises.push(this.setObjectNotExistsAsync('clients.' + client.id, { type: 'device', common: { name: client.label }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('clients.' + client.id + '.info.label', { type: 'state', common: { name: 'label', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        return Promise.all(promises);
    }

    _createObjectsForHome(home) {
        this.log.silly("createObjectsForHome - " + JSON.stringify(home));
        let promises = [];
        promises.push(this.setObjectNotExistsAsync('homes.' + home.id, { type: 'device', common: {}, native: {} }));

        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.alarmEventTimestamp', { type: 'state', common: { name: 'alarmEventTimestamp', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.alarmEventDeviceId', { type: 'state', common: { name: 'alarmEventDeviceId', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.alarmEventTriggerId', { type: 'state', common: { name: 'alarmEventTriggerId', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.alarmEventDeviceChannel', { type: 'state', common: { name: 'alarmEventDeviceChannel', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.alarmSecurityJournalEntryType', { type: 'state', common: { name: 'alarmSecurityJournalEntryType', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.alarmActive', { type: 'state', common: { name: 'alarmActive', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.zoneActivationDelay', { type: 'state', common: { name: 'zoneActivationDelay', type: 'number', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.intrusionAlertThroughSmokeDetectors', { type: 'state', common: { name: 'intrusionAlertThroughSmokeDetectors', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.securityZoneActivationMode', { type: 'state', common: { name: 'securityZoneActivationMode', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.solution', { type: 'state', common: { name: 'solution', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.activationInProgress', { type: 'state', common: { name: 'activationInProgress', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.active', { type: 'state', common: { name: 'active', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));

        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.setOnTime', { type: 'state', common: { name: 'setOnTime', type: 'string', role: 'info', read: true, write: true }, native: { id: home.functionalHomes.SECURITY_AND_ALARM.functionalGroups, parameter: 'setOnTime' } }));
        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.testSignalOptical', { type: 'state', common: { name: 'testSignalOptical', type: 'string', role: 'info', read: true, write: true, states: { DISABLE_OPTICAL_SIGNAL: 'DISABLE_OPTICAL_SIGNAL', BLINKING_ALTERNATELY_REPEATING: 'BLINKING_ALTERNATELY_REPEATING', BLINKING_BOTH_REPEATING: 'BLINKING_BOTH_REPEATING', DOUBLE_FLASHING_REPEATING: 'DOUBLE_FLASHING_REPEATING', FLASHING_BOTH_REPEATING: 'FLASHING_BOTH_REPEATING', CONFIRMATION_SIGNAL_0: 'CONFIRMATION_SIGNAL_0', CONFIRMATION_SIGNAL_1: 'CONFIRMATION_SIGNAL_1', CONFIRMATION_SIGNAL_2: 'CONFIRMATION_SIGNAL_2' } }, native: { id: home.functionalHomes.SECURITY_AND_ALARM.securitySwitchingGroups, parameter: 'testSignalOptical' } }));
        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.setSignalOptical', { type: 'state', common: { name: 'setSignalOptical', type: 'string', role: 'info', read: true, write: true, states: { DISABLE_OPTICAL_SIGNAL: 'DISABLE_OPTICAL_SIGNAL', BLINKING_ALTERNATELY_REPEATING: 'BLINKING_ALTERNATELY_REPEATING', BLINKING_BOTH_REPEATING: 'BLINKING_BOTH_REPEATING', DOUBLE_FLASHING_REPEATING: 'DOUBLE_FLASHING_REPEATING', FLASHING_BOTH_REPEATING: 'FLASHING_BOTH_REPEATING', CONFIRMATION_SIGNAL_0: 'CONFIRMATION_SIGNAL_0', CONFIRMATION_SIGNAL_1: 'CONFIRMATION_SIGNAL_1', CONFIRMATION_SIGNAL_2: 'CONFIRMATION_SIGNAL_2' } }, native: { id: home.functionalHomes.SECURITY_AND_ALARM.securitySwitchingGroups, parameter: 'setSignalOptical' } }));
        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.testSignalAcoustic', { type: 'state', common: { name: 'testSignalAcoustic', type: 'string', role: 'info', read: true, write: true, states: { DISABLE_ACOUSTIC_SIGNAL: 'DISABLE_ACOUSTIC_SIGNAL', FREQUENCY_RISING: 'FREQUENCY_RISING', FREQUENCY_FALLING: 'FREQUENCY_FALLING', FREQUENCY_RISING_AND_FALLING: 'FREQUENCY_RISING_AND_FALLING', FREQUENCY_ALTERNATING_LOW_HIGH: 'FREQUENCY_ALTERNATING_LOW_HIGH', FREQUENCY_ALTERNATING_LOW_MID_HIGH: 'FREQUENCY_ALTERNATING_LOW_MID_HIGH', FREQUENCY_HIGHON_OFF: 'FREQUENCY_HIGHON_OFF', FREQUENCY_HIGHON_LONGOFF: 'FREQUENCY_HIGHON_LONGOFF', FREQUENCY_LOWON_OFF_HIGHON_OFF: 'FREQUENCY_LOWON_OFF_HIGHON_OFF', FREQUENCY_LOWON_LONGOFF_HIGHON_LONGOFF: 'FREQUENCY_LOWON_LONGOFF_HIGHON_LONGOFF', LOW_BATTERY: 'LOW_BATTERY', DISARMED: 'DISARMED', INTERNALLY_ARMED: 'INTERNALLY_ARMED', EXTERNALLY_ARMED: 'EXTERNALLY_ARMED', DELAYED_INTERNALLY_ARMED: 'DELAYED_INTERNALLY_ARMED', DELAYED_EXTERNALLY_ARMED: 'DELAYED_EXTERNALLY_ARMED', EVENT: 'EVENT', ERROR: 'ERROR' } }, native: { id: home.functionalHomes.SECURITY_AND_ALARM.securitySwitchingGroups, parameter: 'testSignalAcoustic' } }));
        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.setSignalAcoustic', { type: 'state', common: { name: 'setSignalAcoustic', type: 'string', role: 'info', read: true, write: true, states: { DISABLE_ACOUSTIC_SIGNAL: 'DISABLE_ACOUSTIC_SIGNAL', FREQUENCY_RISING: 'FREQUENCY_RISING', FREQUENCY_FALLING: 'FREQUENCY_FALLING', FREQUENCY_RISING_AND_FALLING: 'FREQUENCY_RISING_AND_FALLING', FREQUENCY_ALTERNATING_LOW_HIGH: 'FREQUENCY_ALTERNATING_LOW_HIGH', FREQUENCY_ALTERNATING_LOW_MID_HIGH: 'FREQUENCY_ALTERNATING_LOW_MID_HIGH', FREQUENCY_HIGHON_OFF: 'FREQUENCY_HIGHON_OFF', FREQUENCY_HIGHON_LONGOFF: 'FREQUENCY_HIGHON_LONGOFF', FREQUENCY_LOWON_OFF_HIGHON_OFF: 'FREQUENCY_LOWON_OFF_HIGHON_OFF', FREQUENCY_LOWON_LONGOFF_HIGHON_LONGOFF: 'FREQUENCY_LOWON_LONGOFF_HIGHON_LONGOFF', LOW_BATTERY: 'LOW_BATTERY', DISARMED: 'DISARMED', INTERNALLY_ARMED: 'INTERNALLY_ARMED', EXTERNALLY_ARMED: 'EXTERNALLY_ARMED', DELAYED_INTERNALLY_ARMED: 'DELAYED_INTERNALLY_ARMED', DELAYED_EXTERNALLY_ARMED: 'DELAYED_EXTERNALLY_ARMED', EVENT: 'EVENT', ERROR: 'ERROR' } }, native: { id: home.functionalHomes.SECURITY_AND_ALARM.securitySwitchingGroups, parameter: 'setSignalAcoustic' } }));

        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.setIntrusionAlertThroughSmokeDetectors', { type: 'state', common: { name: 'setIntrusionAlertThroughSmokeDetectors', type: 'boolean', role: 'info', read: false, write: true }, native: { parameter: 'setIntrusionAlertThroughSmokeDetectors' } }));
        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.setSecurityZonesActivationNone', { type: 'state', common: { name: 'setSecurityZonesActivationNone', type: 'boolean', role: 'button', read: false, write: true }, native: { parameter: 'setSecurityZonesActivationNone' } }));
        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.setSecurityZonesActivationInternal', { type: 'state', common: { name: 'setSecurityZonesActivationInternal', type: 'boolean', role: 'button', read: false, write: true }, native: { parameter: 'setSecurityZonesActivationInternal' } }));
        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.setSecurityZonesActivationExternal', { type: 'state', common: { name: 'setSecurityZonesActivationExternal', type: 'boolean', role: 'button', read: false, write: true }, native: { parameter: 'setSecurityZonesActivationExternal' } }));
        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.setSecurityZonesActivationInternalAndExternal', { type: 'state', common: { name: 'setSecurityZonesActivationInternalAndExternal', type: 'boolean', role: 'button', read: false, write: true }, native: { parameter: 'setSecurityZonesActivationInternalAndExternal' } }));

        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.indoorClimate.absenceType', { type: 'state', common: { name: 'absenceType', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.indoorClimate.absenceEndTime', { type: 'state', common: { name: 'absenceEndTime', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.indoorClimate.ecoTemperature', { type: 'state', common: { name: 'ecoTemperature', type: 'number', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.indoorClimate.coolingEnabled', { type: 'state', common: { name: 'coolingEnabled', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.indoorClimate.ecoDuration', { type: 'state', common: { name: 'ecoDuration', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.indoorClimate.optimumStartStopEnabled', { type: 'state', common: { name: 'optimumStartStopEnabled', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.indoorClimate.solution', { type: 'state', common: { name: 'solution', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.indoorClimate.active', { type: 'state', common: { name: 'active', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));

        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.indoorClimate.vacationTemperature', { type: 'state', common: { name: 'vacationTemperature', type: 'number', role: 'info', read: true, write: true }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.indoorClimate.activateVacationWithEndTime', { type: 'state', common: { name: 'activateVacationWithEndTime', type: 'string', role: 'info', read: false, write: true }, native: { id: home.id, parameter: 'activateVacation' } }));
        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.indoorClimate.deactivateVacation', { type: 'state', common: { name: 'deactivateVacation', type: 'boolean', role: 'button', read: false, write: true }, native: { parameter: 'deactivateVacation' } }));
        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.indoorClimate.setAbsenceEndTime', { type: 'state', common: { name: 'setAbsenceEndTime', type: 'string', role: 'info', read: false, write: true }, native: { parameter: 'setAbsenceEndTime' } }));
        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.indoorClimate.setAbsenceDuration', { type: 'state', common: { name: 'setAbsenceDuration', type: 'string', role: 'info', read: false, write: true }, native: { parameter: 'setAbsenceDuration' } }));
        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.indoorClimate.deactivateAbsence', { type: 'state', common: { name: 'deactivateAbsence', type: 'boolean', role: 'button', read: false, write: true }, native: { parameter: 'deactivateAbsence' } }));

        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.lightAndShadow.active', { type: 'state', common: { name: 'active', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));

        promises.push(this.setObjectNotExistsAsync('homes.' + home.id + '.functionalHomes.weatherAndEnvironment.active', { type: 'state', common: { name: 'active', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));

        return Promise.all(promises);
    }
};

// If started as allInOne/compact mode => return function to create instance
if (module && module.parent) {
    module.exports = (options) => new HmIpCloudAccesspointAdapter(options);
} else {
    // or start the instance directly
    new HmIpCloudAccesspointAdapter();
} 
