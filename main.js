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
        // this._api.dataReceived = this._dataReceived.bind(this);
        this._api.opened = this._opened.bind(this);
        this._api.closed = this._closed.bind(this);
        this._api.errored = this._errored.bind(this);
        this._api.requestError = this._requestError.bind(this);
        this._api.unexpectedResponse = this._unexpectedResponse.bind(this);

        this.on('unload', this._unload);
        this.on('objectChange', this._objectChange);
        this.on('stateChange', this._stateChange);
        this.on('message', this._message);
        this.on('ready', this._ready);

        this._unloaded = false;
        this._requestTokenState = { state: 'idle' };

        this.wsConnected = false;
        this.wsConnectionStableTimeout = null;
        this.wsConnectionErrorCounter = 0;

        this.sendUnknownInfos = {};

        this.currentValues = {};
        this.delayTimeouts = {};
        this.initializedChannels = {};
    }

    _unload(callback) {
        this._unloaded = true;
        this.reInitTimeout && clearTimeout(this.reInitTimeout);
        this._api.dispose();
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

        if (!this.Sentry && this.supportsFeature && this.supportsFeature('PLUGINS')) {
            const sentryInstance = this.getPluginInstance('sentry');
            if (sentryInstance) {
                this.Sentry = sentryInstance.getSentryObject();
            }
        }

        if (this.config.accessPointSgtin && this.config.authToken && this.config.clientAuthToken && this.config.clientId) {
            try {
                this._api.parseConfigData({
                    authToken: this.config.authToken,
                    clientAuthToken: this.config.clientAuthToken,
                    clientId: this.config.clientId,
                    accessPointSgtin: this.config.accessPointSgtin,
                    pin: this.config.pin
                });
                await this._api.getHomematicHosts();

                await this._initData();
            } catch (err) {
                this.log.error('error starting homematic: ' +  err);
                this.log.error('Try reconnect in 30s');
                this.reInitTimeout = setTimeout(() => this._ready(), 30000);
            }
            this.log.debug('subscribeStates');
            this.subscribeStates('*');

            this.setState('info.connection', true, true);
            this.log.info('hmip adapter connected and ready');
        } else {
            this.log.info('token not yet created');
        }
    }

    async _initData() {
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
        if (this._api.devices) {
            for (let d in this._api.devices) {
                if (!this._api.devices.hasOwnProperty(d)) {
                    continue;
                }
                await this._updateDeviceStates(this._api.devices[d]);
            }
        } else {
            this.log.debug('No devices');
        }
        if (this._api.groups) {
            for (let g in this._api.groups) {
                if (!this._api.groups.hasOwnProperty(g)) {
                    continue;
                }
                await this._updateGroupStates(this._api.groups[g]);
            }
        } else {
            this.log.debug('No groups');
        }
        if (this._api.clients) {
            for (let c in this._api.clients) {
                if (!this._api.clients.hasOwnProperty(c)) {
                    continue;
                }
                await this._updateClientStates(this._api.clients[c]);
            }
        } else {
            this.log.debug('No clients');
        }
        if (this._api.home) {
            await this._updateHomeStates(this._api.home);
        } else {
            this.log.debug('No home');
        }
    }

    round(value, step) {
        step = step || 1.0;
        const inv = 1.0 / step;
        return Math.round(value * inv) / inv;
    }

    async _doStateChange(id, o, state) {
        try {
            switch (o.native.parameter) {
                case 'switchState':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceControlSetSwitchState(o.native.id, state.val, o.native.channel);
                    break;
                case 'sendDoorCommand':
                    //door commands as number: 1 = open; 2 = stop; 3 = close; 4 = ventilation position
                    switch (state.val) {
                        case 1: //state.val = 'OPEN'; break;
                        case 2: //state.val = 'STOP'; break;
                        case 3: //state.val = 'CLOSE'; break;
                        case 4: //state.val = 'VENTILATION_POSITION'; break;
                            break; // Send as before
                        default:
                            this.log.info('Ignore invalid value for doorCommand.');
                            return;
                    }
                    await this._api.deviceControlSendDoorCommand(o.native.id, state.val, o.native.channel);
                    break;
                case 'setLockState':
                    //door commands as number: 1 = open; 2 = locked; 3 = unlocked
                    switch (state.val) {
                        case 1: state.val = 'OPEN'; break;
                        case 2: state.val = 'LOCKED'; break;
                        case 3: state.val = 'UNLOCKED'; break;
                        default:
                            this.log.info('Ignore invalid value for setLockState.');
                            return;
                    }
                    const pin = await this.getStateAsync('devices.' + o.native.id + '.channels.' + o.native.channel + '.pin');
                    await this._api.deviceControlSetLockState(o.native.id, state.val, pin ? pin.val : '', o.native.channel);
                    break;
                case 'resetEnergyCounter':
                    await this._api.deviceControlResetEnergyCounter(o.native.id, o.native.channel);
                    break;
                case 'startImpulse':
                    await this._api.deviceControlStartImpulse(o.native.id, o.native.channel);
                    break;
                case 'shutterlevel':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceControlSetShutterLevel(o.native.id, state.val, o.native.channel);
                    break;
                case 'slatsLevel':
                    let slats = await this.getStateAsync('devices.' + o.native.id + '.channels.' + o.native.channel + '.slatsLevel');
                    let shutter = await this.getStateAsync('devices.' + o.native.id + '.channels.' + o.native.channel + '.shutterLevel');
                    if (slats.val === this.currentValues['devices.' + o.native.id + '.channels.' + o.native.channel + '.slatsLevel'] && shutter.val === this.currentValues['devices.' + o.native.id + '.channels.' + o.native.channel + '.shutterLevel']) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceControlSetSlatsLevel(o.native.id, slats.val, shutter.val, o.native.channel);
                    break;
                case 'setPrimaryShadingLevel':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceControlSetPrimaryShadingLevel(o.native.id, state.val, o.native.channel);
                    break;
                case 'setSecondaryShadingLevel':
                    let primary = await this.getStateAsync('devices.' + o.native.id + '.channels.' + o.native.channel + '.primaryShadingLevel');
                    let secondary = await this.getStateAsync('devices.' + o.native.id + '.channels.' + o.native.channel + '.secondaryShadingLevel');
                    if (primary.val === this.currentValues['devices.' + o.native.id + '.channels.' + o.native.channel + '.primaryShadingLevel'] && secondary.val === this.currentValues['devices.' + o.native.id + '.channels.' + o.native.channel + '.secondaryShadingLevel']) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceControlSetSecondaryShadingLevel(o.native.id, primary.val, secondary.val, o.native.channel);
                    break;
                case 'stop':
                    await this._api.deviceControlStop(o.native.id, o.native.channel);
                    break;
                case 'setPointTemperature':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    for (let id of o.native.id) {
                        await this._api.groupHeatingSetPointTemperature(id, state.val);
                    }
                    break;
                case 'setBoost':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    for (let id of o.native.id) {
                        await this._api.groupHeatingSetBoost(id, state.val);
                    }
                    break;
                case 'setActiveProfile':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    for (let id of o.native.id) {
                        await this._api.groupHeatingSetActiveProfile(id, state.val);
                    }
                    break;
                case 'setControlMode':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    for (let id of o.native.id) {
                        await this._api.groupHeatingSetControlMode(id, state.val);
                    }
                    break;
                case 'setOperationLock':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceConfigurationSetOperationLock(o.native.id, state.val, o.native.channel);
                    break;
                case 'setClimateControlDisplay':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceConfigurationSetClimateControlDisplay(o.native.id, state.val, o.native.channel);
                    break;
                case 'setMinimumFloorHeatingValvePosition':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceConfigurationSetMinimumFloorHeatingValvePosition(o.native.id, state.val, o.native.channel);
                    break;
                case 'setDimLevel':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceControlSetDimLevel(o.native.id, state.val, o.native.channel);
                    break;
                case 'setRgbDimLevel':
                    let rgb = await this.getStateAsync('devices.' + o.native.id + '.channels.' + o.native.channel + '.simpleRGBColorState');
                    let dimLevel = await this.getStateAsync('devices.' + o.native.id + '.channels.' + o.native.channel + '.dimLevel');
                    if (dimLevel > 1) dimLevel = dimLevel / 100;
                    if (rgb.val === this.currentValues['devices.' + o.native.id + '.channels.' + o.native.channel + '.simpleRGBColorState'] && dimLevel.val === this.currentValues['devices.' + o.native.id + '.channels.' + o.native.channel + '.dimLevel']) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceControlSetRgbDimLevel(o.native.id, rgb.val, dimLevel.val, o.native.channel);
                    break;
                case 'changeOverDelay':
                    //await  this._api.deviceConfigurationChangeOverDelay(o.native.id, state.val, o.native.channel)
                    break;
                case 'setAbsenceEndTime':
                    await this._api.homeHeatingActivateAbsenceWithPeriod(state.val);
                    break;
                case 'setAbsenceDuration':
                    await this._api.homeHeatingActivateAbsenceWithDuration(state.val);
                    break;
                case 'deactivateAbsence':
                    await this._api.homeHeatingDeactivateAbsence();
                    break;
                case 'setAbsencePermanent':
                    await this._api.homeHeatingActivateAbsencePermanent();
                    break;
                case 'setIntrusionAlertThroughSmokeDetectors':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.homeSetIntrusionAlertThroughSmokeDetectors(state.val);
                    break;
                case 'activateVacation':
                    let vacTemp = await this.getStateAsync('homes.' + o.native.id + '.functionalHomes.indoorClimate.vacationTemperature').val;
                    await this._api.homeHeatingActivateVacation(vacTemp, state.val);
                    break;
                case 'deactivateVacation':
                    await this._api.homeHeatingDeactivateVacation();
                    break;
                case 'setSecurityZonesActivationNone':
                    await this._api.homeSetZonesActivation(false, false);
                    break;
                case 'setSecurityZonesActivationInternal':
                    await this._api.homeSetZonesActivation(true, false);
                    break;
                case 'setSecurityZonesActivationExternal':
                    await this._api.homeSetZonesActivation(false, true);
                    break;
                case 'setSecurityZonesActivationInternalAndExternal':
                    await this._api.homeSetZonesActivation(true, true);
                    break;
                case 'setOnTime':
                    if (Array.isArray(o.native.id)) {
                        for (let id of o.native.id) {
                            await this._api.groupSwitchingAlarmSetOnTime(id, state.val);
                        }
                    }
                    break;
                case 'testSignalOptical':
                    if (Array.isArray(o.native.id)) {
                        for (let id of o.native.id) {
                            await this._api.groupSwitchingAlarmTestSignalOptical(id, state.val);
                        }
                    }
                    break;
                case 'setSignalOptical':
                    if (Array.isArray(o.native.id)) {
                        for (let id of o.native.id) {
                            await this._api.groupSwitchingAlarmSetSignalOptical(id, state.val);
                        }
                    }
                    break;
                case 'testSignalAcoustic':
                    if (Array.isArray(o.native.id)) {
                        for (let id of o.native.id) {
                            await this._api.groupSwitchingAlarmTestSignalAcoustic(id, state.val);
                        }
                    }
                    break;
                case 'setSignalAcoustic':
                    if (Array.isArray(o.native.id)) {
                        for (let id of o.native.id) {
                            await this._api.groupSwitchingAlarmSetSignalAcoustic(id, state.val);
                        }
                    }
                    break;
            }
        } catch (err) {
            this.log.warn(`${o.native.parameter} - id ${o.native.id ? o.native.id : ''} - state change error: ${err}`);
        }
    }

    async _stateChange(id, state) {
        if (!id || !state) return;

        let o = await this.getObjectAsync(id);
        if (o && o.native && o.native.parameter) {
            if (o.native.step) {
                state.val = this.round(state.val, o.native.step);
                this.log.debug(`state change - ${o.native.parameter} - id ${o.native.id ? JSON.stringify(o.native.id) : ''} - value rounded to ${state.val} (step=${o.native.step} )`);
            } else {
                this.log.debug(`state change - ${o.native.parameter} - id ${o.native.id ? JSON.stringify(o.native.id) : ''} - value ${state.val}`);
            }

            if (o.native.debounce) {
                // if debounce and value is the same, ignore call
                if (this.delayTimeouts[id] && this.delayTimeouts[id].timeout && this.delayTimeouts[id].lastVal === state.val) {
                    this.log.debug(`${o.native.parameter} - id ${o.native.id ? JSON.stringify(o.native.id) : ''} - Debounce waiting - value stable`);
                    return;
                }
            } else {
                // if running timeout and not debounce, requests come in too fast
                if (this.delayTimeouts[id] && this.delayTimeouts[id].timeout) {
                    this.log.info(`${o.native.parameter} - id ${o.native.id ? JSON.stringify(o.native.id) : ''} - Too fast value changes, change blocked!`);
                    return;
                }
            }
            this.delayTimeouts[id] = this.delayTimeouts[id] || {};
            // clear timeout if one is running
            if (this.delayTimeouts[id].timeout) {
                clearTimeout(this.delayTimeouts[id].timeout);
                delete this.delayTimeouts[id].timeout;
            }
            if (o.native.debounce) {
                // debounce, delay sending command
                this.delayTimeouts[id].lastVal = state.val;
                this.delayTimeouts[id].timeout = setTimeout((id, o, state) => {
                    this.delayTimeouts[id].timeout = null;
                    this.log.debug(`${o.native.parameter} - id ${o.native.id ? JSON.stringify(o.native.id) : ''} - Send debounced value ${state.val} now to HMIP`);
                    this._doStateChange(id, o, state);
                }, o.native.debounce, id, o, state)
            } else {
                this.delayTimeouts[id].timeout = setTimeout(() => {
                    this.delayTimeouts[id].timeout = null;
                }, o.native.throttle || 1000)
                await this._doStateChange(id, o, state)
            }
        }
    }

    _dataReceived(data) {
        this.log.silly("data received - " + data);
    }

    _opened() {
        this.log.info("ws connection opened");
        this.wsConnected = true;
        this.wsConnectionStableTimeout && clearTimeout(this.wsConnectionStableTimeout);
        this.wsConnectionStableTimeout = setTimeout(() => {
            this.wsConnectionStableTimeout = null;
        }, 5000); // set null when connection is stable
    }

    _closed(code, reason) {
        if (this.wsConnectionStableTimeout) {
            this.wsConnectionErrorCounter++;
        }
        this.log.warn("ws connection closed (" + this.wsConnectionErrorCounter + ") - code: " + code + " - reason: " + reason);
        this.wsConnected = false;
        if (this.wsConnectionErrorCounter > 10 && !this._unloaded) {
            this._api.dispose();
            this._ready();
        }
    }

    _errored(error) {
        this.log.warn("ws connection error (" + this.wsConnectionErrorCounter + "): " + error);
        if (!this.wsConnected) {
            this.wsConnectionErrorCounter++;
        }
    }

    _requestError(error) {
        this.log.warn("Request error: " + error);
    }

    _unexpectedResponse(req, res) {
        this.log.warn("ws connection unexpected response: " + res.statusCode);
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
                if (ev.home) {
                    await this._updateHomeStates(ev.home);
                } else {
                    this.log.warn('No home in HOME_CHANGED: ' + JSON.stringify(ev));
                }
                break;
            case 'SECURITY_JOURNAL_CHANGED':
                if (ev.home) {
                    await this._updateHomeStates(ev.home);
                } else {
                    this.log.debug('Read Home for SECURITY_JOURNAL_CHANGED: ' + JSON.stringify(ev));
                    let state = await this._api.callRestApi('home/getCurrentState', this._api._clientCharacteristics);
                    state && state.home && await this._updateHomeStates(state.home);
                }
                break;
            case 'DEVICE_CHANNEL_EVENT':
                this.log.debug("unhandled known event - " + JSON.stringify(ev));
                break;
            default:
                this.log.warn("unhandled event - " + JSON.stringify(ev));
        }
    }

    async secureSetStateAsync(id, value, ack) {
        if (value && typeof value === 'object') {
            value = value.val;
        }
        if (value === undefined) {
            value = null;
        }
        await this.setStateAsync(id, value, ack);
        if (ack) {
            this.currentValues[`${this.namespace}.${id}`] = value;
        }
    }

    async _updateDeviceStates(device) {
        this.log.silly("updateDeviceStates - " + device.type + " - " + JSON.stringify(device));
        let promises = [];
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.info.type', device.type, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.info.modelType', device.modelType, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.info.label', device.label, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.info.firmwareVersion', device.firmwareVersion, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.info.updateState', device.updateState, true));
        switch (device.type) {
            /*case 'PLUGABLE_SWITCH': {
                promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.1.on', device.functionalChannels['1'].on, true));
                break;
            }*/
            default: {
                break;
            }
        }

        let unknownChannelDetected = false;
        for (let i in device.functionalChannels) {
            if (!device.functionalChannels.hasOwnProperty(i)) {
                continue;
            }
            let fc = device.functionalChannels[i];
            promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + i + '.functionalChannelType', fc.functionalChannelType, true));
            if (!this.initializedChannels[`${device.id}.channels.${i}`]) {
                unknownChannelDetected = true;
                continue;
            }

            switch (fc.functionalChannelType) {

                case 'DEVICE_OPERATIONLOCK':
                    promises.push(...this._updateDeviceOperationLockChannelStates(device, i));
                    break;
                case 'DEVICE_SABOTAGE':
                    promises.push(...this._updateDeviceSabotageChannelStates(device, i));
                    break;
                case 'DEVICE_RECHARGEABLE_WITH_SABOTAGE':
                    promises.push(...this._updateDeviceRechargeableWithSabotageChannelStates(device, i));
                    break;
                case 'ACCESS_CONTROLLER_CHANNEL':
                    promises.push(...this._updateAccessControllerChannelStates(device, i));
                    break;
                case 'ACCESS_CONTROLLER_WIRED_CHANNEL':
                    promises.push(...this._updateAccessControllerWiredChannelStates(device, i));
                    break;
                case 'PRESENCE_DETECTION_CHANNEL':
                    promises.push(...this._updatePresenceDetectionChannelStates(device, i));
                    break;
                case 'PASSAGE_DETECTOR_CHANNEL':
                    promises.push(...this._updatePassageDetectorChannelStates(device, i));
                    break;
                case 'DEVICE_GLOBAL_PUMP_CONTROL':
                    promises.push(...this._updateDeviceGlobalPumpControlStates(device, i));
                    break;
                case 'FLOOR_TERMINAL_BLOCK_LOCAL_PUMP_CHANNEL':
                    promises.push(...this._updateFloorTerminalBlockLockPumpChannelStates(device, i));
                    break;
                case 'FLOOR_TERMINAL_BLOCK_MECHANIC_CHANNEL':
                    promises.push(...this._updateFloorTerminalBlockMechanicChannelStates(device, i));
                    break;
                case 'DEVICE_BASE_FLOOR_HEATING':
                    promises.push(...this._updateDeviceBaseFloorHeatingChannelStates(device, i));
                    break;
                case 'DEVICE_INCORRECT_POSITIONED':
                    promises.push(...this._updateDeviceIncorrectPositionedStates(device, i));
                    break;
                case 'CONTACT_INTERFACE_CHANNEL':
                    promises.push(...this._updateContactInterfaceChannelStates(device, i));
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
                case 'TEMPERATURE_SENSOR_2_EXTERNAL_DELTA_CHANNEL':
                    promises.push(...this._updateTemperatureSensor2ExternalDeltaChannelStates(device, i));
                    break;
                case 'SHADING_CHANNEL':
                    promises.push(...this._updateShadingChannelStates(device, i));
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
                case 'WALL_MOUNTED_THERMOSTAT_CHANNEL':
                    promises.push(...this._updateWallMountedThermostatProChannelStates(device, i));
                    break;
                case 'ANALOG_ROOM_CONTROL_CHANNEL':
                    promises.push(...this._updateAnalogRoomControlChannelStates(device, i));
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
                case 'MULTI_MODE_INPUT_BLIND_CHANNEL':
                    promises.push(...this._updateMultiModeInputBlindChannelStates(device, i));
                    break;
                case 'ROTARY_HANDLE_CHANNEL':
                    promises.push(...this._updateRotaryHandleChannelStates(device, i));
                    break;
                case 'MULTI_MODE_INPUT_CHANNEL':
                    promises.push(...this._updateMultiModeInputChannelStates(device, i));
                    break;
                case 'MULTI_MODE_INPUT_DIMMER_CHANNEL':
                    promises.push(...this._updateMultiModeInputDimmerChannelStates(device, i));
                    break;
                case 'MULTI_MODE_INPUT_SWITCH_CHANNEL':
                    promises.push(...this._updateMultiModeInputSwitchChannelStates(device, i));
                    break;
                case 'SMOKE_DETECTOR_CHANNEL':
                    promises.push(...this._updateSmokeDetectorChannelStates(device, i));
                    break;
                case 'INTERNAL_SWITCH_CHANNEL':
                    promises.push(...this._updateInternalSwitchChannelStates(device, i));
                    break;
                case 'LIGHT_SENSOR_CHANNEL':
                    promises.push(...this._updateLightSensorChannelStates(device, i));
                    break;
                case 'ANALOG_OUTPUT_CHANNEL':
                    promises.push(...this._updateAnalogOutputChannelStates(device, i));
                    break;
                case 'IMPULSE_OUTPUT_CHANNEL':
                    promises.push(...this._updateImpulseOutputChannelStates(device, i));
                    break;
                case 'TILT_VIBRATION_SENSOR_CHANNEL':
                    promises.push(...this._updateTiltVibrationSensorChannelStates(device, i));
                    break;
                case 'ROTARY_WHEEL_CHANNEL':
                    promises.push(...this._updateRotaryWheelChannelStates(device, i));
                    break;
                case 'RAIN_DETECTION_CHANNEL':
                    promises.push(...this._updateRainDetectionChannelStates(device, i));
                    break;
                case 'ACCELERATION_SENSOR_CHANNEL':
                    promises.push(...this._updateAccelerationSensorChannelStates(device, i));
                    break;
                case 'NOTIFICATION_LIGHT_CHANNEL':
                    promises.push(...this._updateNotificationLightChannelStates(device, i));
                    break;
                case 'NOTIFICATION_MP3_SOUND_CHANNEL':
                    promises.push(...this._updateNotificationMp3SoundChannelStates(device, i));
                    break;
                case 'DOOR_CHANNEL':
                    promises.push(...this._updateDoorChannelStates(device, i));
                    break;
                case 'DOOR_LOCK_CHANNEL':
                    promises.push(...this._updateDoorLockChannelStates(device, i));
                    break;
                case 'ACCESS_AUTHORIZATION_CHANNEL':
                    promises.push(...this._updateAccessAuthorizationChannelStates(device, i));
                    break;
                case 'MAINS_FAILURE_CHANNEL':
                    promises.push(...this._updateMainsFailureChannelStates(device, i));
                    break;
                case 'CARBON_DIOXIDE_SENSOR_CHANNEL':
                    promises.push(...this._updateCarbonDioxideSensorStates(device, i));
                    break;
                default:
                    if (Object.keys(fc).length <= 6) { // we only have the minimum fields, so nothing to display
                        break;
                    }
                    this.log.info("unknown channel type - " + fc.functionalChannelType + " - " + JSON.stringify(device));
                    if (!this.sendUnknownInfos[fc.functionalChannelType]) {
                        this.sendUnknownInfos[fc.functionalChannelType] = true;
                        this.Sentry && this.Sentry.withScope(scope => {
                            scope.setLevel('info');
                            scope.setExtra('channelData', JSON.stringify(device));
                            this.Sentry.captureMessage('Unknown Channel type ' + fc.functionalChannelType, 'info');
                        });
                    }

                    break;
            }
        }
        await Promise.all(promises);

        if (unknownChannelDetected) {
            this.log.info('New devices or channels detected ... reinitialize ...');
            await this._initData();
        }
    }

    /* Start Channel Types */
    _updateMainsFailureChannelStates(device, channel) {
        let promises = [];
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.powerMainsFailure', device.functionalChannels[channel].powerMainsFailure, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.genericAlarmSignal', device.functionalChannels[channel].genericAlarmSignal, true));
        return promises;
    }

    _updateDoorChannelStates(device, channel) {
        let promises = [];
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.on', device.functionalChannels[channel].on, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.processing', device.functionalChannels[channel].processing, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.doorState', device.functionalChannels[channel].doorState, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.doorCommand', null, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.ventilationPositionSupported', device.functionalChannels[channel].ventilationPositionSupported, true));
        return promises;
    }

    _updateDoorLockChannelStates(device, channel) {
        let promises = [];
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.lockState', device.functionalChannels[channel].lockState, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.motorState', device.functionalChannels[channel].motorState, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.autoRelockEnabled', device.functionalChannels[channel].autoRelockEnabled, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.doorLockDirection', device.functionalChannels[channel].doorLockDirection, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.doorLockNeutralPosition', device.functionalChannels[channel].doorLockNeutralPosition, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.doorLockTurns', device.functionalChannels[channel].doorLockTurns, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.doorHandleType', device.functionalChannels[channel].doorHandleType, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.autoRelockDelay', device.functionalChannels[channel].autoRelockDelay, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.setLockState', null, true));
        return promises;
    }

    _updateNotificationLightChannelStates(device, channel) {
        let promises = [];
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.on', device.functionalChannels[channel].on, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.dimLevel', device.functionalChannels[channel].dimLevel, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.simpleRGBColorState', device.functionalChannels[channel].simpleRGBColorState, true));
        return promises;
    }

    _updateNotificationMp3SoundChannelStates(device, channel) {
        let promises = [];
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.volumeLevel', device.functionalChannels[channel].volumeLevel, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.soundFile', device.functionalChannels[channel].soundFile, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.profileMode', device.functionalChannels[channel].profileMode, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.userDesiredProfileMode', device.functionalChannels[channel].userDesiredProfileMode, true));
        return promises;
    }

    _updateLightSensorChannelStates(device, channel) {
        let promises = [];
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.currentIllumination', device.functionalChannels[channel].currentIllumination, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.averageIllumination', device.functionalChannels[channel].averageIllumination, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.lowestIllumination', device.functionalChannels[channel].lowestIllumination, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.highestIllumination', device.functionalChannels[channel].highestIllumination, true));
        return promises;
    }

    _updateTiltVibrationSensorChannelStates(device, channel) {
        let promises = [];
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.accelerationSensorMode', device.functionalChannels[channel].accelerationSensorMode, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.accelerationSensorTriggered', device.functionalChannels[channel].accelerationSensorTriggered, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.accelerationSensorSensitivity', device.functionalChannels[channel].accelerationSensorSensitivity, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.accelerationSensorTriggerAngle', device.functionalChannels[channel].accelerationSensorTriggerAngle, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.accelerationSensorEventFilterPeriod', device.functionalChannels[channel].accelerationSensorEventFilterPeriod, true));
        return promises;
    }

    _updateAccelerationSensorChannelStates(device, channel) {
        let promises = [];
        promises.push(...this._updateTiltVibrationSensorChannelStates(device, channel));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.accelerationSensorNeutralPosition', device.functionalChannels[channel].accelerationSensorNeutralPosition, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.notificationSoundTypeHighToLow', device.functionalChannels[channel].notificationSoundTypeHighToLow, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.notificationSoundTypeLowToHigh', device.functionalChannels[channel].notificationSoundTypeLowToHigh, true));
        return promises;
    }

    _updateInternalSwitchChannelStates(device, channel) {
        let promises = [];
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.frostProtectionTemperature', device.functionalChannels[channel].frostProtectionTemperature, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.heatingValveType', device.functionalChannels[channel].heatingValveType, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.internalSwitchOutputEnabled', device.functionalChannels[channel].internalSwitchOutputEnabled, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.valveProtectionDuration', device.functionalChannels[channel].valveProtectionDuration, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.valveProtectionSwitchingInterval', device.functionalChannels[channel].valveProtectionSwitchingInterval, true));
        return promises;
    }

    _updateSmokeDetectorChannelStates(device, channel) {
        let promises = [];
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.smokeDetectorAlarmType', device.functionalChannels[channel].smokeDetectorAlarmType, true));
        return promises;
    }

    _updateAccessAuthorizationChannelStates(device, channel) {
        let promises = [];
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.authorized', device.functionalChannels[channel].authorized, true));
        return promises;
    }

    _updateMultiModeInputChannelStates(device, channel) {
        let promises = [];
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.binaryBehaviorType', device.functionalChannels[channel].binaryBehaviorType, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.multiModeInputMode', device.functionalChannels[channel].multiModeInputMode, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.windowState', device.functionalChannels[channel].windowState, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.windowOpen', device.functionalChannels[channel].windowState === 'OPEN', true));
        return promises;
    }

    _updateMultiModeInputSwitchChannelStates(device, channel) {
        let promises = [];
        promises.push(...this._updateSwitchChannelStates(device, channel));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.binaryBehaviorType', device.functionalChannels[channel].binaryBehaviorType, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.multiModeInputMode', device.functionalChannels[channel].multiModeInputMode, true));
        return promises;
    }

    _updateMultiModeInputDimmerChannelStates(device, channel) {
        let promises = [];
        promises.push(...this._updateMultiModeInputSwitchChannelStates(device, channel));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.dimLevel', device.functionalChannels[channel].dimLevel, true));
        return promises;
    }

    _updateDeviceBaseChannelStates(device, channel) {
        let promises = [];
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.configPending', device.functionalChannels[channel].configPending, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.dutyCycle', device.functionalChannels[channel].dutyCycle, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.lowBat', device.functionalChannels[channel].lowBat, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.routerModuleEnabled', device.functionalChannels[channel].routerModuleEnabled, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.routerModuleSupported', device.functionalChannels[channel].routerModuleSupported, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.rssiDeviceValue', device.functionalChannels[channel].rssiDeviceValue, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.rssiPeerValue', device.functionalChannels[channel].rssiPeerValue, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.unreach', device.functionalChannels[channel].unreach, true));
        return promises;
    }

    _updateDeviceSabotageChannelStates(device, channel) {
        let promises = [];
        promises.push(...this._updateDeviceBaseChannelStates(device, channel));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.sabotage', device.functionalChannels[channel].sabotage, true));
        return promises;
    }

    _updateDeviceRechargeableWithSabotageChannelStates(device, channel) {
        let promises = [];
        promises.push(...this._updateDeviceSabotageChannelStates(device, channel));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.badBatteryHealth', device.functionalChannels[channel].badBatteryHealth, true));
        return promises;
    }

    _updateRotaryWheelChannelStates(device, channel) {
        let promises = [];
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.rotationDirection', device.functionalChannels[channel].rotationDirection, true));
        return promises;
    }

    _updateRainDetectionChannelStates(device, channel) {
        let promises = [];
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.raining', device.functionalChannels[channel].raining, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.rainSensorSensitivity', device.functionalChannels[channel].rainSensorSensitivity, true));
        return promises;
    }

    _updateAccessControllerChannelStates(device, channel) {
        let promises = [];
        promises.push(...this._updateDeviceBaseChannelStates(device, channel));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.signalBrightness', device.functionalChannels[channel].signalBrightness, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.accessPointPriority', device.functionalChannels[channel].accessPointPriority, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.dutyCycleLevel', device.functionalChannels[channel].dutyCycleLevel, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.carrierSenseLevel', device.functionalChannels[channel].carrierSenseLevel, true));
        return promises;
    }

    _updateAccessControllerWiredChannelStates(device, channel) {
        let promises = [];
        promises.push(...this._updateDeviceBaseChannelStates(device, channel));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.signalBrightness', device.functionalChannels[channel].signalBrightness, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.accessPointPriority', device.functionalChannels[channel].accessPointPriority, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.busConfigMismatch', device.functionalChannels[channel].busConfigMismatch, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.powerShortCircuit', device.functionalChannels[channel].powerShortCircuit, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.shortCircuitDataLine', device.functionalChannels[channel].shortCircuitDataLine, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.busMode', device.functionalChannels[channel].busMode, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.powerSupplyCurrent', device.functionalChannels[channel].powerSupplyCurrent, true));
        return promises;
    }

    _updateDeviceGlobalPumpControlStates(device, channel) {
        let promises = [];
        promises.push(...this._updateDeviceBaseChannelStates(device, channel));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.valveProtectionDuration', device.functionalChannels[channel].valveProtectionDuration, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.valveProtectionSwitchingInterval', device.functionalChannels[channel].valveProtectionSwitchingInterval, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.frostProtectionTemperature', device.functionalChannels[channel].frostProtectionTemperature, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.coolingEmergencyValue', device.functionalChannels[channel].coolingEmergencyValue, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.heatingEmergencyValue', device.functionalChannels[channel].heatingEmergencyValue, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.globalPumpControl', device.functionalChannels[channel].globalPumpControl, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.heatingValveType', device.functionalChannels[channel].heatingValveType, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.heatingLoadType', device.functionalChannels[channel].heatingLoadType, true));
        return promises;
    }

    _updateFloorTerminalBlockLockPumpChannelStates(device, channel) {
        let promises = [];
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.pumpLeadTime', device.functionalChannels[channel].pumpLeadTime, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.pumpFollowUpTime', device.functionalChannels[channel].pumpFollowUpTime, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.pumpProtectionDuration', device.functionalChannels[channel].pumpProtectionDuration, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.pumpProtectionSwitchingInterval', device.functionalChannels[channel].pumpProtectionSwitchingInterval, true));
        return promises;
    }

    _updateFloorTerminalBlockMechanicChannelStates(device, channel) {
        let promises = [];
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.valveState', device.functionalChannels[channel].valveState, true));
        return promises;
    }

    _updateImpulseOutputChannelStates(device, channel) {
        let promises = [];
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.processing', device.functionalChannels[channel].processing, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.impulseDuration', device.functionalChannels[channel].impulseDuration, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.startImpulse', false, true));
        return promises;
    }

    _updateAnalogOutputChannelStates(device, channel) {
        let promises = [];
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.analogOutputLevel', device.functionalChannels[channel].analogOutputLevel, true));
        return promises;
    }

    _updateDeviceBaseFloorHeatingChannelStates(device, channel) {
        let promises = [];
        promises.push(...this._updateDeviceBaseChannelStates(device, channel));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.valveProtectionDuration', device.functionalChannels[channel].valveProtectionDuration, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.valveProtectionSwitchingInterval', device.functionalChannels[channel].valveProtectionSwitchingInterval, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.frostProtectionTemperature', device.functionalChannels[channel].frostProtectionTemperature, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.coolingEmergencyValue', device.functionalChannels[channel].coolingEmergencyValue, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.heatingEmergencyValue', device.functionalChannels[channel].heatingEmergencyValue, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.minimumFloorHeatingValvePosition', device.functionalChannels[channel].minimumFloorHeatingValvePosition, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.pulseWidthModulationAtLowFloorHeatingValvePositionEnabled', device.functionalChannels[channel].pulseWidthModulationAtLowFloorHeatingValvePositionEnabled, true));
        return promises;
    }

    _updateDeviceIncorrectPositionedStates(device, channel) {
        let promises = [];
        promises.push(...this._updateDeviceBaseChannelStates(device, channel));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.incorrectPositioned', device.functionalChannels[channel].incorrectPositioned, true));
        return promises;
    }

    _updatePresenceDetectionChannelStates(device, channel) {
        let promises = [];
        promises.push(...this._updateDeviceBaseChannelStates(device, channel));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.presenceDetected', device.functionalChannels[channel].presenceDetected, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.illumination', device.functionalChannels[channel].illumination, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.currentIllumination', device.functionalChannels[channel].currentIllumination, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.numberOfBrightnessMeasurements', device.functionalChannels[channel].numberOfBrightnessMeasurements, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.motionDetectionSendInterval', device.functionalChannels[channel].motionDetectionSendInterval, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.motionBufferActive', device.functionalChannels[channel].motionBufferActive, true));
        return promises;
    }

    _updatePassageDetectorChannelStates(device, channel) {
        let promises = [];
        promises.push(...this._updateDeviceBaseChannelStates(device, channel));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.leftCounter', device.functionalChannels[channel].leftCounter, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.leftRightCounterDelta', device.functionalChannels[channel].leftRightCounterDelta, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.passageBlindtime', device.functionalChannels[channel].passageBlindtime, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.passageDirection', device.functionalChannels[channel].passageDirection, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.passageSensorSensitivity', device.functionalChannels[channel].passageSensorSensitivity, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.passageTimeout', device.functionalChannels[channel].passageTimeout, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.rightCounter', device.functionalChannels[channel].rightCounter, true));
        return promises;
    }

    _updateContactInterfaceChannelStates(device, channel) {
        let promises = [];
        promises.push(...this._updateDeviceBaseChannelStates(device, channel));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.windowState', device.functionalChannels[channel].windowState, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.contactType', device.functionalChannels[channel].contactType, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.alarmContactType', device.functionalChannels[channel].alarmContactType, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.eventDelay', device.functionalChannels[channel].eventDelay, true));
        return promises;
    }

    _updateDeviceOperationLockChannelStates(device, channel) {
        let promises = [];
        promises.push(...this._updateDeviceBaseChannelStates(device, channel));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.operationLockActive', device.functionalChannels[channel].operationLockActive, true));
        return promises;
    }

    _updateDevicePermanentFullRxChannelStates(device, channel) {
        let promises = [];
        promises.push(...this._updateDeviceBaseChannelStates(device, channel));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.permanentFullRx', device.functionalChannels[channel].permanentFullRx, true));
        return promises;
    }

    _updateRotaryHandleChannelStates(device, channel) {
        let promises = [];
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.windowState', device.functionalChannels[channel].windowState, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.windowOpen', device.functionalChannels[channel].windowState === 'OPEN', true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.eventDelay', device.functionalChannels[channel].eventDelay, true));
        return promises;
    }

    _updateBlindChannelStates(device, channel) {
        let promises = [];
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.shutterLevel', device.functionalChannels[channel].shutterLevel, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.previousShutterLevel', device.functionalChannels[channel].previousShutterLevel, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.processing', device.functionalChannels[channel].processing, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.selfCalibrationInProgress', device.functionalChannels[channel].selfCalibrationInProgress, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.topToBottomReferenceTime', device.functionalChannels[channel].topToBottomReferenceTime, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.bottomToTopReferenceTime', device.functionalChannels[channel].bottomToTopReferenceTime, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.changeOverDelay', device.functionalChannels[channel].changeOverDelay, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.supportingSelfCalibration', device.functionalChannels[channel].supportingSelfCalibration, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.endpositionAutoDetectionEnabled', device.functionalChannels[channel].endpositionAutoDetectionEnabled, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.supportingEndpositionAutoDetection', device.functionalChannels[channel].supportingEndpositionAutoDetection, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.delayCompensationValue', device.functionalChannels[channel].delayCompensationValue, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.supportingDelayCompensation', device.functionalChannels[channel].supportingDelayCompensation, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.profileMode', device.functionalChannels[channel].profileMode, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.userDesiredProfileMode', device.functionalChannels[channel].userDesiredProfileMode, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.slatsLevel', device.functionalChannels[channel].slatsLevel, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.previousSlatsLevel', device.functionalChannels[channel].previousSlatsLevel, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.slatsReferenceTime', device.functionalChannels[channel].slatsReferenceTime, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.blindModeActive', device.functionalChannels[channel].blindModeActive, true));
        return promises;
    }

    _updateMultiModeInputBlindChannelStates(device, channel) {
        let promises = [];
        promises.push(...this._updateBlindChannelStates(device, channel));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.binaryBehaviorType', device.functionalChannels[channel].binaryBehaviorType, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.multiModeInputMode', device.functionalChannels[channel].multiModeInputMode, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.favoritePrimaryShadingPosition', device.functionalChannels[channel].favoritePrimaryShadingPosition, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.favoriteSecondaryShadingPosition', device.functionalChannels[channel].favoriteSecondaryShadingPosition, true));
        return promises;
    }

    _updateSwitchChannelStates(device, channel) {
        let promises = [];
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.on', device.functionalChannels[channel].on, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.profileMode', device.functionalChannels[channel].profileMode, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.userDesiredProfileMode', device.functionalChannels[channel].userDesiredProfileMode, true));
        return promises;
    }

    _updateSwitchMeasuringChannelStates(device, channel) {
        let promises = [];
        promises.push(...this._updateSwitchChannelStates(device, channel));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.energyCounter', device.functionalChannels[channel].energyCounter, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.currentPowerConsumption', device.functionalChannels[channel].currentPowerConsumption, true));
        return promises;
    }

    _updateShutterContactChannelStates(device, channel) {
        let promises = [];
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.windowState', device.functionalChannels[channel].windowState, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.windowOpen', device.functionalChannels[channel].windowState === 'OPEN', true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.eventDelay', device.functionalChannels[channel].eventDelay, true));
        return promises;
    }

    _updateDimmerChannelStates(device, channel) {
        let promises = [];
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.dimLevel', device.functionalChannels[channel].dimLevel, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.on', device.functionalChannels[channel].on, true));
        return promises;
    }

    _updateTemperatureSensor2ExternalDeltaChannelStates(device, channel) {
        let promises = [];
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.temperatureExternalOne', device.functionalChannels[channel].temperatureExternalOne, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.temperatureExternalTwo', device.functionalChannels[channel].temperatureExternalTwo, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.temperatureExternalDelta', device.functionalChannels[channel].temperatureExternalDelta, true));
        return promises;
    }

    _updateWaterSensorChannelStates(device, channel) {
        let promises = [];
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.moistureDetected', device.functionalChannels[channel].moistureDetected, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.waterlevelDetected', device.functionalChannels[channel].waterlevelDetected, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.sirenWaterAlarmTrigger', device.functionalChannels[channel].sirenWaterAlarmTrigger, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.inAppWaterAlarmTrigger', device.functionalChannels[channel].inAppWaterAlarmTrigger, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.acousticAlarmSignal', device.functionalChannels[channel].acousticAlarmSignal, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.acousticAlarmTiming', device.functionalChannels[channel].acousticAlarmTiming, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.acousticWaterAlarmTrigger', device.functionalChannels[channel].acousticWaterAlarmTrigger, true));
        return promises;
    }

    _updateShadingChannelStates(device, channel) {
        let promises = [];
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.primaryShadingLevel', device.functionalChannels[channel].primaryShadingLevel, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.previousPrimaryShadingLevel', device.functionalChannels[channel].previousPrimaryShadingLevel, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.primaryShadingStateType', device.functionalChannels[channel].primaryShadingStateType, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.processing', device.functionalChannels[channel].processing, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.secondaryShadingLevel', device.functionalChannels[channel].secondaryShadingLevel, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.previousSecondaryShadingLevel', device.functionalChannels[channel].previousSecondaryShadingLevel, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.secondaryShadingStateType', device.functionalChannels[channel].secondaryShadingStateType, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.profileMode', device.functionalChannels[channel].profileMode, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.userDesiredProfileMode', device.functionalChannels[channel].userDesiredProfileMode, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.shadingPackagePosition', device.functionalChannels[channel].shadingPackagePosition, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.primaryOpenAdjustable', device.functionalChannels[channel].primaryOpenAdjustable, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.primaryCloseAdjustable', device.functionalChannels[channel].primaryCloseAdjustable, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.secondaryOpenAdjustable', device.functionalChannels[channel].secondaryOpenAdjustable, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.secondaryCloseAdjustable', device.functionalChannels[channel].secondaryCloseAdjustable, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.shadingPositionAdjustmentActive', device.functionalChannels[channel].shadingPositionAdjustmentActive, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.shadingPositionAdjustmentClientId', device.functionalChannels[channel].shadingPositionAdjustmentClientId, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.favoritePrimaryShadingPosition', device.functionalChannels[channel].favoritePrimaryShadingPosition, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.favoriteSecondaryShadingPosition', device.functionalChannels[channel].favoriteSecondaryShadingPosition, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.productId', device.functionalChannels[channel].productId, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.identifyOemSupported', device.functionalChannels[channel].identifyOemSupported, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.shadingDriveVersion', device.functionalChannels[channel].shadingDriveVersion, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.manualDriveSpeed', device.functionalChannels[channel].manualDriveSpeed, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.automationDriveSpeed', device.functionalChannels[channel].automationDriveSpeed, true));
        return promises;
    }

    _updateWeatherSensorChannelStates(device, channel) {
        let promises = [];
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.actualTemperature', device.functionalChannels[channel].actualTemperature, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.humidity', device.functionalChannels[channel].humidity, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.illumination', device.functionalChannels[channel].illumination, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.illuminationThresholdSunshine', device.functionalChannels[channel].illuminationThresholdSunshine, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.storm', device.functionalChannels[channel].storm, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.sunshine', device.functionalChannels[channel].sunshine, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.todaySunshineDuration', device.functionalChannels[channel].todaySunshineDuration, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.totalSunshineDuration', device.functionalChannels[channel].totalSunshineDuration, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.windSpeed', device.functionalChannels[channel].windSpeed, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.windValueType', device.functionalChannels[channel].windValueType, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.yesterdaySunshineDuration', device.functionalChannels[channel].yesterdaySunshineDuration, true));
        return promises;
    }

    _updateWeatherSensorPlusChannelStates(device, channel) {
        let promises = [];
        promises.push(...this._updateWeatherSensorChannelStates(device, channel));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.raining', device.functionalChannels[channel].raining, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.todayRainCounter', device.functionalChannels[channel].todayRainCounter, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.totalRainCounter', device.functionalChannels[channel].totalRainCounter, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.yesterdayRainCounter', device.functionalChannels[channel].yesterdayRainCounter, true));
        return promises;
    }

    _updateWeatherSensorProChannelStates(device, channel) {
        let promises = [];
        promises.push(...this._updateWeatherSensorPlusChannelStates(device, channel));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.weathervaneAlignmentNeeded', device.functionalChannels[channel].weathervaneAlignmentNeeded, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.windDirection', device.functionalChannels[channel].windDirection, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.windDirectionVariation', device.functionalChannels[channel].windDirectionVariation, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.vaporAmount', device.functionalChannels[channel].vaporAmount, true));
        return promises;
    }

    _updateSingleKeyChannelStates(device, channel) {
        let promises = [];
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.on', device.functionalChannels[channel].on, true));
        return promises;
    }

    _updateShutterChannelStates(device, channel) {
        let promises = [];
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.shutterLevel', device.functionalChannels[channel].shutterLevel, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.previousShutterLevel', device.functionalChannels[channel].previousShutterLevel, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.processing', device.functionalChannels[channel].processing, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.selfCalibrationInProgress', device.functionalChannels[channel].selfCalibrationInProgress, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.topToBottomReferenceTime', device.functionalChannels[channel].topToBottomReferenceTime, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.bottomToTopReferenceTime', device.functionalChannels[channel].bottomToTopReferenceTime, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.changeOverDelay', device.functionalChannels[channel].changeOverDelay, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.endpositionAutoDetectionEnabled', device.functionalChannels[channel].endpositionAutoDetectionEnabled, true));
        return promises;
    }

    _updateHeatingThermostatChannelStates(device, channel) {
        let promises = [];
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.temperatureOffset', device.functionalChannels[channel].temperatureOffset, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.valvePosition', device.functionalChannels[channel].valvePosition, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.setPointTemperature', device.functionalChannels[channel].setPointTemperature, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.valveActualTemperature', device.functionalChannels[channel].valveActualTemperature, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.valveState', device.functionalChannels[channel].valveState, true));
        return promises;

    }

    _updateClimateSensorChannelStates(device, channel) {
        let promises = [];
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.actualTemperature', device.functionalChannels[channel].actualTemperature, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.humidity', device.functionalChannels[channel].humidity, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.vaporAmount', device.functionalChannels[channel].vaporAmount, true));
        return promises;
    }

    _updateCarbonDioxideSensorStates(device, channel) {
        let promises = [];
        promises.push(...this._updateClimateSensorChannelStates(device, channel));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.carbonDioxideVisualisationEnabled', device.functionalChannels[channel].carbonDioxideVisualisationEnabled, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.carbonDioxideConcentration', device.functionalChannels[channel].carbonDioxideConcentration, true));
        return promises;
    }

    _updateWallMountedThermostatWithoutDisplayStates(device, channel) {
        let promises = [];
        promises.push(...this._updateClimateSensorChannelStates(device, channel));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.temperatureOffset', device.functionalChannels[channel].temperatureOffset, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.setPointTemperature', device.functionalChannels[channel].setPointTemperature, true));
        return promises;
    }

    _updateAnalogRoomControlChannelStates(device, channel) {
        let promises = [];
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.actualTemperature', device.functionalChannels[channel].actualTemperature, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.temperatureOffset', device.functionalChannels[channel].temperatureOffset, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.setPointTemperature', device.functionalChannels[channel].setPointTemperature, true));
        return promises;
    }

    _updateWallMountedThermostatProChannelStates(device, channel) {
        let promises = [];
        promises.push(...this._updateWallMountedThermostatWithoutDisplayStates(device, channel));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.display', device.functionalChannels[channel].display, true));
        return promises;
    }

    _updateAlarmSirenChannelStates(device, channel) {
        let promises = [];
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.on', device.functionalChannels[channel].on, true));
        return promises;
    }

    _updateMotionDetectionChannelStates(device, channel) {
        let promises = [];
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.motionDetected', device.functionalChannels[channel].motionDetected, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.illumination', device.functionalChannels[channel].illumination, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.currentIllumination', device.functionalChannels[channel].currentIllumination, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.motionDetectionSendInterval', device.functionalChannels[channel].motionDetectionSendInterval, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.motionBufferActive', device.functionalChannels[channel].motionBufferActive, true));
        promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.' + channel + '.numberOfBrightnessMeasurements', device.functionalChannels[channel].numberOfBrightnessMeasurements, true));
        return promises;
    }

    /* End Channel Types */

    _updateGroupStates(group) {
        this.log.silly("_updateGroupStates - " + JSON.stringify(group));
        let promises = [];
        promises.push(this.secureSetStateAsync('groups.' + group.id + '.info.type', group.type, true));
        promises.push(this.secureSetStateAsync('groups.' + group.id + '.info.label', group.label, true));

        switch (group.type) {
            case 'HEATING': {
                promises.push(this.secureSetStateAsync('groups.' + group.id + '.windowOpenTemperature', group.windowOpenTemperature, true));
                promises.push(this.secureSetStateAsync('groups.' + group.id + '.setPointTemperature', group.setPointTemperature, true));
                promises.push(this.secureSetStateAsync('groups.' + group.id + '.minTemperature', group.minTemperature, true));
                promises.push(this.secureSetStateAsync('groups.' + group.id + '.maxTemperature', group.maxTemperature, true));
                promises.push(this.secureSetStateAsync('groups.' + group.id + '.windowState', group.windowState, true));
                promises.push(this.secureSetStateAsync('groups.' + group.id + '.cooling', group.cooling, true));
                promises.push(this.secureSetStateAsync('groups.' + group.id + '.partyMode', group.partyMode, true));
                promises.push(this.secureSetStateAsync('groups.' + group.id + '.controlMode', group.controlMode, true));
                promises.push(this.secureSetStateAsync('groups.' + group.id + '.activeProfile', group.activeProfile, true));
                promises.push(this.secureSetStateAsync('groups.' + group.id + '.boostMode', group.boostMode, true));
                promises.push(this.secureSetStateAsync('groups.' + group.id + '.boostDuration', group.boostDuration, true));
                promises.push(this.secureSetStateAsync('groups.' + group.id + '.actualTemperature', group.actualTemperature, true));
                promises.push(this.secureSetStateAsync('groups.' + group.id + '.humidity', group.humidity, true));
                promises.push(this.secureSetStateAsync('groups.' + group.id + '.coolingAllowed', group.coolingAllowed, true));
                promises.push(this.secureSetStateAsync('groups.' + group.id + '.coolingIgnored', group.coolingIgnored, true));
                promises.push(this.secureSetStateAsync('groups.' + group.id + '.ecoAllowed', group.ecoAllowed, true));
                promises.push(this.secureSetStateAsync('groups.' + group.id + '.ecoIgnored', group.ecoIgnored, true));
                promises.push(this.secureSetStateAsync('groups.' + group.id + '.controllable', group.controllable, true));
                promises.push(this.secureSetStateAsync('groups.' + group.id + '.floorHeatingMode', group.floorHeatingMode, true));
                promises.push(this.secureSetStateAsync('groups.' + group.id + '.humidityLimitEnabled', group.humidityLimitEnabled, true));
                promises.push(this.secureSetStateAsync('groups.' + group.id + '.humidityLimitValue', group.humidityLimitValue, true));
                promises.push(this.secureSetStateAsync('groups.' + group.id + '.externalClockEnabled', group.externalClockEnabled, true));
                promises.push(this.secureSetStateAsync('groups.' + group.id + '.externalClockHeatingTemperature', group.externalClockHeatingTemperature, true));
                promises.push(this.secureSetStateAsync('groups.' + group.id + '.externalClockCoolingTemperature', group.externalClockCoolingTemperature, true));
                promises.push(this.secureSetStateAsync('groups.' + group.id + '.valvePosition', group.valvePosition, true));
                promises.push(this.secureSetStateAsync('groups.' + group.id + '.sabotage', group.sabotage, true));
                break;
            }
            case 'SWITCHING': {
                promises.push(this.secureSetStateAsync('groups.' + group.id + '.on', group.on, true));
                break;
            }
	    case 'SECURITY_ZONE': {
		promises.push(this.secureSetStateAsync('groups.' + group.id + '.active', group.active, true));
                break;
            }
        }

        return Promise.all(promises);
    }

    _updateClientStates(client) {
        this.log.silly("_updateClientStates - " + JSON.stringify(client));
        let promises = [];
        promises.push(this.secureSetStateAsync('clients.' + client.id + '.info.label', client.label, true));
        return Promise.all(promises);
    }

    _updateHomeStates(home) {
        this.log.silly("_updateHomeStates - " + JSON.stringify(home));
        let promises = [];

        if (home.weather) {
            promises.push(this.secureSetStateAsync('homes.' + home.id + '.weather.temperature', home.weather.temperature, true));
            promises.push(this.secureSetStateAsync('homes.' + home.id + '.weather.weatherCondition', home.weather.weatherCondition, true));
            promises.push(this.secureSetStateAsync('homes.' + home.id + '.weather.weatherDayTime', home.weather.weatherDayTime, true));
            promises.push(this.secureSetStateAsync('homes.' + home.id + '.weather.minTemperature', home.weather.minTemperature, true));
            promises.push(this.secureSetStateAsync('homes.' + home.id + '.weather.maxTemperature', home.weather.maxTemperature, true));
            promises.push(this.secureSetStateAsync('homes.' + home.id + '.weather.humidity', home.weather.humidity, true));
            promises.push(this.secureSetStateAsync('homes.' + home.id + '.weather.windSpeed', home.weather.windSpeed, true));
            promises.push(this.secureSetStateAsync('homes.' + home.id + '.weather.windDirection', home.weather.windDirection, true));
        }

        if (home.functionalHomes.SECURITY_AND_ALARM) {
            promises.push(this.secureSetStateAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.alarmEventTimestamp', home.functionalHomes.SECURITY_AND_ALARM.alarmEventTimestamp, true));
            promises.push(this.secureSetStateAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.alarmEventDeviceId', home.functionalHomes.SECURITY_AND_ALARM.alarmEventDeviceId, true));
            promises.push(this.secureSetStateAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.alarmEventTriggerId', home.functionalHomes.SECURITY_AND_ALARM.alarmEventTriggerId, true));
            promises.push(this.secureSetStateAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.alarmEventDeviceChannel', home.functionalHomes.SECURITY_AND_ALARM.alarmEventDeviceChannel, true));
            promises.push(this.secureSetStateAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.alarmSecurityJournalEntryType', home.functionalHomes.SECURITY_AND_ALARM.alarmSecurityJournalEntryType, true));
            promises.push(this.secureSetStateAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.alarmActive', home.functionalHomes.SECURITY_AND_ALARM.alarmActive, true));
            promises.push(this.secureSetStateAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.zoneActivationDelay', home.functionalHomes.SECURITY_AND_ALARM.zoneActivationDelay, true));
            promises.push(this.secureSetStateAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.intrusionAlertThroughSmokeDetectors', home.functionalHomes.SECURITY_AND_ALARM.intrusionAlertThroughSmokeDetectors, true));
            promises.push(this.secureSetStateAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.securityZoneActivationMode', home.functionalHomes.SECURITY_AND_ALARM.securityZoneActivationMode, true));
            promises.push(this.secureSetStateAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.solution', home.functionalHomes.SECURITY_AND_ALARM.solution, true));
            promises.push(this.secureSetStateAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.activationInProgress', home.functionalHomes.SECURITY_AND_ALARM.activationInProgress, true));
            promises.push(this.secureSetStateAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.active', home.functionalHomes.SECURITY_AND_ALARM.active, true));
        }
        if (home.functionalHomes.INDOOR_CLIMATE) {
            promises.push(this.secureSetStateAsync('homes.' + home.id + '.functionalHomes.indoorClimate.absenceType', home.functionalHomes.INDOOR_CLIMATE.absenceType, true));
            promises.push(this.secureSetStateAsync('homes.' + home.id + '.functionalHomes.indoorClimate.absenceEndTime', home.functionalHomes.INDOOR_CLIMATE.absenceEndTime, true));
            promises.push(this.secureSetStateAsync('homes.' + home.id + '.functionalHomes.indoorClimate.ecoTemperature', home.functionalHomes.INDOOR_CLIMATE.ecoTemperature, true));
            promises.push(this.secureSetStateAsync('homes.' + home.id + '.functionalHomes.indoorClimate.coolingEnabled', home.functionalHomes.INDOOR_CLIMATE.coolingEnabled, true));
            promises.push(this.secureSetStateAsync('homes.' + home.id + '.functionalHomes.indoorClimate.ecoDuration', home.functionalHomes.INDOOR_CLIMATE.ecoDuration, true));
            promises.push(this.secureSetStateAsync('homes.' + home.id + '.functionalHomes.indoorClimate.optimumStartStopEnabled', home.functionalHomes.INDOOR_CLIMATE.optimumStartStopEnabled, true));
            promises.push(this.secureSetStateAsync('homes.' + home.id + '.functionalHomes.indoorClimate.solution', home.functionalHomes.INDOOR_CLIMATE.solution, true));
            promises.push(this.secureSetStateAsync('homes.' + home.id + '.functionalHomes.indoorClimate.active', home.functionalHomes.INDOOR_CLIMATE.active, true));
        }
        if (home.functionalHomes.LIGHT_AND_SHADOW) {
            promises.push(this.secureSetStateAsync('homes.' + home.id + '.functionalHomes.lightAndShadow.active', home.functionalHomes.LIGHT_AND_SHADOW.active, true));
        }
        if (home.functionalHomes.WEATHER_AND_ENVIRONMENT) {
            promises.push(this.secureSetStateAsync('homes.' + home.id + '.functionalHomes.weatherAndEnvironment.active', home.functionalHomes.WEATHER_AND_ENVIRONMENT.active, true));
        }

        return Promise.all(promises);
    }

    async _createObjectsForDevices() {
        this.log.silly(`Devices: ${JSON.stringify(this._api.devices)}`);
        for (let i in this._api.devices) {
            if (!this._api.devices.hasOwnProperty(i)) {
                continue;
            }
            await this._createObjectsForDevice(this._api.devices[i]);
        }
    }

    async _createObjectsForGroups() {
        this.log.silly(`Groups: ${JSON.stringify(this._api.groups)}`);
        for (let i in this._api.groups) {
            if (!this._api.groups.hasOwnProperty(i)) {
                continue;
            }
            await this._createObjectsForGroup(this._api.groups[i]);
        }
    }

    async _createObjectsForClients() {
        this.log.silly(`Clients: ${JSON.stringify(this._api.clients)}`);
        for (let i in this._api.clients) {
            if (!this._api.clients.hasOwnProperty(i)) {
                continue;
            }
            await this._createObjectsForClient(this._api.clients[i]);
        }
    }

    async _createObjectsForHomes() {
        this.log.silly(`Home: ${JSON.stringify(this._api.home)}`);
        await this._createObjectsForHome(this._api.home);
    }


    _createObjectsForDevice(device) {
        this.log.silly("createObjectsForDevice - " + device.type + " - " + JSON.stringify(device));
        let promises = [];
        promises.push(this.extendObjectAsync('devices.' + device.id, { type: 'device', common: { name: device.label }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.info.type', { type: 'state', common: { name: 'type', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.info.modelType', { type: 'state', common: { name: 'type', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.info.label', { type: 'state', common: { name: 'type', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.info.firmwareVersion', { type: 'state', common: { name: 'type', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.info.updateState', { type: 'state', common: { name: 'type', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        switch (device.type) {
            /*case 'PLUGABLE_SWITCH': {
                promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.1', { type: 'channel', common: {}, native: {} }));
                promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.1.on', { type: 'state', common: { name: 'on', type: 'boolean', role: 'switch', read: true, write: true }, native: { id: device.id, channel: 1, parameter: 'switchState' } }));
                break;
            }*/
            default:
                break;
        }
        for (let i in device.functionalChannels) {
            if (!device.functionalChannels.hasOwnProperty(i)) {
                continue;
            }
            let fc = device.functionalChannels[i];
            promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + i, { type: 'channel', common: {}, native: {} }));
            this.initializedChannels[`${device.id}.channels.${i}`] = true;

            promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + i + '.functionalChannelType', { type: 'state', common: { name: 'functionalChannelType', type: 'string', role: 'text', read: true, write: false }, native: {} }));
            switch (fc.functionalChannelType) {

                case 'DEVICE_OPERATIONLOCK':
                    promises.push(...this._createDeviceOperationLockChannel(device, i));
                    break;
                case 'DEVICE_SABOTAGE':
                    promises.push(...this._createDeviceSabotageChannel(device, i));
                    break;
                case 'DEVICE_RECHARGEABLE_WITH_SABOTAGE':
                    promises.push(...this._createDeviceReacheargableWithSabotageChannel(device, i));
                    break;
                case 'ACCESS_CONTROLLER_CHANNEL':
                    promises.push(...this._createAccessControllerChannel(device, i));
                    break;
                case 'ACCESS_CONTROLLER_WIRED_CHANNEL':
                    promises.push(...this._createAccessControllerWiredChannel(device, i));
                    break;
                case 'HEATING_THERMOSTAT_CHANNEL':
                    promises.push(...this._createHeatingThermostatChannel(device, i));
                    break;
                case 'PRESENCE_DETECTION_CHANNEL':
                    promises.push(...this._createPresenceDetectionChannel(device, i));
                    break;
                case 'PASSAGE_DETECTOR_CHANNEL':
                    promises.push(...this._createPassageDetectorChannel(device, i));
                    break;
                case 'DEVICE_GLOBAL_PUMP_CONTROL':
                    promises.push(...this._createDeviceGlobalPumpControl(device, i));
                    break;
                case 'FLOOR_TERMINAL_BLOCK_LOCAL_PUMP_CHANNEL':
                    promises.push(...this._createFloorTerminalBlockLockPumpChannel(device, i));
                    break;
                case 'FLOOR_TERMINAL_BLOCK_MECHANIC_CHANNEL':
                    promises.push(...this._createFloorTerminalBlockMechanicChannel(device, i));
                    break;
                case 'DEVICE_BASE_FLOOR_HEATING':
                    promises.push(...this._createDeviceBaseFloorHeatingChannel(device, i));
                    break;
                case 'DEVICE_INCORRECT_POSITIONED':
                    promises.push(...this._createDeviceIncorrectPositioned(device, i));
                    break;
                case 'CONTACT_INTERFACE_CHANNEL':
                    promises.push(...this._createDeviceContactInterfaceChannel(device, i));
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
                case 'SHADING_CHANNEL':
                    promises.push(...this._createShadingChannel(device, i));
                    break;
                case 'TEMPERATURE_SENSOR_2_EXTERNAL_DELTA_CHANNEL':
                    promises.push(...this._createTemperatureSensor2ExternalDeltaChannel(device, i));
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
                case 'WALL_MOUNTED_THERMOSTAT_CHANNEL':
                    promises.push(...this._createWallMountedThermostatProChannel(device, i));
                    break;
                case 'ANALOG_ROOM_CONTROL_CHANNEL':
                    promises.push(...this._createAnalogRoomControlChannel(device, i));
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
                case 'MULTI_MODE_INPUT_BLIND_CHANNEL':
                    promises.push(...this._createMultiModeInputBlindChannel(device, i));
                    break;
                case 'ROTARY_HANDLE_CHANNEL':
                    promises.push(...this._createRotaryHandleChannel(device, i));
                    break;
                case 'MULTI_MODE_INPUT_CHANNEL':
                    promises.push(...this._createMultiModeInputChannel(device, i));
                    break;
                case 'MULTI_MODE_INPUT_DIMMER_CHANNEL':
                    promises.push(...this._createMultiModeInputDimmerChannel(device, i));
                    break;
                case 'MULTI_MODE_INPUT_SWITCH_CHANNEL':
                    promises.push(...this._createMultiModeInputSwitchChannel(device, i));
                    break;
                case 'SMOKE_DETECTOR_CHANNEL':
                    promises.push(...this._createSmokeDetectorChannel(device, i));
                    break;
                case 'INTERNAL_SWITCH_CHANNEL':
                    promises.push(...this._createInternalSwitchChannel(device, i));
                    break;
                case 'LIGHT_SENSOR_CHANNEL':
                    promises.push(...this._createLightSensorChannel(device, i));
                    break;
                case 'ANALOG_OUTPUT_CHANNEL':
                    promises.push(...this._createAnalogOutputChannel(device, i));
                    break;
                case 'IMPULSE_OUTPUT_CHANNEL':
                    promises.push(...this._createImpulseOutputChannel(device, i));
                    break;
                case 'TILT_VIBRATION_SENSOR_CHANNEL':
                    promises.push(...this._createTiltVibrationSensorChannel(device, i));
                    break;
                case 'ROTARY_WHEEL_CHANNEL':
                    promises.push(...this._createRotaryWheelChannel(device, i));
                    break;
                case 'RAIN_DETECTION_CHANNEL':
                    promises.push(...this._createRainDetectionChannel(device, i));
                    break;
                case 'ACCELERATION_SENSOR_CHANNEL':
                    promises.push(...this._createAccelerationSensorChannel(device, i));
                    break;
                case 'NOTIFICATION_LIGHT_CHANNEL':
                    promises.push(...this._createNotificationLightChannel(device, i));
                    break;
                case 'NOTIFICATION_MP3_SOUND_CHANNEL':
                    promises.push(...this._createNotificationMp3SoundChannel(device, i));
                    break;
                case 'DOOR_CHANNEL':
                    promises.push(...this._createDoorChannel(device, i));
                    break;
                case 'DOOR_LOCK_CHANNEL':
                    promises.push(...this._createDoorLockChannel(device, i));
                    break;
                case 'ACCESS_AUTHORIZATION_CHANNEL':
                    promises.push(...this._createAccessAuthorizationChannel(device, i));
                    break;
                case 'MAINS_FAILURE_CHANNEL':
                    promises.push(...this._createMainsFailureChannel(device, i));
                    break;
                case 'CARBON_DIOXIDE_SENSOR_CHANNEL':
                    promises.push(...this._createCarbonDioxideSensorChannel(device, i));
                    break;
                default:
                    this.log.info("unknown channel type - " + fc.functionalChannelType + " - " + JSON.stringify(device));
                    break;
            }
        }
        return Promise.all(promises);
    }

    /* Start Channel Types */
    _createMainsFailureChannel(device, channel) {
        let promises = [];
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.powerMainsFailure', { type: 'state', common: { name: 'powerMainsFailure', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.genericAlarmSignal', { type: 'state', common: { name: 'genericAlarmSignal', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        return promises;
    }

    _createNotificationMp3SoundChannel(device, channel) {
        let promises = [];
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.volumeLevel', { type: 'state', common: { name: 'volumeLevel', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.soundFile', { type: 'state', common: { name: 'soundFile', type: 'string', role: 'text', read: true, write: true }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.profileMode', { type: 'state', common: { name: 'profileMode', type: 'string', role: 'text', read: true, write: true }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.userDesiredProfileMode', { type: 'state', common: { name: 'userDesiredProfileMode', type: 'string', role: 'text', read: true, write: true }, native: {} }));
        return promises;
    }

    _createNotificationLightChannel(device, channel) {
        let promises = [];
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.on', { type: 'state', common: { name: 'on', type: 'boolean', role: 'indicator', read: true, write: true }, native: {id: device.id, channel: channel, parameter: 'switchState'} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.dimLevel', { type: 'state', common: { name: 'dimLevel', type: 'number', role: 'value', read: true, write: true }, native: {id: device.id, channel: channel, parameter: 'setRgbDimLevel'} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.simpleRGBColorState', { type: 'state', common: { name: 'simpleRGBColorState', type: 'string', role: 'text', read: true, write: true }, native: {id: device.id, channel: channel, parameter: 'setRgbDimLevel'} }));
        return promises;
    }

    _createDoorChannel(device, channel) {
        let promises = [];
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.doorState', { type: 'state', common: { name: 'doorState', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.on', { type: 'state', common: { name: 'on', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.processing', { type: 'state', common: { name: 'processing', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.ventilationPositionSupported', { type: 'state', common: { name: 'ventilationPositionSupported', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.doorCommand', { type: 'state', common: { name: 'doorCommand', type: 'number', role: 'value', read: true, write: true, states: {1: 'OPEN', 2: 'STOP', 3:'CLOSE', 4:'VENTILATION_POSITION'} }, native: { id: device.id, channel: channel, parameter: 'sendDoorCommand' } }));
        return promises;
    }

    _createDoorLockChannel(device, channel) {
        let promises = [];
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.lockState', { type: 'state', common: { name: 'lockState', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.motorState', { type: 'state', common: { name: 'motorState', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.autoRelockEnabled', { type: 'state', common: { name: 'autoRelockEnabled', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.doorLockDirection', { type: 'state', common: { name: 'doorLockDirection', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.doorLockNeutralPosition', { type: 'state', common: { name: 'doorLockNeutralPosition', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.doorLockTurns', { type: 'state', common: { name: 'doorLockTurns', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.doorHandleType', { type: 'state', common: { name: 'doorHandleType', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.autoRelockDelay', { type: 'state', common: { name: 'autoRelockDelay', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.pin', { type: 'state', common: { name: 'pin', type: 'string', role: 'state', read: true, write: true }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.setLockState', { type: 'state', common: { name: 'setLockState', type: 'number', role: 'value', read: true, write: true, states: {1: 'OPEN', 2: 'LOCKED', 3:'UNLOCKED'} }, native: { id: device.id, channel: channel, parameter: 'setLockState' } }));
        return promises;
    }

    _createLightSensorChannel(device, channel) {
        let promises = [];
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.currentIllumination', { type: 'state', common: { name: 'currentIllumination', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.averageIllumination', { type: 'state', common: { name: 'averageIllumination', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.lowestIllumination', { type: 'state', common: { name: 'lowestIllumination', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.highestIllumination', { type: 'state', common: { name: 'highestIllumination', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        return promises;
    }

    _createTiltVibrationSensorChannel(device, channel) {
        let promises = [];
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.accelerationSensorMode', { type: 'state', common: { name: 'accelerationSensorMode', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.accelerationSensorTriggered', { type: 'state', common: { name: 'accelerationSensorTriggered', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.accelerationSensorSensitivity', { type: 'state', common: { name: 'accelerationSensorSensitivity', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.accelerationSensorTriggerAngle', { type: 'state', common: { name: 'accelerationSensorTriggerAngle', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.accelerationSensorEventFilterPeriod', { type: 'state', common: { name: 'accelerationSensorEventFilterPeriod', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        return promises;
    }

    _createAccelerationSensorChannel(device, channel) {
        let promises = [];
        promises.push(...this._createTiltVibrationSensorChannel(device, channel));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.accelerationSensorNeutralPosition', { type: 'state', common: { name: 'accelerationSensorNeutralPosition', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.notificationSoundTypeHighToLow', { type: 'state', common: { name: 'notificationSoundTypeHighToLow', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.notificationSoundTypeLowToHigh', { type: 'state', common: { name: 'notificationSoundTypeLowToHigh', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        return promises;
    }

    _createInternalSwitchChannel(device, channel) {
        let promises = [];
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.frostProtectionTemperature', { type: 'state', common: { name: 'frostProtectionTemperature', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.heatingValveType', { type: 'state', common: { name: 'heatingValveType', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.internalSwitchOutputEnabled', { type: 'state', common: { name: 'internalSwitchOutputEnabled', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.valveProtectionDuration', { type: 'state', common: { name: 'valveProtectionDuration', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.valveProtectionSwitchingInterval', { type: 'state', common: { name: 'valveProtectionSwitchingInterval', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        return promises;
    }

    _createSmokeDetectorChannel(device, channel) {
        let promises = [];
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.smokeDetectorAlarmType', { type: 'state', common: { name: 'smokeDetectorAlarmType', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        return promises;
    }

    _createAccessAuthorizationChannel(device, channel) {
        let promises = [];
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.authorized', { type: 'state', common: { name: 'authorized', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} })); // assumed datatype
        return promises;
    }

    _createMultiModeInputChannel(device, channel) {
        let promises = [];
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.binaryBehaviorType', { type: 'state', common: { name: 'binaryBehaviorType', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.multiModeInputMode', { type: 'state', common: { name: 'multiModeInputMode', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.windowState', { type: 'state', common: { name: 'windowState', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.windowOpen', { type: 'state', common: { name: 'windowOpen', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        return promises;
    }

    _createMultiModeInputSwitchChannel(device, channel) {
        let promises = [];
        promises.push(...this._createSwitchChannel(device, channel));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.binaryBehaviorType', { type: 'state', common: { name: 'binaryBehaviorType', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.multiModeInputMode', { type: 'state', common: { name: 'multiModeInputMode', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        return promises;
    }

    _createRotaryWheelChannel(device, channel) {
        let promises = [];
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.rotationDirection', { type: 'state', common: { name: 'rotationDirection', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        return promises;
    }

    _createRainDetectionChannel(device, channel) {
        let promises = [];
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.raining', { type: 'state', common: { name: 'raining', type: 'boolean', role: 'sensor.rain', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.rainSensorSensitivity', { type: 'state', common: { name: 'rainSensorSensitivity', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        return promises;
    }

    _createMultiModeInputDimmerChannel(device, channel) {
        let promises = [];
        promises.push(...this._createMultiModeInputSwitchChannel(device, channel));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.dimLevel', { type: 'state', common: { name: 'dimLevel', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        return promises;
    }

    _createDeviceBaseChannel(device, channel) {
        let promises = [];
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.configPending', { type: 'state', common: { name: 'configPending', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.dutyCycle', { type: 'state', common: { name: 'dutyCycle', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.lowBat', { type: 'state', common: { name: 'lowBat', type: 'boolean', role: 'indicator.maintenance.lowbat', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.routerModuleEnabled', { type: 'state', common: { name: 'routerModuleEnabled', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.routerModuleSupported', { type: 'state', common: { name: 'routerModuleSupported', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.rssiDeviceValue', { type: 'state', common: { name: 'rssiDeviceValue', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.rssiPeerValue', { type: 'state', common: { name: 'rssiPeerValue', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.unreach', { type: 'state', common: { name: 'unreach', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        return promises;
    }

    _createDeviceSabotageChannel(device, channel) {
        let promises = [];
        promises.push(...this._createDeviceBaseChannel(device, channel));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.sabotage', { type: 'state', common: { name: 'sabotage', type: 'boolean', role: 'indicator.alarm', read: true, write: false }, native: {} }));
        return promises;
    }

    _createDeviceReacheargableWithSabotageChannel(device, channel) {
        let promises = [];
        promises.push(...this._createDeviceSabotageChannel(device, channel));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.badBatteryHealth', { type: 'state', common: { name: 'badBatteryHealth', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        return promises;
    }

    _createAccessControllerChannel(device, channel) {
        let promises = [];
        promises.push(...this._createDeviceBaseChannel(device, channel));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.signalBrightness', { type: 'state', common: { name: 'signalBrightness', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.accessPointPriority', { type: 'state', common: { name: 'accessPointPriority', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.dutyCycleLevel', { type: 'state', common: { name: 'dutyCycleLevel', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.carrierSenseLevel', { type: 'state', common: { name: 'carrierSenseLevel', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        return promises;
    }

    _createAccessControllerWiredChannel(device, channel) {
        let promises = [];
        promises.push(...this._createDeviceBaseChannel(device, channel));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.signalBrightness', { type: 'state', common: { name: 'signalBrightness', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.accessPointPriority', { type: 'state', common: { name: 'accessPointPriority', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.busConfigMismatch', { type: 'state', common: { name: 'busConfigMismatch', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.powerShortCircuit', { type: 'state', common: { name: 'powerShortCircuit', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.shortCircuitDataLine', { type: 'state', common: { name: 'shortCircuitDataLine', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.busMode', { type: 'state', common: { name: 'busMode', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.powerSupplyCurrent', { type: 'state', common: { name: 'powerSupplyCurrent', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        return promises;
    }

    _createPresenceDetectionChannel(device, channel) {
        let promises = [];
        promises.push(...this._createDeviceBaseChannel(device, channel));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.presenceDetected', { type: 'state', common: { name: 'presenceDetected', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.illumination', { type: 'state', common: { name: 'illumination', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.currentIllumination', { type: 'state', common: { name: 'currentIllumination', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.numberOfBrightnessMeasurements', { type: 'state', common: { name: 'numberOfBrightnessMeasurements', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.motionDetectionSendInterval', { type: 'state', common: { name: 'motionDetectionSendInterval', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.motionBufferActive', { type: 'state', common: { name: 'motionBufferActive', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        return promises;
    }

    _createPassageDetectorChannel(device, channel) {
        let promises = [];
        promises.push(...this._createDeviceBaseChannel(device, channel));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.leftCounter', { type: 'state', common: { name: 'leftCounter', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.leftRightCounterDelta', { type: 'state', common: { name: 'leftRightCounterDelta', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.passageBlindtime', { type: 'state', common: { name: 'passageBlindtime', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.passageDirection', { type: 'state', common: { name: 'passageDirection', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.passageSensorSensitivity', { type: 'state', common: { name: 'passageSensorSensitivity', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.passageTimeout', { type: 'state', common: { name: 'passageTimeout', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.rightCounter', { type: 'state', common: { name: 'rightCounter', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        return promises;
    }

    _createDeviceGlobalPumpControl(device, channel) {
        let promises = [];
        promises.push(...this._createDeviceBaseChannel(device, channel));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.valveProtectionDuration', { type: 'state', common: { name: 'valveProtectionDuration', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.valveProtectionSwitchingInterval', { type: 'state', common: { name: 'valveProtectionSwitchingInterval', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.frostProtectionTemperature', { type: 'state', common: { name: 'frostProtectionTemperature', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.coolingEmergencyValue', { type: 'state', common: { name: 'coolingEmergencyValue', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.heatingEmergencyValue', { type: 'state', common: { name: 'heatingEmergencyValue', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.globalPumpControl', { type: 'state', common: { name: 'globalPumpControl', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.heatingValveType', { type: 'state', common: { name: 'heatingValveType', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.heatingLoadType', { type: 'state', common: { name: 'heatingLoadType', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        return promises;
    }

    _createFloorTerminalBlockLockPumpChannel(device, channel) {
        let promises = [];
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.pumpLeadTime', { type: 'state', common: { name: 'pumpLeadTime', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.pumpFollowUpTime', { type: 'state', common: { name: 'pumpFollowUpTime', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.pumpProtectionDuration', { type: 'state', common: { name: 'pumpProtectionDuration', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.pumpProtectionSwitchingInterval', { type: 'state', common: { name: 'pumpProtectionSwitchingInterval', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        return promises;
    }

    _createFloorTerminalBlockMechanicChannel(device, channel) {
        let promises = [];
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.valveState', { type: 'state', common: { name: 'valveState', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        return promises;
    }

    _createAnalogOutputChannel(device, channel) {
        let promises = [];
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.analogOutputLevel', { type: 'state', common: { name: 'analogOutputLevel', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        return promises;
    }

    _createImpulseOutputChannel(device, channel) {
        let promises = [];
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.processing', { type: 'state', common: { name: 'processing', type: 'boolean', role: 'indicator.working', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.impulseDuration', { type: 'state', common: { name: 'impulseDuration', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.startImpulse', { type: 'state', common: { name: 'startImpulse', type: 'boolean', role: 'button', read: false, write: true }, native: {id: device.id, channel: channel, parameter: 'startImpulse'} }));
        return promises;
    }

    _createDeviceBaseFloorHeatingChannel(device, channel) {
        let promises = [];
        promises.push(...this._createDeviceBaseChannel(device, channel));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.valveProtectionDuration', { type: 'state', common: { name: 'valveProtectionDuration', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.valveProtectionSwitchingInterval', { type: 'state', common: { name: 'valveProtectionSwitchingInterval', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.frostProtectionTemperature', { type: 'state', common: { name: 'frostProtectionTemperature', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.coolingEmergencyValue', { type: 'state', common: { name: 'coolingEmergencyValue', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.heatingEmergencyValue', { type: 'state', common: { name: 'heatingEmergencyValue', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.minimumFloorHeatingValvePosition', { type: 'state', common: { name: 'minimumFloorHeatingValvePosition', type: 'number', role: 'value', read: true, write: true }, native: {id: device.id, channel: channel, parameter: 'setMinimumFloorHeatingValvePosition'} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.pulseWidthModulationAtLowFloorHeatingValvePositionEnabled', { type: 'state', common: { name: 'pulseWidthModulationAtLowFloorHeatingValvePositionEnabled', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        return promises;
    }

    _createDeviceIncorrectPositioned(device, channel) {
        let promises = [];
        promises.push(...this._createDeviceBaseChannel(device, channel));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.incorrectPositioned', { type: 'state', common: { name: 'incorrectPositioned', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        return promises;
    }

    _createDeviceContactInterfaceChannel(device, channel) {
        let promises = [];
        promises.push(...this._createDeviceBaseChannel(device, channel));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.windowState', { type: 'state', common: { name: 'windowState', type: 'string', role: 'sensor.window', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.contactType', { type: 'state', common: { name: 'contactType', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.alarmContactType', { type: 'state', common: { name: 'alarmContactType', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.eventDelay', { type: 'state', common: { name: 'eventDelay', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        return promises;
    }

    _createDeviceOperationLockChannel(device, channel) {
        let promises = [];
        promises.push(...this._createDeviceBaseChannel(device, channel));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.operationLockActive', { type: 'state', common: { name: 'operationLockActive', type: 'boolean', role: 'indicator', read: true, write: true }, native: {id: device.id, channel: channel, parameter: 'setOperationLock'} }));
        return promises;
    }

    _createDevicePermanentFullRxChannel(device, channel) {
        let promises = [];
        promises.push(...this._createDeviceBaseChannel(device, channel));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.permanentFullRx', { type: 'state', common: { name: 'permanentFullRx', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        return promises;
    }

    _createRotaryHandleChannel(device, channel) {
        let promises = [];
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.windowState', { type: 'state', common: { name: 'windowState', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.windowOpen', { type: 'state', common: { name: 'windowOpen', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.eventDelay', { type: 'state', common: { name: 'eventDelay', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        return promises;
    }

    _createBlindChannel(device, channel) {
        let promises = [];
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.stop', { type: 'state', common: { name: 'on', type: 'boolean', role: 'button', read: false, write: true }, native: { id: device.id, channel: channel, parameter: 'stop' } }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.previousShutterLevel', { type: 'state', common: { name: 'previousShutterLevel', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.processing', { type: 'state', common: { name: 'processing', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.selfCalibrationInProgress', { type: 'state', common: { name: 'selfCalibrationInProgress', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.topToBottomReferenceTime', { type: 'state', common: { name: 'topToBottomReferenceTime', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.bottomToTopReferenceTime', { type: 'state', common: { name: 'bottomToTopReferenceTime', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.changeOverDelay', { type: 'state', common: { name: 'changeOverDelay', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.supportingSelfCalibration', { type: 'state', common: { name: 'supportingSelfCalibration', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.endpositionAutoDetectionEnabled', { type: 'state', common: { name: 'endpositionAutoDetectionEnabled', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.supportingEndpositionAutoDetection', { type: 'state', common: { name: 'supportingEndpositionAutoDetection', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.delayCompensationValue', { type: 'state', common: { name: 'delayCompensationValue', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.supportingDelayCompensation', { type: 'state', common: { name: 'supportingDelayCompensation', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.profileMode', { type: 'state', common: { name: 'profileMode', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.userDesiredProfileMode', { type: 'state', common: { name: 'userDesiredProfileMode', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.previousSlatsLevel', { type: 'state', common: { name: 'previousSlatsLevel', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.slatsReferenceTime', { type: 'state', common: { name: 'slatsReferenceTime', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.blindModeActive', { type: 'state', common: { name: 'blindModeActive', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.slatsLevel', { type: 'state', common: { name: 'slatsLevel', type: 'number', role: 'value', read: true, write: true }, native: { id: device.id, channel: channel, parameter: 'slatsLevel' } }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.shutterLevel', { type: 'state', common: { name: 'shutterLevel', type: 'number', role: 'value', read: true, write: true }, native: { id: device.id, channel: channel, parameter: 'slatsLevel' } }));
        return promises;
    }

    _createMultiModeInputBlindChannel(device, channel) {
        let promises = [];
        promises.push(...this._createBlindChannel(device, channel));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.binaryBehaviorType', { type: 'state', common: { name: 'binaryBehaviorType', type: 'string', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.multiModeInputMode', { type: 'state', common: { name: 'multiModeInputMode', type: 'string', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.favoritePrimaryShadingPosition', { type: 'state', common: { name: 'favoritePrimaryShadingPosition', type: 'number', role: 'level', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.favoriteSecondaryShadingPosition', { type: 'state', common: { name: 'favoriteSecondaryShadingPosition', type: 'number', role: 'level', read: true, write: false }, native: {} }));
        return promises;
    }

    _createHeatingThermostatChannel(device, channel) {
        let promises = [];
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.temperatureOffset', { type: 'state', common: { name: 'temperatureOffset', type: 'number', role: 'value', unit: '°C', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.valvePosition', { type: 'state', common: { name: 'valvePosition', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.setPointTemperature', { type: 'state', common: { name: 'setPointTemperature', type: 'number', role: 'level.temperature', unit: '°C', read: true, write: true }, native: { id: device.functionalChannels[channel].groups, step: 0.5, debounce: 5000, parameter: 'setPointTemperature' } }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.valveActualTemperature', { type: 'state', common: { name: 'valveActualTemperature', type: 'number', role: 'value.temperature', unit: '°C', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.valveState', { type: 'state', common: { name: 'valveState', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        return promises;
    }

    _createShutterContactChannel(device, channel) {
        let promises = [];
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.windowState', { type: 'state', common: { name: 'windowState', type: 'string', role: 'sensor.window', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.windowOpen', { type: 'state', common: { name: 'windowOpen', type: 'boolean', role: 'sensor.window', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.eventDelay', { type: 'state', common: { name: 'eventDelay', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        return promises;
    }

    _createDimmerChannel(device, channel) {
        let promises = [];
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.dimLevel', { type: 'state', common: { name: 'dimLevel', type: 'number', role: 'level.dimmer', read: true, write: true }, native: { id: device.id, channel: channel, parameter: 'setDimLevel' } }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.on', { type: 'state', common: { name: 'on', type: 'boolean', role: 'switch', read: true, write: true }, native: { id: device.id, channel: channel, parameter: 'switchState' } }));
        return promises;
    }

    _createShadingChannel(device, channel) {
        let promises = [];
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.primaryShadingLevel', { type: 'state', common: { name: 'primaryShadingLevel', type: 'number', role: 'value', unit: '%', read: true, write: true }, native: {id: device.id, channel: channel, parameter: 'setPrimaryShadingLevel'} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.previousPrimaryShadingLevel', { type: 'state', common: { name: 'previousPrimaryShadingLevel', type: 'number', role: 'value', unit: '%', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.primaryShadingStateType', { type: 'state', common: { name: 'primaryShadingStateType', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.processing', { type: 'state', common: { name: 'processing', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.secondaryShadingLevel', { type: 'state', common: { name: 'secondaryShadingLevel', type: 'number', role: 'value', unit: '%', read: true, write: true }, native: {id: device.id, channel: channel, parameter: 'setSecondaryShadingLevel'} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.previousSecondaryShadingLevel', { type: 'state', common: { name: 'previousSecondaryShadingLevel', type: 'number', role: 'value', unit: '%', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.secondaryShadingStateType', { type: 'state', common: { name: 'secondaryShadingStateType', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.profileMode', { type: 'state', common: { name: 'profileMode', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.userDesiredProfileMode', { type: 'state', common: { name: 'userDesiredProfileMode', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.shadingPackagePosition', { type: 'state', common: { name: 'shadingPackagePosition', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.primaryOpenAdjustable', { type: 'state', common: { name: 'primaryOpenAdjustable', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.primaryCloseAdjustable', { type: 'state', common: { name: 'primaryCloseAdjustable', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.secondaryOpenAdjustable', { type: 'state', common: { name: 'secondaryOpenAdjustable', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.secondaryCloseAdjustable', { type: 'state', common: { name: 'secondaryCloseAdjustable', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.shadingPositionAdjustmentActive', { type: 'state', common: { name: 'shadingPositionAdjustmentActive', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.shadingPositionAdjustmentClientId', { type: 'state', common: { name: 'shadingPositionAdjustmentClientId', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.favoritePrimaryShadingPosition', { type: 'state', common: { name: 'favoritePrimaryShadingPosition', type: 'number', role: 'value', unit: '%', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.favoriteSecondaryShadingPosition', { type: 'state', common: { name: 'favoriteSecondaryShadingPosition', type: 'number', role: 'value', unit: '%', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.productId', { type: 'state', common: { name: 'productId', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.identifyOemSupported', { type: 'state', common: { name: 'identifyOemSupported', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.shadingDriveVersion', { type: 'state', common: { name: 'shadingDriveVersion', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.manualDriveSpeed', { type: 'state', common: { name: 'manualDriveSpeed', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.automationDriveSpeed', { type: 'state', common: { name: 'automationDriveSpeed', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        return promises;
    }

    _createTemperatureSensor2ExternalDeltaChannel(device, channel) {
        let promises = [];
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.temperatureExternalOne', { type: 'state', common: { name: 'temperatureExternalOne', type: 'number', role: 'value.temperature', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.temperatureExternalTwo', { type: 'state', common: { name: 'temperatureExternalTwo', type: 'number', role: 'value.temperature', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.temperatureExternalDelta', { type: 'state', common: { name: 'temperatureExternalDelta', type: 'number', role: 'value.temperature', read: true, write: false }, native: {} }));
        return promises;
    }

    _createWaterSensorChannel(device, channel) {
        let promises = [];
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.moistureDetected', { type: 'state', common: { name: 'moistureDetected', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.waterlevelDetected', { type: 'state', common: { name: 'waterlevelDetected', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.sirenWaterAlarmTrigger', { type: 'state', common: { name: 'sirenWaterAlarmTrigger', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.inAppWaterAlarmTrigger', { type: 'state', common: { name: 'inAppWaterAlarmTrigger', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.acousticAlarmSignal', { type: 'state', common: { name: 'acousticAlarmSignal', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.acousticAlarmTiming', { type: 'state', common: { name: 'acousticAlarmTiming', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.acousticWaterAlarmTrigger', { type: 'state', common: { name: 'acousticWaterAlarmTrigger', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        return promises;
    }

    _createWeatherSensorChannel(device, channel) {
        let promises = [];
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.actualTemperature', { type: 'state', common: { name: 'actualTemperature', type: 'number', role: 'value.temperature', read: true, write: false }, native: {} }));
	    promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.humidity', { type: 'state', common: { name: 'humidity', type: 'number', role: 'value.humidity', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.illumination', { type: 'state', common: { name: 'illumination', type: 'number', role: 'value.brightness', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.illuminationThresholdSunshine', { type: 'state', common: { name: 'illuminationThresholdSunshine', type: 'number', role: 'level', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.storm', { type: 'state', common: { name: 'storm', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.sunshine', { type: 'state', common: { name: 'sunshine', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.todaySunshineDuration', { type: 'state', common: { name: 'todaySunshineDuration', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.totalSunshineDuration', { type: 'state', common: { name: 'totalSunshineDuration', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.windSpeed', { type: 'state', common: { name: 'windSpeed', type: 'number', role: 'value.speed', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.windValueType', { type: 'state', common: { name: 'windValueType', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.yesterdaySunshineDuration', { type: 'state', common: { name: 'yesterdaySunshineDuration', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        return promises;
    }

    _createWeatherSensorPlusChannel(device, channel) {
        let promises = [];
        promises.push(...this._createWeatherSensorChannel(device, channel));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.raining', { type: 'state', common: { name: 'raining', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.todayRainCounter', { type: 'state', common: { name: 'todayRainCounter', type: 'number', role: 'value.rain.today', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.totalRainCounter', { type: 'state', common: { name: 'totalRainCounter', type: 'number', role: 'level', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.yesterdayRainCounter', { type: 'state', common: { name: 'yesterdayRainCounter', type: 'number', role: 'level', read: true, write: false }, native: {} }));
        return promises;
    }

    _createWeatherSensorProChannel(device, channel) {
        let promises = [];
        promises.push(...this._createWeatherSensorPlusChannel(device, channel));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.weathervaneAlignmentNeeded', { type: 'state', common: { name: 'weathervaneAlignmentNeeded', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.windDirection', { type: 'state', common: { name: 'windDirection', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.windDirectionVariation', { type: 'state', common: { name: 'windDirectionVariation', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.vaporAmount', { type: 'state', common: { name: 'vaporAmount', type: 'number', role: 'level', read: true, write: false }, native: {} }));
	  return promises;
    }

    _createShutterChannel(device, channel) {
        let promises = [];
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.stop', { type: 'state', common: { name: 'on', type: 'boolean', role: 'button', read: false, write: true }, native: { id: device.id, channel: channel, parameter: 'stop' } }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.shutterLevel', { type: 'state', common: { name: 'shutterLevel', type: 'number', role: 'level', read: true, write: true }, native: { id: device.id, channel: channel, parameter: 'shutterlevel' } }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.previousShutterLevel', { type: 'state', common: { name: 'previousShutterLevel', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.processing', { type: 'state', common: { name: 'processing', type: 'boolean', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.selfCalibrationInProgress', { type: 'state', common: { name: 'selfCalibrationInProgress', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.topToBottomReferenceTime', { type: 'state', common: { name: 'topToBottomReferenceTime', type: 'number', role: 'seconds', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.bottomToTopReferenceTime', { type: 'state', common: { name: 'bottomToTopReferenceTime', type: 'number', role: 'seconds', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.changeOverDelay', { type: 'state', common: { name: 'changeOverDelay', type: 'number', role: 'seconds', read: true, write: true }, native: { id: device.id, channel: channel, parameter: 'changeOverDelay' } }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.endpositionAutoDetectionEnabled', { type: 'state', common: { name: 'endpositionAutoDetectionEnabled', type: 'boolean', role: 'switch', read: true, write: true }, native: { id: device.id, channel: channel, parameter: 'switchState' } }));
        return promises;
    }

    _createSingleKeyChannel(device, channel) {
        let promises = [];
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.on', { type: 'state', common: { name: 'on', type: 'boolean', role: 'switch', read: true, write: true }, native: { } }));
        return promises;
    }

    _createSwitchChannel(device, channel) {
        let promises = [];
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.on', { type: 'state', common: { name: 'on', type: 'boolean', role: 'switch', read: true, write: true }, native: { id: device.id, channel: channel, parameter: 'switchState' } }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.profileMode', { type: 'state', common: { name: 'profileMode', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.userDesiredProfileMode', { type: 'state', common: { name: 'userDesiredProfileMode', type: 'string', role: 'button', read: false, write: true }, native: { id: device.id, channel: channel, parameter: 'resetEnergyCounter' } }));
        return promises;
    }

    _createSwitchMeasuringChannel(device, channel) {
        let promises = [];
        promises.push(...this._createSwitchChannel(device, channel));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.energyCounter', { type: 'state', common: { name: 'energyCounter', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.currentPowerConsumption', { type: 'state', common: { name: 'currentPowerConsumption', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.resetEnergyCounter', { type: 'state', common: { name: 'on', type: 'boolean', role: 'button', read: false, write: true }, native: { id: device.id, channel: channel, parameter: 'resetEnergyCounter' } }));
        return promises;
    }

    _createClimateSensorChannel(device, channel) {
        let promises = [];
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.actualTemperature', { type: 'state', common: { name: 'actualTemperature', type: 'number', role: 'value.temperature', unit: '°C', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.humidity', { type: 'state', common: { name: 'humidity', type: 'number', role: 'value.humidity', unit: '%', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.vaporAmount', { type: 'state', common: { name: 'vaporAmount', type: 'number', role: 'level', read: true, write: false }, native: {} }));
        return promises;
    }

    _createWallMountedThermostatWithoutDisplay(device, channel) {
        let promises = [];
        promises.push(...this._createClimateSensorChannel(device, channel));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.temperatureOffset', { type: 'state', common: { name: 'temperatureOffset', type: 'number', role: 'value', unit: '°C', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.setPointTemperature', { type: 'state', common: { name: 'setPointTemperature', type: 'number', role: 'level.temperature', unit: '°C', read: true, write: true }, native: { id: device.functionalChannels[channel].groups, step: 0.5, debounce: 5000, parameter: 'setPointTemperature' } }));
        return promises;
    }

    _createCarbonDioxideSensorChannel(device, channel) {
        let promises = [];
        promises.push(...this._createClimateSensorChannel(device, channel));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.carbonDioxideVisualisationEnabled', { type: 'state', common: { name: 'carbonDioxideVisualisationEnabled', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.carbonDioxideConcentration', { type: 'state', common: { name: 'carbonDioxideConcentration', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        return promises;
    }

    _createAnalogRoomControlChannel(device, channel) {
        let promises = [];
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.actualTemperature', { type: 'state', common: { name: 'actualTemperature', type: 'number', role: 'value.temperature', unit: '°C', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.temperatureOffset', { type: 'state', common: { name: 'temperatureOffset', type: 'number', role: 'value', unit: '°C', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.setPointTemperature', { type: 'state', common: { name: 'setPointTemperature', type: 'number', role: 'level.temperature', unit: '°C', read: true, write: true }, native: { id: device.functionalChannels[channel].groups, step: 0.5, debounce: 5000, parameter: 'setPointTemperature' } }));
        return promises;
    }

    _createWallMountedThermostatProChannel(device, channel) {
        let promises = [];
        promises.push(...this._createWallMountedThermostatWithoutDisplay(device, channel));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.display', { type: 'state', common: { name: 'display', type: 'string', role: 'text', read: true, write: true }, native: {id: device.id, channel: channel, parameter: 'setClimateControlDisplay'} }));
        return promises;
    }

    _createAlarmSirenChannel(device, channel) {
        let promises = [];
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.on', { type: 'state', common: { name: 'on', type: 'boolean', role: 'switch', read: true, write: true }, native: { id: device.id, channel: channel, parameter: 'switchState' } }));
        return promises;
    }

    _createMotionDetectionChannel(device, channel) {
        let promises = [];
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.motionDetected', { type: 'state', common: { name: 'motionDetected', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.illumination', { type: 'state', common: { name: 'illumination', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.currentIllumination', { type: 'state', common: { name: 'currentIllumination', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.motionDetectionSendInterval', { type: 'state', common: { name: 'motionDetectionSendInterval', type: 'string', role: 'text', read: false, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.motionBufferActive', { type: 'state', common: { name: 'motionBufferActive', type: 'boolean', role: 'switch', read: false, write: true }, native: { id: device.id, channel: channel, parameter: 'switchState' } }));
        promises.push(this.extendObjectAsync('devices.' + device.id + '.channels.' + channel + '.numberOfBrightnessMeasurements', { type: 'state', common: { name: 'numberOfBrightnessMeasurements', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        return promises;
    }

    /* End Channel Types */

    _createObjectsForGroup(group) {
        this.log.silly("createObjectsForGroup - " + JSON.stringify(group));
        let promises = [];
        promises.push(this.extendObjectAsync('groups.' + group.id, { type: 'device', common: { name: group.label }, native: {} }));
        promises.push(this.extendObjectAsync('groups.' + group.id + '.info.type', { type: 'state', common: { name: 'type', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('groups.' + group.id + '.info.label', { type: 'state', common: { name: 'label', type: 'string', role: 'text', read: true, write: false }, native: {} }));

        switch (group.type) {
            case 'HEATING': {
                promises.push(this.extendObjectAsync('groups.' + group.id + '.windowOpenTemperature', { type: 'state', common: { name: 'windowOpenTemperature', type: 'number', role: 'value', unit: '°C', read: true, write: false }, native: {} }));
                promises.push(this.extendObjectAsync('groups.' + group.id + '.setPointTemperature', { type: 'state', common: { name: 'setPointTemperature', type: 'number', role: 'level.temperature', unit: '°C', read: true, write: true }, native: { id: [group.id], step: 0.5, debounce: 5000, parameter: 'setPointTemperature' } }));
                promises.push(this.extendObjectAsync('groups.' + group.id + '.minTemperature', { type: 'state', common: { name: 'minTemperature', type: 'number', role: 'value', unit: '°C', read: true, write: false }, native: {} }));
                promises.push(this.extendObjectAsync('groups.' + group.id + '.maxTemperature', { type: 'state', common: { name: 'maxTemperature', type: 'number', role: 'value', unit: '°C', read: true, write: false }, native: {} }));
                promises.push(this.extendObjectAsync('groups.' + group.id + '.windowState', { type: 'state', common: { name: 'windowState', type: 'string', role: 'value', read: true, write: false }, native: {} }));
                promises.push(this.extendObjectAsync('groups.' + group.id + '.cooling', { type: 'state', common: { name: 'cooling', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
                promises.push(this.extendObjectAsync('groups.' + group.id + '.partyMode', { type: 'state', common: { name: 'partyMode', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
                promises.push(this.extendObjectAsync('groups.' + group.id + '.controlMode', { type: 'state', common: { name: 'controlMode', type: 'string', role: 'text', read: true, write: true }, native:  { id: [group.id], parameter: 'setControlMode' } }));
                promises.push(this.extendObjectAsync('groups.' + group.id + '.boostMode', { type: 'state', common: { name: 'boostMode', type: 'boolean', role: 'switch', read: true, write: true }, native:  { id: [group.id], parameter: 'setBoost' } }));
                promises.push(this.extendObjectAsync('groups.' + group.id + '.activeProfile', { type: 'state', common: { name: 'activeProfile', type: 'string', role: 'text', read: true, write: true }, native:  { id: [group.id], parameter: 'setActiveProfile' } }));
                promises.push(this.extendObjectAsync('groups.' + group.id + '.boostDuration', { type: 'state', common: { name: 'boostDuration', type: 'number', role: 'value', unit: 'min', read: true, write: false }, native: {} }));
                promises.push(this.extendObjectAsync('groups.' + group.id + '.actualTemperature', { type: 'state', common: { name: 'actualTemperature', type: 'number', role: 'value.temperature', unit: '°C', read: true, write: false }, native: {} }));
                promises.push(this.extendObjectAsync('groups.' + group.id + '.humidity', { type: 'state', common: { name: 'humidity', type: 'number', role: 'value.humidity', unit: '%', read: true, write: false }, native: {} }));
                promises.push(this.extendObjectAsync('groups.' + group.id + '.coolingAllowed', { type: 'state', common: { name: 'coolingAllowed', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
                promises.push(this.extendObjectAsync('groups.' + group.id + '.coolingIgnored', { type: 'state', common: { name: 'coolingIgnored', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
                promises.push(this.extendObjectAsync('groups.' + group.id + '.ecoAllowed', { type: 'state', common: { name: 'ecoAllowed', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
                promises.push(this.extendObjectAsync('groups.' + group.id + '.ecoIgnored', { type: 'state', common: { name: 'ecoIgnored', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
                promises.push(this.extendObjectAsync('groups.' + group.id + '.controllable', { type: 'state', common: { name: 'controllable', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
                promises.push(this.extendObjectAsync('groups.' + group.id + '.floorHeatingMode', { type: 'state', common: { name: 'floorHeatingMode', type: 'string', role: 'text', read: true, write: false }, native: {} }));
                promises.push(this.extendObjectAsync('groups.' + group.id + '.humidityLimitEnabled', { type: 'state', common: { name: 'humidityLimitEnabled', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
                promises.push(this.extendObjectAsync('groups.' + group.id + '.humidityLimitValue', { type: 'state', common: { name: 'humidityLimitValue', type: 'number', role: 'value', unit: '%', read: true, write: false }, native: {} }));
                promises.push(this.extendObjectAsync('groups.' + group.id + '.externalClockEnabled', { type: 'state', common: { name: 'externalClockEnabled', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
                promises.push(this.extendObjectAsync('groups.' + group.id + '.externalClockHeatingTemperature', { type: 'state', common: { name: 'externalClockHeatingTemperature', type: 'number', role: 'value', unit: '°C', read: true, write: false }, native: {} }));
                promises.push(this.extendObjectAsync('groups.' + group.id + '.externalClockCoolingTemperature', { type: 'state', common: { name: 'externalClockCoolingTemperature', type: 'number', role: 'value', unit: '°C', read: true, write: false }, native: {} }));
                promises.push(this.extendObjectAsync('groups.' + group.id + '.valvePosition', { type: 'state', common: { name: 'valvePosition', type: 'number', role: 'value', read: true, write: false }, native: {} }));
                promises.push(this.extendObjectAsync('groups.' + group.id + '.sabotage', { type: 'state', common: { name: 'sabotage', type: 'boolean', role: 'indicator.alarm', read: true, write: false }, native: {} }));
                break;
            }
            case 'ALARM_SWITCHING': {
                promises.push(this.extendObjectAsync('groups.' + group.id + '.setOnTime', { type: 'state', common: { name: 'setOnTime', type: 'string', role: 'text', read: true, write: true }, native: { id: [group.id], parameter: 'setOnTime' } }));
                promises.push(this.extendObjectAsync('groups.' + group.id + '.testSignalOptical', { type: 'state', common: { name: 'testSignalOptical', type: 'string', role: 'text', read: true, write: true, states: { DISABLE_OPTICAL_SIGNAL: 'DISABLE_OPTICAL_SIGNAL', BLINKING_ALTERNATELY_REPEATING: 'BLINKING_ALTERNATELY_REPEATING', BLINKING_BOTH_REPEATING: 'BLINKING_BOTH_REPEATING', DOUBLE_FLASHING_REPEATING: 'DOUBLE_FLASHING_REPEATING', FLASHING_BOTH_REPEATING: 'FLASHING_BOTH_REPEATING', CONFIRMATION_SIGNAL_0: 'CONFIRMATION_SIGNAL_0', CONFIRMATION_SIGNAL_1: 'CONFIRMATION_SIGNAL_1', CONFIRMATION_SIGNAL_2: 'CONFIRMATION_SIGNAL_2' } }, native: { id: [group.id], parameter: 'testSignalOptical' } }));
                promises.push(this.extendObjectAsync('groups.' + group.id + '.setSignalOptical', { type: 'state', common: { name: 'setSignalOptical', type: 'string', role: 'text', read: true, write: true, states: { DISABLE_OPTICAL_SIGNAL: 'DISABLE_OPTICAL_SIGNAL', BLINKING_ALTERNATELY_REPEATING: 'BLINKING_ALTERNATELY_REPEATING', BLINKING_BOTH_REPEATING: 'BLINKING_BOTH_REPEATING', DOUBLE_FLASHING_REPEATING: 'DOUBLE_FLASHING_REPEATING', FLASHING_BOTH_REPEATING: 'FLASHING_BOTH_REPEATING', CONFIRMATION_SIGNAL_0: 'CONFIRMATION_SIGNAL_0', CONFIRMATION_SIGNAL_1: 'CONFIRMATION_SIGNAL_1', CONFIRMATION_SIGNAL_2: 'CONFIRMATION_SIGNAL_2' } }, native: { id: [group.id], parameter: 'setSignalOptical' } }));
                promises.push(this.extendObjectAsync('groups.' + group.id + '.testSignalAcoustic', { type: 'state', common: { name: 'testSignalAcoustic', type: 'string', role: 'text', read: true, write: true, states: { DISABLE_ACOUSTIC_SIGNAL: 'DISABLE_ACOUSTIC_SIGNAL', FREQUENCY_RISING: 'FREQUENCY_RISING', FREQUENCY_FALLING: 'FREQUENCY_FALLING', FREQUENCY_RISING_AND_FALLING: 'FREQUENCY_RISING_AND_FALLING', FREQUENCY_ALTERNATING_LOW_HIGH: 'FREQUENCY_ALTERNATING_LOW_HIGH', FREQUENCY_ALTERNATING_LOW_MID_HIGH: 'FREQUENCY_ALTERNATING_LOW_MID_HIGH', FREQUENCY_HIGHON_OFF: 'FREQUENCY_HIGHON_OFF', FREQUENCY_HIGHON_LONGOFF: 'FREQUENCY_HIGHON_LONGOFF', FREQUENCY_LOWON_OFF_HIGHON_OFF: 'FREQUENCY_LOWON_OFF_HIGHON_OFF', FREQUENCY_LOWON_LONGOFF_HIGHON_LONGOFF: 'FREQUENCY_LOWON_LONGOFF_HIGHON_LONGOFF', LOW_BATTERY: 'LOW_BATTERY', DISARMED: 'DISARMED', INTERNALLY_ARMED: 'INTERNALLY_ARMED', EXTERNALLY_ARMED: 'EXTERNALLY_ARMED', DELAYED_INTERNALLY_ARMED: 'DELAYED_INTERNALLY_ARMED', DELAYED_EXTERNALLY_ARMED: 'DELAYED_EXTERNALLY_ARMED', EVENT: 'EVENT', ERROR: 'ERROR' } }, native: { id: [group.id], parameter: 'testSignalAcoustic' } }));
                promises.push(this.extendObjectAsync('groups.' + group.id + '.setSignalAcoustic', { type: 'state', common: { name: 'setSignalAcoustic', type: 'string', role: 'text', read: true, write: true, states: { DISABLE_ACOUSTIC_SIGNAL: 'DISABLE_ACOUSTIC_SIGNAL', FREQUENCY_RISING: 'FREQUENCY_RISING', FREQUENCY_FALLING: 'FREQUENCY_FALLING', FREQUENCY_RISING_AND_FALLING: 'FREQUENCY_RISING_AND_FALLING', FREQUENCY_ALTERNATING_LOW_HIGH: 'FREQUENCY_ALTERNATING_LOW_HIGH', FREQUENCY_ALTERNATING_LOW_MID_HIGH: 'FREQUENCY_ALTERNATING_LOW_MID_HIGH', FREQUENCY_HIGHON_OFF: 'FREQUENCY_HIGHON_OFF', FREQUENCY_HIGHON_LONGOFF: 'FREQUENCY_HIGHON_LONGOFF', FREQUENCY_LOWON_OFF_HIGHON_OFF: 'FREQUENCY_LOWON_OFF_HIGHON_OFF', FREQUENCY_LOWON_LONGOFF_HIGHON_LONGOFF: 'FREQUENCY_LOWON_LONGOFF_HIGHON_LONGOFF', LOW_BATTERY: 'LOW_BATTERY', DISARMED: 'DISARMED', INTERNALLY_ARMED: 'INTERNALLY_ARMED', EXTERNALLY_ARMED: 'EXTERNALLY_ARMED', DELAYED_INTERNALLY_ARMED: 'DELAYED_INTERNALLY_ARMED', DELAYED_EXTERNALLY_ARMED: 'DELAYED_EXTERNALLY_ARMED', EVENT: 'EVENT', ERROR: 'ERROR' } }, native: { id: [group.id], parameter: 'setSignalAcoustic' } }));
                break;
            }
            case 'SWITCHING': {
                promises.push(this.extendObjectAsync('groups.' + group.id + '.on', { type: 'state', common: { name: 'on', type: 'boolean', role: 'switch', read: true, write: true }, native: { } }));
                break;
            }
            case 'SECURITY_ZONE' : {
                promises.push(this.extendObjectAsync('groups.' + group.id + '.active', { type: 'state', common: { name: 'active', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
                break;
            }
        }

        return Promise.all(promises);
    }

    _createObjectsForClient(client) {
        this.log.silly("createObjectsForClient - " + JSON.stringify(client));
        let promises = [];
        promises.push(this.extendObjectAsync('clients.' + client.id, { type: 'device', common: { name: client.label }, native: {} }));
        promises.push(this.extendObjectAsync('clients.' + client.id + '.info.label', { type: 'state', common: { name: 'label', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        return Promise.all(promises);
    }

    _createObjectsForHome(home) {
        this.log.silly("createObjectsForHome - " + JSON.stringify(home));
        let promises = [];
        promises.push(this.extendObjectAsync('homes.' + home.id, { type: 'device', common: {}, native: {} }));

        promises.push(this.extendObjectAsync('homes.' + home.id + '.weather.temperature', { type: 'state', common: { name: 'temperature', type: 'number', role: 'value.temperature', unit: '°C', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.weather.weatherCondition', { type: 'state', common: { name: 'weatherCondition', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.weather.weatherDayTime', { type: 'state', common: { name: 'weatherDayTime', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.weather.minTemperature', { type: 'state', common: { name: 'minTemperature', type: 'number', role: 'value.temperature.min', unit: '°C', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.weather.maxTemperature', { type: 'state', common: { name: 'maxTemperature', type: 'number', role: 'value.temperature.max', unit: '°C', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.weather.humidity', { type: 'state', common: { name: 'humidity', type: 'number', role: 'value.humidity', unit: '%', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.weather.windSpeed', { type: 'state', common: { name: 'windSpeed', type: 'number', role: 'value.speed.wind', unit: 'km/h', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.weather.windDirection', { type: 'state', common: { name: 'windDirection', type: 'number', role: 'value.direction.wind',unit: '°', read: true, write: false }, native: {} }));

        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.alarmEventTimestamp', { type: 'state', common: { name: 'alarmEventTimestamp', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.alarmEventDeviceId', { type: 'state', common: { name: 'alarmEventDeviceId', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.alarmEventTriggerId', { type: 'state', common: { name: 'alarmEventTriggerId', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.alarmEventDeviceChannel', { type: 'state', common: { name: 'alarmEventDeviceChannel', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.alarmSecurityJournalEntryType', { type: 'state', common: { name: 'alarmSecurityJournalEntryType', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.alarmActive', { type: 'state', common: { name: 'alarmActive', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.zoneActivationDelay', { type: 'state', common: { name: 'zoneActivationDelay', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.intrusionAlertThroughSmokeDetectors', { type: 'state', common: { name: 'intrusionAlertThroughSmokeDetectors', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.securityZoneActivationMode', { type: 'state', common: { name: 'securityZoneActivationMode', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.solution', { type: 'state', common: { name: 'solution', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.activationInProgress', { type: 'state', common: { name: 'activationInProgress', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.active', { type: 'state', common: { name: 'active', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));

        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.setOnTime', { type: 'state', common: { name: 'setOnTime', type: 'string', role: 'text', read: true, write: true }, native: { id: home.functionalHomes.SECURITY_AND_ALARM.functionalGroups, parameter: 'setOnTime' } }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.testSignalOptical', { type: 'state', common: { name: 'testSignalOptical', type: 'string', role: 'text', read: true, write: true, states: { DISABLE_OPTICAL_SIGNAL: 'DISABLE_OPTICAL_SIGNAL', BLINKING_ALTERNATELY_REPEATING: 'BLINKING_ALTERNATELY_REPEATING', BLINKING_BOTH_REPEATING: 'BLINKING_BOTH_REPEATING', DOUBLE_FLASHING_REPEATING: 'DOUBLE_FLASHING_REPEATING', FLASHING_BOTH_REPEATING: 'FLASHING_BOTH_REPEATING', CONFIRMATION_SIGNAL_0: 'CONFIRMATION_SIGNAL_0', CONFIRMATION_SIGNAL_1: 'CONFIRMATION_SIGNAL_1', CONFIRMATION_SIGNAL_2: 'CONFIRMATION_SIGNAL_2' } }, native: { id: home.functionalHomes.SECURITY_AND_ALARM.securitySwitchingGroups, parameter: 'testSignalOptical' } }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.setSignalOptical', { type: 'state', common: { name: 'setSignalOptical', type: 'string', role: 'text', read: true, write: true, states: { DISABLE_OPTICAL_SIGNAL: 'DISABLE_OPTICAL_SIGNAL', BLINKING_ALTERNATELY_REPEATING: 'BLINKING_ALTERNATELY_REPEATING', BLINKING_BOTH_REPEATING: 'BLINKING_BOTH_REPEATING', DOUBLE_FLASHING_REPEATING: 'DOUBLE_FLASHING_REPEATING', FLASHING_BOTH_REPEATING: 'FLASHING_BOTH_REPEATING', CONFIRMATION_SIGNAL_0: 'CONFIRMATION_SIGNAL_0', CONFIRMATION_SIGNAL_1: 'CONFIRMATION_SIGNAL_1', CONFIRMATION_SIGNAL_2: 'CONFIRMATION_SIGNAL_2' } }, native: { id: home.functionalHomes.SECURITY_AND_ALARM.securitySwitchingGroups, parameter: 'setSignalOptical' } }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.testSignalAcoustic', { type: 'state', common: { name: 'testSignalAcoustic', type: 'string', role: 'text', read: true, write: true, states: { DISABLE_ACOUSTIC_SIGNAL: 'DISABLE_ACOUSTIC_SIGNAL', FREQUENCY_RISING: 'FREQUENCY_RISING', FREQUENCY_FALLING: 'FREQUENCY_FALLING', FREQUENCY_RISING_AND_FALLING: 'FREQUENCY_RISING_AND_FALLING', FREQUENCY_ALTERNATING_LOW_HIGH: 'FREQUENCY_ALTERNATING_LOW_HIGH', FREQUENCY_ALTERNATING_LOW_MID_HIGH: 'FREQUENCY_ALTERNATING_LOW_MID_HIGH', FREQUENCY_HIGHON_OFF: 'FREQUENCY_HIGHON_OFF', FREQUENCY_HIGHON_LONGOFF: 'FREQUENCY_HIGHON_LONGOFF', FREQUENCY_LOWON_OFF_HIGHON_OFF: 'FREQUENCY_LOWON_OFF_HIGHON_OFF', FREQUENCY_LOWON_LONGOFF_HIGHON_LONGOFF: 'FREQUENCY_LOWON_LONGOFF_HIGHON_LONGOFF', LOW_BATTERY: 'LOW_BATTERY', DISARMED: 'DISARMED', INTERNALLY_ARMED: 'INTERNALLY_ARMED', EXTERNALLY_ARMED: 'EXTERNALLY_ARMED', DELAYED_INTERNALLY_ARMED: 'DELAYED_INTERNALLY_ARMED', DELAYED_EXTERNALLY_ARMED: 'DELAYED_EXTERNALLY_ARMED', EVENT: 'EVENT', ERROR: 'ERROR' } }, native: { id: home.functionalHomes.SECURITY_AND_ALARM.securitySwitchingGroups, parameter: 'testSignalAcoustic' } }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.setSignalAcoustic', { type: 'state', common: { name: 'setSignalAcoustic', type: 'string', role: 'text', read: true, write: true, states: { DISABLE_ACOUSTIC_SIGNAL: 'DISABLE_ACOUSTIC_SIGNAL', FREQUENCY_RISING: 'FREQUENCY_RISING', FREQUENCY_FALLING: 'FREQUENCY_FALLING', FREQUENCY_RISING_AND_FALLING: 'FREQUENCY_RISING_AND_FALLING', FREQUENCY_ALTERNATING_LOW_HIGH: 'FREQUENCY_ALTERNATING_LOW_HIGH', FREQUENCY_ALTERNATING_LOW_MID_HIGH: 'FREQUENCY_ALTERNATING_LOW_MID_HIGH', FREQUENCY_HIGHON_OFF: 'FREQUENCY_HIGHON_OFF', FREQUENCY_HIGHON_LONGOFF: 'FREQUENCY_HIGHON_LONGOFF', FREQUENCY_LOWON_OFF_HIGHON_OFF: 'FREQUENCY_LOWON_OFF_HIGHON_OFF', FREQUENCY_LOWON_LONGOFF_HIGHON_LONGOFF: 'FREQUENCY_LOWON_LONGOFF_HIGHON_LONGOFF', LOW_BATTERY: 'LOW_BATTERY', DISARMED: 'DISARMED', INTERNALLY_ARMED: 'INTERNALLY_ARMED', EXTERNALLY_ARMED: 'EXTERNALLY_ARMED', DELAYED_INTERNALLY_ARMED: 'DELAYED_INTERNALLY_ARMED', DELAYED_EXTERNALLY_ARMED: 'DELAYED_EXTERNALLY_ARMED', EVENT: 'EVENT', ERROR: 'ERROR' } }, native: { id: home.functionalHomes.SECURITY_AND_ALARM.securitySwitchingGroups, parameter: 'setSignalAcoustic' } }));

        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.setIntrusionAlertThroughSmokeDetectors', { type: 'state', common: { name: 'setIntrusionAlertThroughSmokeDetectors', type: 'boolean', role: 'button', read: false, write: true }, native: { parameter: 'setIntrusionAlertThroughSmokeDetectors' } }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.setSecurityZonesActivationNone', { type: 'state', common: { name: 'setSecurityZonesActivationNone', type: 'boolean', role: 'button', read: false, write: true }, native: { parameter: 'setSecurityZonesActivationNone' } }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.setSecurityZonesActivationInternal', { type: 'state', common: { name: 'setSecurityZonesActivationInternal', type: 'boolean', role: 'button', read: false, write: true }, native: { parameter: 'setSecurityZonesActivationInternal' } }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.setSecurityZonesActivationExternal', { type: 'state', common: { name: 'setSecurityZonesActivationExternal', type: 'boolean', role: 'button', read: false, write: true }, native: { parameter: 'setSecurityZonesActivationExternal' } }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.securityAndAlarm.setSecurityZonesActivationInternalAndExternal', { type: 'state', common: { name: 'setSecurityZonesActivationInternalAndExternal', type: 'boolean', role: 'button', read: false, write: true }, native: { parameter: 'setSecurityZonesActivationInternalAndExternal' } }));

        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.indoorClimate.absenceType', { type: 'state', common: { name: 'absenceType', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.indoorClimate.absenceEndTime', { type: 'state', common: { name: 'absenceEndTime', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.indoorClimate.ecoTemperature', { type: 'state', common: { name: 'ecoTemperature', type: 'number', role: 'value', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.indoorClimate.coolingEnabled', { type: 'state', common: { name: 'coolingEnabled', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.indoorClimate.ecoDuration', { type: 'state', common: { name: 'ecoDuration', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.indoorClimate.optimumStartStopEnabled', { type: 'state', common: { name: 'optimumStartStopEnabled', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.indoorClimate.solution', { type: 'state', common: { name: 'solution', type: 'string', role: 'text', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.indoorClimate.active', { type: 'state', common: { name: 'active', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));

        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.indoorClimate.vacationTemperature', { type: 'state', common: { name: 'vacationTemperature', type: 'number', role: 'level', read: true, write: false }, native: {} }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.indoorClimate.activateVacationWithEndTime', { type: 'state', common: { name: 'activateVacationWithEndTime', type: 'string', role: 'text', read: false, write: true }, native: { id: home.id, parameter: 'activateVacation' } }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.indoorClimate.deactivateVacation', { type: 'state', common: { name: 'deactivateVacation', type: 'boolean', role: 'button', read: false, write: true }, native: { parameter: 'deactivateVacation' } }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.indoorClimate.setAbsenceEndTime', { type: 'state', common: { name: 'setAbsenceEndTime', type: 'string', role: 'text', read: false, write: true }, native: { parameter: 'setAbsenceEndTime' } }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.indoorClimate.setAbsenceDuration', { type: 'state', common: { name: 'setAbsenceDuration', type: 'string', role: 'text', read: false, write: true }, native: { parameter: 'setAbsenceDuration' } }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.indoorClimate.deactivateAbsence', { type: 'state', common: { name: 'deactivateAbsence', type: 'boolean', role: 'button', read: false, write: true }, native: { parameter: 'deactivateAbsence' } }));
        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.indoorClimate.activateAbsencePermanent', { type: 'state', common: { name: 'activateAbsencePermanent', type: 'boolean', role: 'button', read: false, write: true }, native: { parameter: 'setAbsencePermanent' } }));

        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.lightAndShadow.active', { type: 'state', common: { name: 'active', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));

        promises.push(this.extendObjectAsync('homes.' + home.id + '.functionalHomes.weatherAndEnvironment.active', { type: 'state', common: { name: 'active', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} }));

        return Promise.all(promises);
    }
}

// If started as allInOne/compact mode => return function to create instance
if (module && module.parent) {
    module.exports = (options) => new HmIpCloudAccesspointAdapter(options);
} else {
    // or start the instance directly
    new HmIpCloudAccesspointAdapter();
}

