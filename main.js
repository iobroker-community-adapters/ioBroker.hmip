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
            await this._api.auth1connectionRequest();
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
                this.log.error('error starting homematic: ' + err);
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
        this.log.debug('createObjectsForHome');
        await this._createObjectsForHome();
        this.log.debug('connectWebsocket');
        this._api.connectWebsocket();
        this.log.debug('updateDeviceStates');
        let promises = [];
        for (let d in this._api.devices) {
            promises.push(...this._updateDeviceStates(this._api.devices[d]));
        }
        for (let g in this._api.groups) {
            promises.push(...this._updateGroupStates(this._api.groups[g]));
        }
        for (let c in this._api.clients) {
            promises.push(...this._updateClientStates(this._api.clients[c]));
        }
        promises.push(...this._updateHomeStates(this._api.home));
        await Promise.all(promises);

        this.log.debug('subscribeStates');
        this.subscribeStates('*');

        this.setState('info.connection', true, true);
        this.log.info('hmip adapter connected and ready');
    }

    async _stateChange(id, state) {
        if (!id || !state || state.ack) return;

        let o = await this.getObjectAsync(id);
        if (o.native.parameter) {
            this.log.info('state change - ' + o.native.parameter + ' - id ' + o.native.id + ' - value ' + state.val);
            switch (o.native.parameter) {
                case 'switchState':
                    this._api.deviceControlSetSwitchState(o.native.id, state.val, o.native.channel)
                    break;
                case 'resetEnergyCounter':
                    this._api.deviceControlResetEnergyCounter(o.native.id, o.native.channel)
                    break;
                case 'shutterlevel':
                    this._api.deviceControlSetShutterLevel(o.native.id, state.val, o.native.channel)
                    break;
                case 'setPointTemperature':
                    for (let id of o.native.id)
                        this._api.groupHeatingSetPointTemperature(id, state.val);
                    break;
                case 'changeOverDelay':
                    //this._api.deviceConfigurationChangeOverDelay(o.native.id, state.val, o.native.channel)
                    break;
            }
        }
    }

    async _eventRaised(ev) {
        switch (ev.pushEventType) {
            case 'DEVICE_ADDED':
                await Promise.all(this._createObjectsForDevice(ev.device));
                await Promise.all(this._updateDeviceStates(ev.device));
                break;
            case 'DEVICE_CHANGED':
                await Promise.all(this._updateDeviceStates(ev.device));
                break;
            case 'GROUP_ADDED':
                await Promise.all(this._createObjectsForGroup(ev.group));
                await Promise.all(this._updateGroupStates(ev.group));
                break;
            case 'GROUP_CHANGED':
                await Promise.all(this._updateGroupStates(ev.group));
                break;
            case 'CLIENT_ADDED':
                await Promise.all(this._createObjectsForClient(ev.client));
                await Promise.all(this._updateClientStates(ev.client));
                break;
            case 'CLIENT_CHANGED':
                await Promise.all(this._updateClientStates(ev.client));
                break;
            case 'DEVICE_REMOVED':
                break;
            case 'GROUP_REMOVED':
                break;
            case 'CLIENT_REMOVED':
                break;
            case 'HOME_CHANGED':
                await Promise.all(this._updateHomeStates(ev.home));
                break;
        }
    }

    _updateDeviceStates(device) {
        this.log.silly("updateDeviceStates - " + device.type + " - " + JSON.stringify(device));
        let promises = [];
        promises.push(this.setStateAsync('devices.' + device.id + '.info.type', device.type, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.info.modelType', device.modelType, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.info.label', device.label, true));
        switch (device.type) {
            case 'FULL_FLUSH_SWITCH_MEASURING':
            case 'PLUGABLE_SWITCH_MEASURING': {
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.on', device.functionalChannels['1'].on, true));
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.energyCounter', device.functionalChannels['1'].energyCounter, true));
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.currentPowerConsumption', device.functionalChannels['1'].currentPowerConsumption, true));
                break;
            }
            case 'PLUGABLE_SWITCH': {
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.on', device.functionalChannels['1'].on, true));
                break;
            }
            case 'BRAND_WALL_MOUNTED_THERMOSTAT':
            case 'WALL_MOUNTED_THERMOSTAT_PRO':
            case 'TEMPERATURE_HUMIDITY_SENSOR_DISPLAY': {
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.temperatureOffset', device.functionalChannels['1'].temperatureOffset, true));
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.actualTemperature', device.functionalChannels['1'].actualTemperature, true));
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.setPointTemperature', device.functionalChannels['1'].setPointTemperature, true));
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.display', device.functionalChannels['1'].display, true));
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.humidity', device.functionalChannels['1'].humidity, true));
                break;
            }
            case 'HEATING_THERMOSTAT': {
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.temperatureOffset', device.functionalChannels['1'].temperatureOffset, true));
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.valvePosition', device.functionalChannels['1'].actualTemperature, true));
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.setPointTemperature', device.functionalChannels['1'].setPointTemperature, true));
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.valveState', device.functionalChannels['1'].display, true));
                break;
            }
            case 'SHUTTER_CONTACT':
            case 'SHUTTER_CONTACT_MAGNETIC': {
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.windowState', device.functionalChannels['1'].windowState == 'OPEN' ? 'open' : 'close', true));
                break;
            }
            case 'PUSH_BUTTON':
            case 'PUSH_BUTTON_6':
            case 'OPEN_COLLECTOR_8_MODULE':
            case 'REMOTE_CONTROL_8': {
                let max = 1;
                for (let i in device.functionalChannels) {
                    if (i != 0)
                        promises.push(this.setStateAsync('devices.' + device.id + '.channels.' + i + '.on', device.functionalChannels[i].on, true));
                }
                break;
            }
            case 'BRAND_SHUTTER': {
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.shutterLevel', device.functionalChannels['1'].shutterLevel, true));
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.previousShutterLevel', device.functionalChannels['1'].previousShutterLevel, true));
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.processing', device.functionalChannels['1'].processing, true));
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.selfCalibrationInProgress', device.functionalChannels['1'].selfCalibrationInProgress, true));
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.topToBottomReferenceTime', device.functionalChannels['1'].topToBottomReferenceTime, true));
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.bottomToTopReferenceTime', device.functionalChannels['1'].bottomToTopReferenceTime, true));
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.changeOverDelay', device.functionalChannels['1'].changeOverDelay, true));
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.endpositionAutoDetectionEnabled', device.functionalChannels['1'].endpositionAutoDetectionEnabled, true));
                break;
            }
            case 'MOTION_DETECTOR_INDOOR': {
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.motionDetected', device.functionalChannels['1'].motionDetected, true));
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.illumination', device.functionalChannels['1'].illumination, true));
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.currentIllumination', device.functionalChannels['1'].currentIllumination, true));
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.motionDetectionSendInterval', device.functionalChannels['1'].motionDetectionSendInterval, true));
		        promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.motionBufferActive', device.functionalChannels['1'].motionBufferActive, true));
		        break;
            }
            default: {
                break;
            }
        }
        return promises;
    }

    _updateGroupStates(group) {
        this.log.silly("_updateGroupStates - " + JSON.stringify(group));
        let promises = [];
        promises.push(this.setStateAsync('groups.' + group.id + '.info.type', group.type, true));
        promises.push(this.setStateAsync('groups.' + group.id + '.info.label', group.label, true));

        switch (group.type) {
            case 'HEATING': {
                promises.push(this.setStateAsync('groups.' + group.id + '.actualTemperature', group.actualTemperature, true));
                promises.push(this.setStateAsync('groups.' + group.id + '.setPointTemperature', group.setPointTemperature, true));
                promises.push(this.setStateAsync('groups.' + group.id + '.humidity', group.humidity, true));
                break;
            }
        }

        return promises;
    }

    _updateClientStates(client) {
        this.log.silly("_updateClientStates - " + JSON.stringify(client));
        let promises = [];
        promises.push(this.setStateAsync('clients.' + client.id + '.info.label', client.label, true));
        return promises;
    }

    _updateHomeStates(home) {
        this.log.silly("_updateHomeStates - " + JSON.stringify(home));
        let promises = [];
        return promises;
    }

    async _createObjectsForDevices() {
        let promises = [];
        for (let i in this._api.devices) {
            promises.push(...this._createObjectsForDevice(this._api.devices[i]));
        }
        await Promise.all(promises);
    }

    async _createObjectsForGroups() {
        let promises = [];
        for (let i in this._api.groups) {
            promises.push(...this._createObjectsForGroup(this._api.groups[i]));
        }
        await Promise.all(promises);
    }

    async _createObjectsForClients() {
        let promises = [];
        for (let i in this._api.clients) {
            promises.push(...this._createObjectsForClient(this._api.clients[i]));
        }
        await Promise.all(promises);
    }

    _createObjectsForDevice(device) {
        this.log.silly("createObjectsForDevice - " + device.type + " - " + JSON.stringify(device));
        let promises = [];
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id, { type: 'device', common: {}, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.info.type', { type: 'state', common: { name: 'type', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.info.modelType', { type: 'state', common: { name: 'type', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.info.label', { type: 'state', common: { name: 'type', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        switch (device.type) {
            case 'FULL_FLUSH_SWITCH_MEASURING':
            case 'PLUGABLE_SWITCH_MEASURING': {
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1', { type: 'channel', common: {}, native: {} }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.on', { type: 'state', common: { name: 'on', type: 'boolean', role: 'switch', read: true, write: true }, native: { id: device.id, channel: 1, parameter: 'switchState' } }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.energyCounter', { type: 'state', common: { name: 'energyCounter', type: 'number', role: 'info', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.currentPowerConsumption', { type: 'state', common: { name: 'currentPowerConsumption', type: 'number', role: 'info', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.resetEnergyCounter', { type: 'state', common: { name: 'on', type: 'boolean', role: 'button', read: false, write: true }, native: { id: device.id, channel: 1, parameter: 'resetEnergyCounter' } }));
                break;
            }
            case 'PLUGABLE_SWITCH': {
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1', { type: 'channel', common: {}, native: {} }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.on', { type: 'state', common: { name: 'on', type: 'boolean', role: 'switch', read: true, write: true }, native: { id: device.id, channel: 1, parameter: 'switchState' } }));
                break;
            }
            case 'BRAND_WALL_MOUNTED_THERMOSTAT':
            case 'WALL_MOUNTED_THERMOSTAT_PRO':
            case 'TEMPERATURE_HUMIDITY_SENSOR_DISPLAY': {
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1', { type: 'channel', common: {}, native: {} }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.temperatureOffset', { type: 'state', common: { name: 'temperatureOffset', type: 'number', role: 'thermo', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.actualTemperature', { type: 'state', common: { name: 'actualTemperature', type: 'number', role: 'thermo', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.setPointTemperature', { type: 'state', common: { name: 'setPointTemperature', type: 'number', role: 'thermo', read: true, write: true }, native: { id: device.functionalChannels[1].groups, parameter: 'setPointTemperature' } }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.display', { type: 'state', common: { name: 'display', type: 'string', role: 'info', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.humidity', { type: 'state', common: { name: 'humidity', type: 'number', role: 'thermo', read: true, write: false }, native: {} }));
                break;
            }
            case 'HEATING_THERMOSTAT': {
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1', { type: 'channel', common: {}, native: {} }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.temperatureOffset', { type: 'state', common: { name: 'temperatureOffset', type: 'number', role: 'thermo', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.valvePosition', { type: 'state', common: { name: 'actualTemperature', type: 'number', role: 'thermo', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.setPointTemperature', { type: 'state', common: { name: 'setPointTemperature', type: 'number', role: 'thermo', read: true, write: true }, native: { id: device.functionalChannels[1].groups, parameter: 'setPointTemperature' } }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.valveState', { type: 'state', common: { name: 'display', type: 'string', role: 'info', read: true, write: false }, native: {} }));
                break;
            }
            case 'SHUTTER_CONTACT':
            case 'SHUTTER_CONTACT_MAGNETIC': {
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.windowState', { type: 'state', common: { name: 'windowOpen', type: 'string', role: 'sensor.window', read: true, write: false }, native: {} }));
                break;
            }
            case 'PUSH_BUTTON':
            case 'PUSH_BUTTON_6':
            case 'OPEN_COLLECTOR_8_MODULE':
            case 'REMOTE_CONTROL_8': {
                for (let i in device.functionalChannels) {
                    if (i != 0)
                        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + i, { type: 'channel', common: {}, native: {} }));
                    promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + i + '.on', { type: 'state', common: { name: 'on', type: 'boolean', role: 'switch', read: true, write: true }, native: { id: device.id, channel: i, parameter: 'switchState' } }));
                }
                break;
            }
            case 'BRAND_SHUTTER': {
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1', { type: 'channel', common: {}, native: {} }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.shutterLevel', { type: 'state', common: { name: 'shutterLevel', type: 'number', role: 'level', read: true, write: true }, native: { id: device.id, channel: 1, parameter: 'shutterlevel' } }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.previousShutterLevel', { type: 'state', common: { name: 'previousShutterLevel', type: 'string', role: 'info', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.processing', { type: 'state', common: { name: 'processing', type: 'string', role: 'info', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.selfCalibrationInProgress', { type: 'state', common: { name: 'selfCalibrationInProgress', type: 'string', role: 'info', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.topToBottomReferenceTime', { type: 'state', common: { name: 'topToBottomReferenceTime', type: 'number', role: 'seconds', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.bottomToTopReferenceTime', { type: 'state', common: { name: 'bottomToTopReferenceTime', type: 'number', role: 'seconds', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.changeOverDelay', { type: 'state', common: { name: 'changeOverDelay', type: 'number', role: 'seconds', read: true, write: true }, native: { id: device.id, channel: 1, parameter: 'changeOverDelay' } }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.endpositionAutoDetectionEnabled', { type: 'state', common: { name: 'endpositionAutoDetectionEnabled', type: 'string', role: 'switch', read: true, write: true }, native: { id: device.id, channel: 1, parameter: 'switchState' } }));
                break;
            }
            case 'MOTION_DETECTOR_INDOOR': {
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1', { type: 'channel', common: {}, native: {} }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.motionDetected', { type: 'state', common: { name: 'motionDetected', type: 'boolean', role: 'info', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.illumination', { type: 'state', common: { name: 'illumination', type: 'number', role: 'info', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.currentIllumination', { type: 'state', common: { name: 'currentIllumination', type: 'number', role: 'info', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.motionDetectionSendInterval', { type: 'state', common: { name: 'motionDetectionSendInterval', type: 'string', role: 'info', read: false, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.motionBufferActive', { type: 'state', common: { name: 'motionBufferActive', type: 'boolean', role: 'switch', read: false, write: true }, native: { id: device.id, channel: 1, parameter: 'switchState' } }));
                break;
            }
            default: {
                this.log.debug("device - not implemented device :" + JSON.stringify(device));
                break;
            }
        }
        return promises;
    }

    _createObjectsForGroup(group) {
        this.log.silly("createObjectsForGroup - " + JSON.stringify(group));
        let promises = [];
        promises.push(this.setObjectNotExistsAsync('groups.' + group.id, { type: 'device', common: {}, native: {} }));
        promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.info.type', { type: 'state', common: { name: 'type', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.info.label', { type: 'state', common: { name: 'label', type: 'string', role: 'info', read: true, write: false }, native: {} }));

        switch (group.type) {
            case 'HEATING': {
                promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.actualTemperature', { type: 'state', common: { name: 'actualTemperature', type: 'number', role: 'thermo', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.setPointTemperature', { type: 'state', common: { name: 'setPointTemperature', type: 'number', role: 'thermo', read: true, write: true }, native: { id: [group.id], parameter: 'setPointTemperature' } }));
                promises.push(this.setObjectNotExistsAsync('groups.' + group.id + '.humidity', { type: 'state', common: { name: 'humidity', type: 'string', role: 'info', read: true, write: false }, native: {} }));
                break;
            }
        }

        return promises;
    }

    _createObjectsForClient(client) {
        this.log.silly("createObjectsForClient - " + JSON.stringify(client));
        let promises = [];
        promises.push(this.setObjectNotExistsAsync('clients.' + client.id, { type: 'device', common: {}, native: {} }));
        promises.push(this.setObjectNotExistsAsync('clients.' + client.id + '.info.label', { type: 'state', common: { name: 'label', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        return promises;
    }

    _createObjectsForHome(home) {
        this.log.silly("createObjectsForHome - " + JSON.stringify(home));
        let promises = [];
        return promises;
    }
};

// If started as allInOne/compact mode => return function to create instance
if (module && module.parent) {
    module.exports = (options) => new HmIpCloudAccesspointAdapter(options);
} else {
    // or start the instance directly
    new HmIpCloudAccesspointAdapter();
} 
