/* jshint -W097 */// jshint strict:false
/*jslint node: true */
'use strict';

const rq = require('request-promise-native');
const sha512 = require('js-sha512');
const uuidv4 = require('uuid/v4');
const webSocket = require('ws');

class HmCloudAPI {
    constructor(configDataOrApId, pin) {
        if (configDataOrApId != null) {
            this.parseConfigData(configDataOrApId, pin);
        }
        
        this.deviceChanged = null;
    }

    parseConfigData(configDataOrApId, pin, deviceId)
    {
        if (typeof configDataOrApId === 'string') {
            this._apSgtin = configDataOrApId.replace(/[^a-fA-F0-9 ]/g, '');
            this._clientAuthToken = sha512(this._apSgtin + "jiLpVitHvWnIGD1yo7MA").toUpperCase();
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
            this._apSgtin = configDataOrApId.apSgtin.replace(/[^a-fA-F0-9 ]/g, '');
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
            "id": this._apSgtin
        };
    }

    getSaveData() {
        return {
            'authToken': this._authToken,
            'clientAuthToken': this._clientAuthToken,
            'clientId': this._clientId,
            'apSgtin': this._apSgtin,
            'pin': this._pin,
            'deviceId': this._deviceId 
        }
    }

    async getHomematicHosts() {
        let res = await rq("https://lookup.homematic.com:48335/getHost", { method: 'POST', json: true, body: this._clientCharacteristics });
        this._urlREST = res.urlREST;
        this._urlWebSocket = res.urlWebSocket;
    }

    // =========== API for Token generation ===========

    async auth1connectionRequest(devicename = 'hmipnodejs') {
        const headers = { 'content-type': 'application/json', 'accept': 'application/json', 'VERSION': '12', 'CLIENTAUTH': this._clientAuthToken };
        if (this._pin)
            headers['PIN'] = this._pin;
        const body = { "deviceId": this._deviceId, "deviceName": devicename, "sgtin": this._apSgtin };
        let res = await rq(this._urlREST + "/hmip/auth/connectionRequest", { method: 'POST', json: true, body: body, headers: headers, simple: false, resolveWithFullResponse: true });
        if (res.statusCode != 200)
            throw "error";
    }

    async auth2isRequestAcknowledged() {
        const headers = { 'content-type': 'application/json', 'accept': 'application/json', 'VERSION': '12', 'CLIENTAUTH': this._clientAuthToken };
        const body = { "deviceId": this._deviceId };
        let res = await rq(this._urlREST + "/hmip/auth/isRequestAcknowledged", { method: 'POST', json: true, body: body, headers: headers, simple: false, resolveWithFullResponse: true });
        return res.statusCode == 200;
    }

    async auth3requestAuthToken() {
        let headers = { 'content-type': 'application/json', 'accept': 'application/json', 'VERSION': '12', 'CLIENTAUTH': this._clientAuthToken };
        let body = { "deviceId": this._deviceId };
        let res = await rq(this._urlREST + "/hmip/auth/requestAuthToken", { method: 'POST', json: true, body: body, headers: headers });
        this._authToken = res.authToken;
        body = { "deviceId": this._deviceId, "authToken": this._authToken };
        res = await rq(this._urlREST + "/hmip/auth/confirmAuthToken", { method: 'POST', json: true, body: body, headers: headers });
        this._clientId = res.clientId;
    }

    async callRestApi(path, data) {
        let headers = { 'content-type': 'application/json', 'accept': 'application/json', 'VERSION': '12', 'AUTHTOKEN': this._authToken, 'CLIENTAUTH': this._clientAuthToken };
        let res = await rq(this._urlREST + "/hmip/" + path, { method: 'POST', json: true, body: data, headers: headers });
        return res;
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

    connectWebsocket() {
         this._ws = new webSocket(this._urlWebSocket, {
            headers: {
                'AUTHTOKEN': this._authToken, 'CLIENTAUTH': this._clientAuthToken
            },
            perMessageDeflate: false
        });

        this._ws.on('open', () => {          
        });

        this._ws.on('close', () => {
        });

        this._ws.on('message', (d) => {
            let dString = d.toString('utf8');
            let data = JSON.parse(dString);
            this._parseEventdata(data);
        });
    }

    _parseEventdata(data) {
        for (let i in data.events) {
            switch (data.events[i].pushEventType) {
                case 'DEVICE_CHANGED':
                    this._parseDeviceChangedEvent(data.events[i].device);
                    break;
                case 'GROUP_CHANGED':
                    this._parseDeviceChangedEvent(data.events[i].group);
                    break;
                default:
                   break;
            }
        }
    }

    _parseDeviceChangedEvent(ev) {
        this.devices[ev.id] = ev;
        if (this.deviceChanged)
            this.deviceChanged(ev); 
    }

    _parseGroupChangedEvent(ev) {
        this.groups[ev.id] = ev;
    }

    // =========== API for HM Devices ===========

    async deviceControlSetSwitchState(deviceId, on, channelIndex = 1) {
        let data = { "deviceId": deviceId, "on": on, "channelIndex": channelIndex };
        await this.callRestApi('device/control/setSwitchState', data);
    }

    async deviceControlResetEnergyCounter(deviceId, channelIndex = 1) {
        let data = { "deviceId": deviceId, "channelIndex": channelIndex };
        await this.callRestApi('device/control/resetEnergyCounter', data);
    }

    async deviceControlSetDimLevel(deviceId, dimLevel, channelIndex = 1) {
        let data = { "deviceId": deviceId, "channelIndex": channelIndex, 'dimLevel': dimLevel };
        await this.callRestApi('device/control/setDimLevel', data);
    }

    async deviceControlSetShutterLevel(deviceId, shutterLevel, channelIndex = 1) {
        let data = { "deviceId": deviceId, "channelIndex": channelIndex, 'shutterLevel': shutterLevel };
        await this.callRestApi('device/control/setShutterLevel', data);
    }

    async deviceControlStop(deviceId, channelIndex = 1) {
        let data = { "deviceId": deviceId, "channelIndex": channelIndex };
        await this.callRestApi('device/control/stop', data);
    }

    //todo check -> does not work atm
    async deviceConfigurationSetPointTemperature(deviceId, setPointTemperature, channelIndex = 1) {
        let data = { "deviceId": deviceId, "setPointTemperature": setPointTemperature, "channelIndex": channelIndex };
        await this.callRestApi('device/configuration/setSetPointTemperature', data);
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
};

module.exports = HmCloudAPI;