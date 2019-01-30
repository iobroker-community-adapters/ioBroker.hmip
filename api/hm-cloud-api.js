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
        let res = await rq("https://lookup.homematic.com:48335/getHost", { method: 'POST', json: true, body: this._clientCharacteristics });
        this._urlREST = res.urlREST;
        this._urlWebSocket = res.urlWebSocket;
    }

    // =========== API for Token generation ===========

    async auth1connectionRequest(devicename = 'hmipnodejs') {
        const headers = { 'content-type': 'application/json', 'accept': 'application/json', 'VERSION': '12', 'CLIENTAUTH': this._clientAuthToken };
        if (this._pin)
            headers['PIN'] = this._pin;
        const body = { "deviceId": this._deviceId, "deviceName": devicename, "sgtin": this._accessPointSgtin };
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
            if (this.dataReceived)
                this.dataReceived(dString);
            let data = JSON.parse(dString);
            this._parseEventdata(data);
        });
    }

    _parseEventdata(data) {
        for (let i in data.events) {
            let ev = data.events[i];
            switch (ev.pushEventType) {
                case 'DEVICE_ADDED':
                case 'DEVICE_CHANGED':
                    this.devices[ev.device.id] = ev.device;
                    break;
                case 'GROUP_ADDED':
                case 'GROUP_CHANGED':
                    this.groups[ev.group.id] = ev.group;
                    break;
                case 'CLIENT_ADDED':
                case 'CLIENT_CHANGED':
                    this.clients[ev.client.id] = ev.client;
                    break;
                case 'DEVICE_REMOVED':
                    delete this.devices[ev.device.id];
                    break;
                case 'GROUP_REMOVED':
                    delete this.clients[ev.group.id];
                    break;
                case 'CLIENT_REMOVED':
                    delete this.groups[ev.client.id];
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

    async deviceControlSetSlatsLevel(deviceId, slatsLevel, channelIndex = 1) {
        let data = { "deviceId": deviceId, "channelIndex": channelIndex, 'slatsLevel': slatsLevel };
        await this.callRestApi('device/control/setSlatsLevel', data);
    }

    async deviceControlStop(deviceId, channelIndex = 1) {
        let data = { "deviceId": deviceId, "channelIndex": channelIndex };
        await this.callRestApi('device/control/stop', data);
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