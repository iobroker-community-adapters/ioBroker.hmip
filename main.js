/* jshint -W097 */// jshint strict:false
/*jslint node: true */
'use strict';

const utils = require('@iobroker/adapter-core'); // Get common adapter utils
const apiClass = require('./api/hm-cloud-api.js');

const adapterName = require('./package.json').name.split('.').pop();

class HmIpCloudAccesspointAdapter extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: adapterName });

        this._api = new apiClass();
        this._api.deviceChanged = this._deviceChanged.bind(this);

        this.on('unload', this._unload);
        this.on('objectChange', this._objectChange);
        this.on('stateChange', this._stateChange);
        this.on('message', this._message);
        this.on('ready', this._ready);
    }

    _unload(callback) {
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

    async _stateChange(id, state) {
        if (!id || !state || state.ack) return;

        let o = await this.getObjectAsync(id);
        if (o.native.parameter) {
            this.log.info('state change - ' + o.native.parameter + ' - ' + o.native.id);
            switch (o.native.parameter) {
                case 'switchState':
                    this._api.deviceControlSetSwitchState(o.native.id, state.val, o.native.channel)
                    break;
                case 'resetEnergyCounter':
                    this._api.deviceControlResetEnergyCounter(o.native.id, o.native.channel)
                    break;
            }
        }
    }

    async _message(msg) {
        switch (msg.command) {
            case 'requestToken':
                try {
                    this._api.parseConfigData(this.config.accessPointSgtin, this.config.pin);
                    await this._api.getHomematicHosts();
                    await this._api.auth1connectionRequest();
                    while (!await this._api.auth2isRequestAcknowledged()) {
                        if (obj.callback)
                            this.sendTo(obj.from, obj.command, 'waitForBlueButton', obj.callback);
                        await delay(2000);
                    }
                    if (obj.callback)
                        this.sendTo(obj.from, obj.command, 'confirmToken', obj.callback);
                    await this._api.auth3requestAuthToken();
                    let saveData = this._api.getSaveData();
                    this.config.authToken = saveData.authToken;
                    this.config.clientAuthToken = saveData.clientAuthToken;
                    this.config.clientId = saveData.clientId;
                    this.config.accessPointSgtin = saveData.accessPointSgtin;
                    this.config.pin = saveData.pin;
                    if (obj.callback)
                        this.sendTo(obj.from, obj.command, 'tokenDone', obj.callback);
                }
                catch (err) {
                    if (obj.callback)
                        this.sendTo(obj.from, obj.command, 'errorOccured', obj.callback);
                    this.log.error('error requesting token: ' + err);
                }
                break;
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
            apSgtin: this.config.accessPointSgtin,
            pin: this.config.pin
        });
        await this._api.getHomematicHosts();
        await this._api.loadCurrentConfig();
        this.log.debug('createObjectsForDevices');
        await this._createObjectsForDevices();
        this.log.debug('connectWebsocket');
        this._api.connectWebsocket();
        this.log.debug('updateDeviceStates');
        let promises = [];
        for (let d in this._api.devices) {
            promises.push(...this._updateDeviceStates(this._api.devices[d]));
        }
        await Promise.all(promises);

        this.log.debug('subscribeStates');
        this.subscribeStates('*');

        this.setState('info.connection', true, true);
        this.log.info('hmip adapter connected and ready');
    }

    async _deviceChanged(device) {
        await Promise.all(this._updateDeviceStates(device));
    }

    _updateDeviceStates(device) {
        this.log.silly("updateDeviceStates - " + device.type + " - " + JSON.stringify(device));
        let promises = [];
        promises.push(this.setStateAsync('devices.' + device.id + '.info.type', device.type, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.info.modelType', device.modelType, true));
        promises.push(this.setStateAsync('devices.' + device.id + '.info.label', device.label, true));
        switch (device.type) {
            case 'PLUGABLE_SWITCH_MEASURING': {
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.on', device.functionalChannels['1'].on, true));
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.energyCounter', device.functionalChannels['1'].energyCounter, true));
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.currentPowerConsumption', device.functionalChannels['1'].currentPowerConsumption, true));
                break;
            }
            case 'TEMPERATURE_HUMIDITY_SENSOR_DISPLAY': {
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.temperatureOffset', device.functionalChannels['1'].temperatureOffset, true));
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.actualTemperature', device.functionalChannels['1'].actualTemperature, true));
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.setPointTemperature', device.functionalChannels['1'].setPointTemperature, true));
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.display', device.functionalChannels['1'].display, true));
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.humidity', device.functionalChannels['1'].humidity, true));
                break;
            }
            case 'SHUTTER_CONTACT': {
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
            default: {
                break;
            }
        }
        return promises;
    }

    async _createObjectsForDevices() {
        let promises = [];
        for (let i in this._api.devices) {
            promises.push(...this._createObjectsForDevice(this._api.devices[i]));
        }
        await Promise.all(promises);
    }

    _createObjectsForDevice(device) {
        this.log.silly("createObjectsForDevice - " + device.type + " - " + JSON.stringify(device));
        let promises = [];
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.info.type', { type: 'state', common: { name: 'type', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.info.modelType', { type: 'state', common: { name: 'type', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.info.label', { type: 'state', common: { name: 'type', type: 'string', role: 'info', read: true, write: false }, native: {} }));
        switch (device.type) {
            case 'PLUGABLE_SWITCH_MEASURING': {
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.on', { type: 'state', common: { name: 'on', type: 'boolean', role: 'switch', read: true, write: true }, native: { id: device.id, channel: 1, parameter: 'switchState' } }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.energyCounter', { type: 'state', common: { name: 'energyCounter', type: 'number', role: 'info', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.currentPowerConsumption', { type: 'state', common: { name: 'currentPowerConsumption', type: 'number', role: 'info', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.resetEnergyCounter', { type: 'state', common: { name: 'on', type: 'boolean', role: 'button', read: false, write: true }, native: { id: device.id, channel: 1, parameter: 'resetEnergyCounter' } }));
                break;
            }
            case 'TEMPERATURE_HUMIDITY_SENSOR_DISPLAY': {
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.temperatureOffset', { type: 'state', common: { name: 'temperatureOffset', type: 'number', role: 'thermo', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.actualTemperature', { type: 'state', common: { name: 'actualTemperature', type: 'number', role: 'thermo', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.setPointTemperature', { type: 'state', common: { name: 'setPointTemperature', type: 'number', role: 'thermo', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.display', { type: 'state', common: { name: 'display', type: 'string', role: 'info', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.humidity', { type: 'state', common: { name: 'humidity', type: 'number', role: 'thermo', read: true, write: false }, native: {} }));
                break;
            }
            case 'SHUTTER_CONTACT': {
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.windowState', { type: 'state', common: { name: 'windowOpen', type: 'string', role: 'sensor.window', read: true, write: false }, native: {} }));
                break;
            }
            case 'PUSH_BUTTON':
            case 'PUSH_BUTTON_6':
            case 'OPEN_COLLECTOR_8_MODULE':
            case 'REMOTE_CONTROL_8': {
                    let max = 1;
                    for (let i in device.functionalChannels) {
                        if (i != 0)
                            promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.' + i + '.on', { type: 'state', common: { name: 'on', type: 'boolean', role: 'switch', read: true, write: true }, native: { id: device.id, channel: i, parameter: 'switchState' } }));
                    }
                    break;
                }

            default: {
                this.log.debug("device - not implemented device :" + JSON.stringify(device));
                break;
            }
        }
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