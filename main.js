/* jshint -W097 */// jshint strict:false
/*jslint node: true */
'use strict';

// you have to require the utils module and call adapter function
const utils = require('@iobroker/adapter-core'); // Get common adapter utils
const apiClass = require('./api/hm-cloud-api.js');

// read the adapter name from package.json
const adapterName = require('./package.json').name.split('.').pop();

// define adapter class wich will be used for communication with controller
class HmIpCloudAccesspointAdapter extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: adapterName });

        this._api = new apiClass();
        this._api.deviceChanged = this._deviceChanged;

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
        // Warning, obj can be null if it was deleted
        this.log.info('objectChange ' + id + ' ' + JSON.stringify(obj));
    }

    async _stateChange(id, state) {
        let o = await this.getObjectAsync(id);

        if (o.native.parameter) {
            switch (o.native.parameter) {
                case 'switchState':
                    this._api.deviceControlSetSwitchState(o.native.id, state.val, o.native.channel)
                    break;
            }
        }
    }

    async _message(msg) {
        switch (msg.command) {
            case 'requestToken':
                console.log('message - requestToken');
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
        await this._api.connectWebsocket();

        this.log.debug('updateDeviceStates');
        let promises = [];
        for (let d in this._api.devices) {
            promises.push(...this._updateDeviceStates(this._api.devices[d]));
        }
        await Promise.all(promises);

        this.log.debug('subscribeStates');
        this.subscribeStates('*');
    }

    async _deviceChanged(device) {
        await Promise.all(this._updateDeviceStates(device));
    }

    _updateDeviceStates(device) {
        let promises = [];
        promises.push(this.setStateAsync('devices.' + device.id + '.info.type', device.type));
        promises.push(this.setStateAsync('devices.' + device.id + '.info.modelType', device.modelType));
        promises.push(this.setStateAsync('devices.' + device.id + '.info.label', device.label));
        switch (device.type) {
            case 'PLUGABLE_SWITCH_MEASURING': {
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.on', device.functionalChannels['1'].on));
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.energyCounter', device.functionalChannels['1'].energyCounter));
                promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.currentPowerConsumption', device.functionalChannels['1'].currentPowerConsumption));
                break;
            }
            case 'TEMPERATURE_HUMIDITY_SENSOR_DISPLAY': {
                    promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.temperatureOffset', device.functionalChannels['1'].temperatureOffset));
                    promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.actualTemperature', device.functionalChannels['1'].actualTemperature));
                    promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.setPointTemperature', device.functionalChannels['1'].setPointTemperature));
                    promises.push(this.setStateAsync('devices.' + device.id + '.channels.1.display', device.functionalChannels['1'].display));
               
                break;
            }
            default: {
                this.log.info("not implemented device :" + JSON.stringify(device));
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
        let promises = [];
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.info.type', { type: 'state', common: { name: 'type', type: 'string', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.info.modelType', { type: 'state', common: { name: 'type', type: 'string', role: 'indicator', read: true, write: false }, native: {} }));
        promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.info.label', { type: 'state', common: { name: 'type', type: 'string', role: 'indicator', read: true, write: false }, native: {} }));
        switch (device.type) {
            case 'PLUGABLE_SWITCH_MEASURING': {
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.on', { type: 'state', common: { name: 'on', type: 'boolean', role: 'switch', read: true, write: true }, native: { id: device.id, channel: 1, parameter: 'switchState' } }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.energyCounter', { type: 'state', common: { name: 'energyCounter', type: 'number', role: 'indicator', read: true, write: false }, native: {} }));
                promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.currentPowerConsumption', { type: 'state', common: { name: 'currentPowerConsumption', type: 'number', role: 'indicator', read: true, write: false }, native: {} }));
                break;
            }
            case 'TEMPERATURE_HUMIDITY_SENSOR_DISPLAY': {
                    promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.temperatureOffset', { type: 'state', common: { name: 'temperatureOffset', type: 'number', role: 'indicator', read: true, write: false }, native: {} }));
                    promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.actualTemperature', { type: 'state', common: { name: 'actualTemperature', type: 'number', role: 'indicator', read: true, write: false }, native: {} }));
                    promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.setPointTemperature', { type: 'state', common: { name: 'setPointTemperature', type: 'number', role: 'indicator', read: true, write: false }, native: {} }));
                    promises.push(this.setObjectNotExistsAsync('devices.' + device.id + '.channels.1.display', { type: 'state', common: { name: 'display', type: 'string', role: 'indicator', read: true, write: false }, native: {} }));   
                    break;
                }
                default: {
                    this.log.info("not implemented device :" + JSON.stringify(device));
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