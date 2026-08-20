const { Adapter } = require('@iobroker/adapter-core'); // Get common adapter utils
const { v4: uuidv4 } = require('uuid');
const apiClass = require('./api/hmCloudAPI');
const { CHANNEL_STATES, STATELESS_CHANNELS, channelStateObjects, channelStateValues } = require('./lib/channelStates');

const adapterName = require('./package.json').name.split('.').pop();

class HmIpCloudAccesspointAdapter extends Adapter {
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
        this._api.staleConnection = this._staleConnection.bind(this);

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
        this.reInitDataTimeout = null;
    }

    _unload(callback) {
        this._unloaded = true;
        this.expectWsError && clearTimeout(this.expectWsError);
        this.reInitTimeout && clearTimeout(this.reInitTimeout);
        this.reInitDataTimeout && clearTimeout(this.reInitDataTimeout);
        this._api.dispose();
        try {
            this.log.info('cleaned everything up...');
            callback();
        } catch {
            callback();
        }
    }

    _objectChange(id, obj) {
        this.log.info(`objectChange ${id} ${JSON.stringify(obj)}`);
    }

    async _message(msg) {
        this.log.debug(`message received - ${JSON.stringify(msg)}`);
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
            while (!(await this._api.auth2isRequestAcknowledged()) && !this._unloaded) {
                this._requestTokenState = { state: 'waitForBlueButton' };
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
            if (!this._unloaded) {
                this._requestTokenState = { state: 'confirmToken' };
                this.log.info('auth step 3');
                await this._api.auth3requestAuthToken();
                let saveData = this._api.getSaveData();
                saveData.state = 'tokenCreated';
                this._requestTokenState = saveData;
            }
        } catch (err) {
            this._requestTokenState = { state: 'errorOccurred' };
            this.log.error(`error requesting token: ${err}`);
        }
    }

    async _ready() {
        // set UUID if not set
        if (!this.config.deviceId) {
            const config = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
            config.native.deviceId = uuidv4();
            await this.setForeignObjectAsync(config._id, config);
            return;
        }

        this.reInitTimeout && clearTimeout(this.reInitTimeout);
        this.log.debug('ready');
        await this.setState('info.connection', false, true);

        if (!this.Sentry && this.supportsFeature && this.supportsFeature('PLUGINS')) {
            const sentryInstance = this.getPluginInstance('sentry');
            if (sentryInstance) {
                this.Sentry = sentryInstance.getSentryObject();
            }
        }

        if (
            this.config.accessPointSgtin &&
            this.config.authToken &&
            this.config.clientAuthToken &&
            this.config.clientId
        ) {
            try {
                this._api.parseConfigData({
                    authToken: this.config.authToken,
                    clientAuthToken: this.config.clientAuthToken,
                    clientId: this.config.clientId,
                    accessPointSgtin: this.config.accessPointSgtin,
                    pin: this.config.pin,
                });
                await this._api.getHomematicHosts();

                await this._initData();
            } catch (err) {
                this.log.error(`error starting Homematic: ${err}`);
                this.log.error('Try reconnect in 30s');
                this.reInitTimeout && clearTimeout(this.reInitTimeout);
                this.reInitTimeout = setTimeout(() => {
                    this.reInitTimeout = null;
                    this._ready();
                }, 30000);
                return;
            }
            this.log.debug('subscribeStates');
            this.subscribeStates('*');

            await this.setState('info.connection', true, true);
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
        this.log.debug('createObjectsForRules');
        await this._createObjectsForRules();
        this.log.debug('createObjectsForHomes');
        await this._createObjectsForHomes();
        this.log.debug('connectWebsocket');
        this._api.connectWebsocket();
        this.log.debug('updateDeviceStates');
        if (this._api.devices) {
            for (let d in this._api.devices) {
                if (!Object.prototype.hasOwnProperty.call(this._api.devices, d)) {
                    continue;
                }
                await this._updateDeviceStates(this._api.devices[d]);
            }
        } else {
            this.log.debug('No devices');
        }
        if (this._api.groups) {
            for (let g in this._api.groups) {
                if (!Object.prototype.hasOwnProperty.call(this._api.groups, g)) {
                    continue;
                }
                await this._updateGroupStates(this._api.groups[g]);
            }
        } else {
            this.log.debug('No groups');
        }
        if (this._api.clients) {
            for (let c in this._api.clients) {
                if (!Object.prototype.hasOwnProperty.call(this._api.clients, c)) {
                    continue;
                }
                await this._updateClientStates(this._api.clients[c]);
            }
        } else {
            this.log.debug('No clients');
        }
        if (this._api.rules) {
            for (let r in this._api.rules) {
                if (!Object.prototype.hasOwnProperty.call(this._api.rules, r)) {
                    continue;
                }
                await this._updateRuleStates(this._api.rules[r]);
            }
        } else {
            this.log.debug('No rules');
        }
        if (this._api.home) {
            await this._updateHomeStates(this._api.home);
            await this._updateSecurityJournal();
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
                        case 0: //state.val = 'OPEN'; break;
                        case 1: //state.val = 'STOP'; break;
                        case 2: //state.val = 'CLOSE'; break;
                        case 3: //state.val = 'VENTILATION_POSITION'; break;
                            break; // Send as before
                        default:
                            this.log.info('Ignore invalid value for doorCommand.');
                            return;
                    }
                    await this._api.deviceControlSendDoorCommand(o.native.id, state.val, o.native.channel);
                    break;
                case 'setLockState':
                    {
                        //door commands as number: 1 = open; 2 = locked; 3 = unlocked
                        switch (state.val) {
                            case 1:
                                state.val = 'OPEN';
                                break;
                            case 2:
                                state.val = 'LOCKED';
                                break;
                            case 3:
                                state.val = 'UNLOCKED';
                                break;
                            default:
                                this.log.info('Ignore invalid value for setLockState.');
                                return;
                        }
                        const pin = await this.getStateAsync(`devices.${o.native.id}.channels.${o.native.channel}.pin`);
                        this.log.info(`Call setLockState for ${state.val} ${pin ? 'with' : 'without'} PIN`);
                        await this._api.deviceControlSetLockState(
                            o.native.id,
                            state.val,
                            pin ? pin.val : '',
                            o.native.channel,
                        );
                    }
                    break;
                case 'resetEnergyCounter':
                    await this._api.deviceControlResetEnergyCounter(o.native.id, o.native.channel);
                    break;
                case 'startImpulse':
                    await this._api.deviceControlStartImpulse(o.native.id, o.native.channel);
                    break;
                case 'shutterlevel':
                    if (typeof state.val === 'number' && state.val > 1) {
                        state.val = state.val / 100;
                    }
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceControlSetShutterLevel(o.native.id, state.val, o.native.channel);
                    break;
                case 'slatsLevel':
                    {
                        let slats = await this.getStateAsync(
                            `devices.${o.native.id}.channels.${o.native.channel}.slatsLevel`,
                        );
                        let shutter = await this.getStateAsync(
                            `devices.${o.native.id}.channels.${o.native.channel}.shutterLevel`,
                        );
                        if (typeof slats.val === 'number' && slats.val > 1) {
                            slats.val = slats.val / 100;
                        }
                        if (typeof shutter.val === 'number' && shutter.val > 1) {
                            shutter.val = shutter.val / 100;
                        }
                        if (
                            slats.val ===
                                this.currentValues[`devices.${o.native.id}.channels.${o.native.channel}.slatsLevel`] &&
                            shutter.val ===
                                this.currentValues[`devices.${o.native.id}.channels.${o.native.channel}.shutterLevel`]
                        ) {
                            this.log.info(`Value unchanged, do not send this value`);
                            await this.secureSetStateAsync(id, this.currentValues[id], true);
                            return;
                        }
                        await this._api.deviceControlSetSlatsLevel(
                            o.native.id,
                            slats.val,
                            shutter.val,
                            o.native.channel,
                        );
                    }
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
                    {
                        let primary = await this.getStateAsync(
                            `devices.${o.native.id}.channels.${o.native.channel}.primaryShadingLevel`,
                        );
                        let secondary = await this.getStateAsync(
                            `devices.${o.native.id}.channels.${o.native.channel}.secondaryShadingLevel`,
                        );
                        if (
                            primary.val ===
                                this.currentValues[
                                    `devices.${o.native.id}.channels.${o.native.channel}.primaryShadingLevel`
                                ] &&
                            secondary.val ===
                                this.currentValues[
                                    `devices.${o.native.id}.channels.${o.native.channel}.secondaryShadingLevel`
                                ]
                        ) {
                            this.log.info(`Value unchanged, do not send this value`);
                            await this.secureSetStateAsync(id, this.currentValues[id], true);
                            return;
                        }
                        await this._api.deviceControlSetSecondaryShadingLevel(
                            o.native.id,
                            primary.val,
                            secondary.val,
                            o.native.channel,
                        );
                    }
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
                case 'setBoostDuration':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    for (let id of o.native.id) {
                        await this._api.groupHeatingSetBoostDuration(id, state.val);
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
                    await this._api.deviceConfigurationSetClimateControlDisplay(
                        o.native.id,
                        state.val,
                        o.native.channel,
                    );
                    break;
                case 'setMinimumFloorHeatingValvePosition':
                    if (typeof state.val === 'number' && state.val > 1) {
                        state.val = state.val / 100;
                    }
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceConfigurationSetMinimumFloorHeatingValvePosition(
                        o.native.id,
                        state.val,
                        o.native.channel,
                    );
                    break;
                case 'setDimLevel':
                    if (typeof state.val === 'number' && state.val > 1) {
                        state.val = state.val / 100;
                    }
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    {
                        const times = await this._controlTimes(o.native);
                        if (times.timed) {
                            await this._api.deviceControlSetDimLevelWithTime(
                                o.native.id,
                                state.val,
                                times.onTime,
                                times.rampTime,
                                o.native.channel,
                            );
                        } else {
                            await this._api.deviceControlSetDimLevel(o.native.id, state.val, o.native.channel);
                        }
                    }
                    break;
                case 'setRgbDimLevel':
                    {
                        let rgb = await this.getStateAsync(
                            `devices.${o.native.id}.channels.${o.native.channel}.simpleRGBColorState`,
                        );
                        let dimLevel = await this.getStateAsync(
                            `devices.${o.native.id}.channels.${o.native.channel}.dimLevel`,
                        );
                        let dimLevelValue = dimLevel ? dimLevel.val : null;
                        if (typeof dimLevelValue === 'number' && dimLevelValue > 1) {
                            dimLevelValue = dimLevelValue / 100;
                        }
                        if (
                            rgb.val ===
                                this.currentValues[
                                    `devices.${o.native.id}.channels.${o.native.channel}.simpleRGBColorState`
                                ] &&
                            dimLevelValue ===
                                this.currentValues[`devices.${o.native.id}.channels.${o.native.channel}.dimLevel`]
                        ) {
                            this.log.info(`Value unchanged, do not send this value`);
                            await this.secureSetStateAsync(id, this.currentValues[id], true);
                            return;
                        }
                        const times = await this._controlTimes(o.native);
                        if (times.timed) {
                            await this._api.deviceControlSetRgbDimLevelWithTime(
                                o.native.id,
                                rgb.val,
                                dimLevelValue,
                                times.onTime,
                                times.rampTime,
                                o.native.channel,
                            );
                        } else {
                            await this._api.deviceControlSetRgbDimLevel(
                                o.native.id,
                                rgb.val,
                                dimLevelValue,
                                o.native.channel,
                            );
                        }
                    }
                    break;
                case 'toggleWateringState':
                    await this._api.deviceControlToggleWateringState(o.native.id, o.native.channel);
                    break;
                case 'resetWaterVolume':
                    await this._api.deviceControlResetWaterVolume(o.native.id, o.native.channel);
                    break;
                case 'resetPassageCounter':
                    await this._api.deviceControlResetPassageCounter(o.native.id, o.native.channel);
                    break;
                case 'setFavoriteShadingPosition':
                    await this._api.deviceControlSetFavoriteShadingPosition(o.native.id, o.native.channel);
                    break;
                case 'setMotionDetectionActive':
                    await this._api.deviceControlSetMotionDetectionActive(o.native.id, state.val, o.native.channel);
                    break;
                case 'pullLatch':
                    {
                        const latchPin = await this.getStateAsync(
                            `devices.${o.native.id}.channels.${o.native.channel}.pin`,
                        );
                        await this._api.deviceControlPullLatch(
                            o.native.id,
                            latchPin ? latchPin.val : '',
                            o.native.channel,
                        );
                    }
                    break;
                case 'setSoundFileVolumeLevel':
                    {
                        const base = `devices.${o.native.id}.channels.${o.native.channel}`;
                        const soundFile = await this.getStateAsync(`${base}.soundFile`);
                        const volumeLevel = await this.getStateAsync(`${base}.volumeLevel`);
                        await this._api.deviceControlSetSoundFileVolumeLevel(
                            o.native.id,
                            soundFile ? soundFile.val : null,
                            volumeLevel ? volumeLevel.val : null,
                            o.native.channel,
                        );
                    }
                    break;
                case 'startLightScene':
                    {
                        const base = `devices.${o.native.id}.channels.${o.native.channel}`;
                        const sceneId = await this.getStateAsync(`${base}.lightSceneId`);
                        const sceneDimLevel = await this.getStateAsync(`${base}.dimLevel`);
                        await this._api.deviceControlStartLightScene(
                            o.native.id,
                            sceneId ? sceneId.val : null,
                            sceneDimLevel ? sceneDimLevel.val : null,
                            o.native.channel,
                        );
                    }
                    break;
                case 'setWateringSwitchState':
                    {
                        const times = await this._controlTimes(o.native);
                        if (times.onTime > 0) {
                            await this._api.deviceControlSetWateringSwitchStateWithTime(
                                o.native.id,
                                state.val,
                                times.onTime,
                                o.native.channel,
                            );
                        } else {
                            await this._api.deviceControlSetWateringSwitchState(
                                o.native.id,
                                state.val,
                                o.native.channel,
                            );
                        }
                    }
                    break;
                case 'setHueSaturationDimLevel':
                    {
                        const base = `devices.${o.native.id}.channels.${o.native.channel}`;
                        const hue = await this.getStateAsync(`${base}.hue`);
                        const saturation = await this.getStateAsync(`${base}.saturationLevel`);
                        const dimLevel = await this.getStateAsync(`${base}.dimLevel`);
                        const times = await this._controlTimes(o.native);
                        if (times.timed) {
                            await this._api.deviceControlSetHueSaturationDimLevelWithTime(
                                o.native.id,
                                hue ? hue.val : null,
                                saturation ? saturation.val : null,
                                dimLevel ? dimLevel.val : null,
                                times.onTime,
                                times.rampTime,
                                o.native.channel,
                            );
                        } else {
                            await this._api.deviceControlSetHueSaturationDimLevel(
                                o.native.id,
                                hue ? hue.val : null,
                                saturation ? saturation.val : null,
                                dimLevel ? dimLevel.val : null,
                                o.native.channel,
                            );
                        }
                    }
                    break;
                case 'setColorTemperatureDimLevel':
                    {
                        const base = `devices.${o.native.id}.channels.${o.native.channel}`;
                        const colorTemperature = await this.getStateAsync(`${base}.colorTemperature`);
                        const dimLevel = await this.getStateAsync(`${base}.dimLevel`);
                        const times = await this._controlTimes(o.native);
                        if (times.timed) {
                            await this._api.deviceControlSetColorTemperatureDimLevelWithTime(
                                o.native.id,
                                colorTemperature ? colorTemperature.val : null,
                                dimLevel ? dimLevel.val : null,
                                times.onTime,
                                times.rampTime,
                                o.native.channel,
                            );
                        } else {
                            await this._api.deviceControlSetColorTemperatureDimLevel(
                                o.native.id,
                                colorTemperature ? colorTemperature.val : null,
                                dimLevel ? dimLevel.val : null,
                                o.native.channel,
                            );
                        }
                    }
                    break;
                case 'setOpticalSignalBehaviour':
                    {
                        let rgb = await this.getStateAsync(
                            `devices.${o.native.id}.channels.${o.native.channel}.simpleRGBColorState`,
                        );
                        let dimLevel = await this.getStateAsync(
                            `devices.${o.native.id}.channels.${o.native.channel}.dimLevel`,
                        );
                        let opticalSignal = await this.getStateAsync(
                            `devices.${o.native.id}.channels.${o.native.channel}.opticalSignalBehaviour`,
                        );
                        let dimLevelValue = dimLevel ? dimLevel.val : null;
                        if (typeof dimLevelValue === 'number' && dimLevelValue > 1) {
                            dimLevelValue = dimLevelValue / 100;
                        }
                        if (
                            rgb.val ===
                                this.currentValues[
                                    `devices.${o.native.id}.channels.${o.native.channel}.simpleRGBColorState`
                                ] &&
                            dimLevelValue ===
                                this.currentValues[`devices.${o.native.id}.channels.${o.native.channel}.dimLevel`]
                        ) {
                            this.log.info(`Value unchanged, do not send this value`);
                            await this.secureSetStateAsync(id, this.currentValues[id], true);
                            return;
                        }
                        const times = await this._controlTimes(o.native);
                        if (times.timed) {
                            await this._api.deviceControlSetOpticalSignalWithTime(
                                o.native.id,
                                opticalSignal.val,
                                rgb.val,
                                dimLevelValue,
                                times.onTime,
                                times.rampTime,
                                o.native.channel,
                            );
                        } else {
                            await this._api.deviceControlOpticalSignalBehaviour(
                                o.native.id,
                                rgb.val,
                                dimLevelValue,
                                o.native.channel,
                                opticalSignal.val,
                            );
                        }
                    }
                    break;
                case 'setAcousticAlarmSignal':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceConfigurationSetAcousticAlarmSignal(o.native.id, state.val, o.native.channel);
                    break;
                case 'setAcousticAlarmTiming':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceConfigurationSetAcousticAlarmTiming(o.native.id, state.val, o.native.channel);
                    break;
                case 'setAcousticWaterAlarmTrigger':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceConfigurationSetAcousticWaterAlarmTrigger(
                        o.native.id,
                        state.val,
                        o.native.channel,
                    );
                    break;
                case 'setInAppWaterAlarmTrigger':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceConfigurationSetInAppWaterAlarmTrigger(
                        o.native.id,
                        state.val,
                        o.native.channel,
                    );
                    break;
                case 'setSirenWaterAlarmTrigger':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceConfigurationSetSirenWaterAlarmTrigger(
                        o.native.id,
                        state.val,
                        o.native.channel,
                    );
                    break;
                case 'setAccelerationSensorMode':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceConfigurationSetAccelerationSensorMode(
                        o.native.id,
                        state.val,
                        o.native.channel,
                    );
                    break;
                case 'setAccelerationSensorNeutralPosition':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceConfigurationSetAccelerationSensorNeutralPosition(
                        o.native.id,
                        state.val,
                        o.native.channel,
                    );
                    break;
                case 'setAccelerationSensorTriggerAngle':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceConfigurationSetAccelerationSensorTriggerAngle(
                        o.native.id,
                        state.val,
                        o.native.channel,
                    );
                    break;
                case 'setAccelerationSensorSensitivity':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceConfigurationSetAccelerationSensorSensitivity(
                        o.native.id,
                        state.val,
                        o.native.channel,
                    );
                    break;
                case 'setAccelerationSensorEventFilterPeriod':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceConfigurationSetAccelerationSensorEventFilterPeriod(
                        o.native.id,
                        state.val,
                        o.native.channel,
                    );
                    break;
                case 'setNotificationSoundType':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceConfigurationSetNotificationSoundType(
                        o.native.id,
                        state.val,
                        id.endsWith('HighToLow'),
                        o.native.channel,
                    );
                    break;
                case 'setRouterModuleEnabled':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceConfigurationSetRouterModuleEnabled(o.native.id, state.val, o.native.channel);
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
                    {
                        let vacTemp = await this.getStateAsync(
                            `homes.${o.native.id}.functionalHomes.indoorClimate.vacationTemperature`,
                        ).val;
                        await this._api.homeHeatingActivateVacation(vacTemp, state.val);
                    }
                    break;
                case 'deactivateVacation':
                    await this._api.homeHeatingDeactivateVacation();
                    break;
                case 'setSecurityZonesActivationNone':
                    await this._setSecurityZonesActivation(false, false);
                    break;
                case 'setSecurityZonesActivationInternal':
                    await this._setSecurityZonesActivation(true, false);
                    break;
                case 'setSecurityZonesActivationExternal':
                    await this._setSecurityZonesActivation(false, true);
                    break;
                case 'setSecurityZonesActivationInternalAndExternal':
                    await this._setSecurityZonesActivation(true, true);
                    break;
                case 'groupSwitchState':
                    await this._api.groupSwitchingSetState(o.native.id, state.val);
                    break;
                case 'groupShutterLevel':
                    await this._api.groupSwitchingSetShutterLevel(o.native.id, state.val);
                    break;
                case 'groupSlatsLevel':
                    {
                        const groupShutter = await this.getStateAsync(`groups.${o.native.id}.shutterLevel`);
                        await this._api.groupSwitchingSetSlatsLevel(
                            o.native.id,
                            state.val,
                            groupShutter ? groupShutter.val : null,
                        );
                    }
                    break;
                case 'groupStop':
                    await this._api.groupSwitchingStop(o.native.id);
                    break;
                case 'setCooling':
                    await this._api.homeHeatingSetCooling(state.val);
                    break;
                case 'setZoneActivationDelay':
                    await this._api.homeSetZoneActivationDelay(state.val);
                    break;
                case 'setOnTime':
                    for (let id of this._targetGroups(o.native, o.native.parameter)) {
                        await this._api.groupSwitchingAlarmSetOnTime(id, state.val);
                    }
                    break;
                case 'testSignalOptical':
                    for (let id of this._targetGroups(o.native, o.native.parameter)) {
                        await this._api.groupSwitchingAlarmTestSignalOptical(id, state.val);
                    }
                    break;
                case 'setSignalOptical':
                    for (let id of this._targetGroups(o.native, o.native.parameter)) {
                        await this._api.groupSwitchingAlarmSetSignalOptical(id, state.val);
                    }
                    break;
                case 'testSignalAcoustic':
                    for (let id of this._targetGroups(o.native, o.native.parameter)) {
                        await this._api.groupSwitchingAlarmTestSignalAcoustic(id, state.val);
                    }
                    break;
                case 'setSignalAcoustic':
                    for (let id of this._targetGroups(o.native, o.native.parameter)) {
                        await this._api.groupSwitchingAlarmSetSignalAcoustic(id, state.val);
                    }
                    break;
                case 'setZonesSilentAlarmNone':
                    await this._setZonesSilentAlarm(false, false);
                    break;
                case 'setZonesSilentAlarmInternal':
                    await this._setZonesSilentAlarm(true, false);
                    break;
                case 'setZonesSilentAlarmExternal':
                    await this._setZonesSilentAlarm(false, true);
                    break;
                case 'setZonesSilentAlarmInternalAndExternal':
                    await this._setZonesSilentAlarm(true, true);
                    break;
                case 'setProfileMode':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.groupHeatingSetProfileMode(o.native.id, state.val);
                    break;
                case 'groupLinkedOnTime':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.groupSwitchingLinkedSetOnTime(o.native.id, state.val);
                    break;
                case 'setPowerMeterUnitPrice':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.homeSetPowerMeterUnitPrice(state.val);
                    break;
                case 'getSecurityJournal':
                    await this._updateSecurityJournal();
                    break;
                case 'setRuleEnabled':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    if ((await this._api.ruleEnableSimpleRule(o.native.id, state.val)) === undefined) {
                        this.log.error(`Could not enable rule ${o.native.id}, it is unchanged.`);
                        return;
                    }
                    await this._ackRuleValue(o.native.id, 'active', state.val);
                    break;
                case 'setRuleLabel':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    if ((await this._api.ruleSetRuleLabel(o.native.id, state.val)) === undefined) {
                        this.log.error(`Could not relabel rule ${o.native.id}, it is unchanged.`);
                        return;
                    }
                    await this._ackRuleValue(o.native.id, 'label', state.val);
                    break;
            }
        } catch (err) {
            this.log.warn(`${o.native.parameter} - id ${o.native.id ? o.native.id : ''} - state change error: ${err}`);
        }
    }

    async _stateChange(id, state) {
        if (!id || !state || state.ack || this._unloaded) {
            return;
        }

        let o = await this.getObjectAsync(id);
        if (o && o.native && o.native.parameter) {
            if (o.native.step) {
                state.val = this.round(state.val, o.native.step);
                this.log.debug(
                    `state change - ${o.native.parameter} - id ${o.native.id ? JSON.stringify(o.native.id) : ''} - value rounded to ${state.val} (step=${o.native.step} )`,
                );
            } else {
                this.log.debug(
                    `state change - ${o.native.parameter} - id ${o.native.id ? JSON.stringify(o.native.id) : ''} - value ${state.val}`,
                );
            }

            if (o.native.debounce) {
                // if debounce and value is the same, ignore call
                if (
                    this.delayTimeouts[id] &&
                    this.delayTimeouts[id].timeout &&
                    this.delayTimeouts[id].lastVal === state.val
                ) {
                    this.log.debug(
                        `${o.native.parameter} - id ${o.native.id ? JSON.stringify(o.native.id) : ''} - Debounce waiting - value stable`,
                    );
                    return;
                }
            } else {
                // if running timeout and not debounce, requests come in too fast
                if (this.delayTimeouts[id] && this.delayTimeouts[id].timeout) {
                    this.log.info(
                        `${o.native.parameter} - id ${o.native.id ? JSON.stringify(o.native.id) : ''} - Too fast value changes, change blocked!`,
                    );
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
                this.delayTimeouts[id].timeout = setTimeout(
                    (id, o, state) => {
                        this.delayTimeouts[id].timeout = null;
                        this.log.debug(
                            `${o.native.parameter} - id ${o.native.id ? JSON.stringify(o.native.id) : ''} - Send debounced value ${state.val} now to HMIP`,
                        );
                        this._doStateChange(id, o, state);
                    },
                    o.native.debounce,
                    id,
                    o,
                    state,
                );
            } else {
                this.delayTimeouts[id].timeout = setTimeout(() => {
                    this.delayTimeouts[id].timeout = null;
                }, o.native.throttle || 1000);
                await this._doStateChange(id, o, state);
            }
        }
    }

    _dataReceived(data) {
        this.log.silly(`data received - ${data}`);
    }

    _opened() {
        this.log.info('ws connection opened');
        this.wsConnected = true;
        this.wsConnectionStableTimeout && clearTimeout(this.wsConnectionStableTimeout);
        this.wsConnectionStableTimeout = setTimeout(() => {
            this.wsConnectionStableTimeout = null;
            this.wsConnectionErrorCounter = 0;
        }, 5000); // set null when connection is stable
    }

    _closed(code, reason, forced = false) {
        this.log.debug(`_onclose( ${code}, ${reason}, ${forced})`);

        if (this.wsConnectionStableTimeout || !this.wsConnected) {
            this.wsConnectionErrorCounter++;
        } else {
            this.wsConnectionErrorCounter = 0;
        }
        reason = reason ? reason.toString() : '';
        if (!forced) {
            this.log.warn(
                `ws connection closed (${this.wsConnectionErrorCounter}) - code: ${code} - reason: ${reason}`,
            );
        }
        this.wsConnected = false;
        this.expectWsError && clearTimeout(this.expectWsError);
        if (!forced && !this.reInitTimeout) {
            // When no error happens within 5 seconds, we refresh our self
            this.expectWsError = setTimeout(() => this._closed(code, reason, true), 5000);
        }
        if ((forced || this.wsConnectionErrorCounter > 6) && !this._unloaded) {
            this._api.dispose();
            this.log.error(`close on websocket connection: ${code} - ${reason}`);
            this.log.error('Try reconnect in 30s');
            this.reInitTimeout && clearTimeout(this.reInitTimeout);
            this.reInitTimeout = setTimeout(async () => {
                this.reInitTimeout = null;
                await this._ready();
            }, 30000);
        }
    }

    _staleConnection(silentFor) {
        this.log.warn(`ws connection stopped answering ${Math.round(silentFor / 1000)}s ago, reconnecting`);
    }

    _errored(error) {
        this.log.warn(`ws connection error (${this.wsConnectionErrorCounter}): ${error}`);
        const reason = error ? error.toString() : '';
        if (!this.wsConnected) {
            this.wsConnectionErrorCounter++;
        }
        if (reason.includes('ECONNREFUSED') && !this._unloaded) {
            this._api.dispose();
            this.log.error(`error on websocket connection: ${reason}`);
            this.log.error('Try reconnect in 30s');
            this.reInitTimeout && clearTimeout(this.reInitTimeout);
            this.reInitTimeout = setTimeout(() => {
                this.reInitTimeout = null;
                this._ready();
            }, 30000);
        }
    }

    _requestError(error) {
        if (error.response) {
            // The request was made and the server responded with a status code
            // that falls out of the range of 2xx
            this.log.warn(`Request error data: ${error.response.data}, (${JSON.stringify(error.response.data)})`);
            this.log.warn(`Request error status: ${error.response.status}`);
        } else if (error.request) {
            // The request was made but no response was received
            // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
            // http.ClientRequest in node.js
            this.log.warn(`Request error: ${error.request}`);
        } else {
            // Something happened in setting up the request that triggered an Error
            this.log.warn(`Request error: ${error.message} (${error}, ${JSON.stringify(error)})`);
        }
    }

    _unexpectedResponse(req, res) {
        this.log.warn(`ws connection unexpected response: ${res.statusCode}`);
    }

    async _eventRaised(ev) {
        if (this._unloaded) {
            return;
        }
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
                if (ev && ev.home) {
                    await this._updateHomeStates(ev.home);
                } else {
                    this.log.warn(`No home in HOME_CHANGED: ${JSON.stringify(ev)}`);
                }
                break;
            case 'SECURITY_JOURNAL_CHANGED':
                if (ev && ev.home) {
                    await this._updateHomeStates(ev.home);
                } else {
                    this.log.debug(`Read Home for SECURITY_JOURNAL_CHANGED: ${JSON.stringify(ev)}`);
                    const state = await this._api.callRestApi('home/getCurrentState', this._api._clientCharacteristics);
                    state && state.home && (await this._updateHomeStates(state.home));
                }
                break;
            case 'DEVICE_CHANNEL_EVENT':
                this.log.debug(`unhandled known event - ${JSON.stringify(ev)}`);
                break;
            default:
                this.log.warn(`unhandled event - ${JSON.stringify(ev)}`);
        }
    }

    /**
     * The on and ramp time a channel is configured to control with.
     *
     * Both default to 0, which selects the plain command; anything above 0 selects the cloud's
     * ...WithTime variant, so a channel only ramps once someone asks it to.
     *
     * @param {object} native the object's native block, carrying the device id and channel
     * @returns {Promise<{onTime: number, rampTime: number, timed: boolean}>} the configured times
     */
    async _controlTimes(native) {
        const base = `devices.${native.id}.channels.${native.channel}`;
        const onTimeState = await this.getStateAsync(`${base}.controlOnTime`);
        const rampTimeState = await this.getStateAsync(`${base}.controlRampTime`);
        const onTime = onTimeState && onTimeState.val ? onTimeState.val : 0;
        const rampTime = rampTimeState && rampTimeState.val ? rampTimeState.val : 0;
        return { onTime, rampTime, timed: onTime > 0 || rampTime > 0 };
    }

    /**
     * Sets the silent alarm and reports a request that never reached the cloud.
     *
     * The zones are named INTERNAL and EXTERNAL whatever the panel calls its zones, because no
     * capture of this call against an ABSENCE/PRESENCE panel exists to say otherwise.
     *
     * @param {boolean} internal silence the internal zone
     * @param {boolean} external silence the external zone
     */
    /**
     * The 0..1 fraction the cloud takes for a level.
     *
     * Levels are published on two scales: the older channels on 0..100 and the newer ones on
     * 0..1, so a value above 1 can only be a percentage and anything else is already a fraction.
     * 1 itself is ambiguous and is read as fully on, which is why a 0..100 channel cannot express
     * 1 percent.
     *
     * @param {number|null|undefined} value the level as it was written
     * @returns {number|null|undefined} the level as the cloud takes it
     */
    /**
     * The groups a command targets, for a state that is set on the channel's groups.
     *
     * @param {object} native the object's native block
     * @param {string} parameter the command being dispatched, for the log line
     * @returns {string[]} the group ids, empty when the channel belongs to none
     */
    _targetGroups(native, parameter) {
        const groups = Array.isArray(native.id) ? native.id : [];
        if (!groups.length) {
            this.log.warn(`${parameter} has no group to act on - assign the channel to a group first`);
        }
        return groups;
    }

    _levelFraction(value) {
        return typeof value === 'number' && value > 1 ? value / 100 : value;
    }

    /**
     * Reads a state of the given channel together with the id it is cached under.
     *
     * @param {object} native the object's native block, carrying the device id and channel
     * @param {string} field the state below the channel
     * @returns {Promise<{id: string, val: boolean|number|string|null}>} the cache id and the value
     */
    async _channelState(native, field) {
        const path = `devices.${native.id}.channels.${native.channel}.${field}`;
        const state = await this.getStateAsync(path);
        return { id: `${this.namespace}.${path}`, val: state ? state.val : null };
    }

    async _setZonesSilentAlarm(internal, external) {
        if ((await this._api.homeSetZonesSilentAlarm(internal, external)) === undefined) {
            this.log.error(
                `Could not set the silent alarm to internal=${internal}, external=${external}, it is unchanged.`,
            );
        }
    }

    async _setSecurityZonesActivation(internal, external) {
        const requested = `internal=${internal}, external=${external}`;
        const outcome = await this._api.homeSetZonesActivation(internal, external);

        if (outcome.requestBased && outcome.classicZonesPresent) {
            this.log.warn(
                'This home has ABSENCE/PRESENCE and INTERNAL/EXTERNAL security zones at the same time. Only the ABSENCE/PRESENCE zones are addressed - please report this setup.',
            );
        }

        if (outcome.requestFailed) {
            this.log.error(
                `Could not set the alarm system to ${requested}, it is unchanged. See the request error above.`,
            );
            return;
        }

        const problems = outcome.problems || {};
        const blocking = Object.keys(problems);
        if (blocking.length) {
            for (const label of blocking) {
                this.log.warn(
                    `Alarm activation for ${requested} was blocked${label ? ` by ${label}` : ''}: ${problems[label].join(', ')}`,
                );
            }
            return;
        }

        if (outcome.requestBased && internal && !external) {
            this.log.info(
                'This home only offers a combined ABSENCE mode, so arming the internal zone armed the external zone as well.',
            );
        }
        if (outcome.lowBatteryLookupIncomplete) {
            this.log.debug(
                'Not every security zone channel could be resolved to a device, so the low battery check may be incomplete.',
            );
        }
        for (const label of outcome.lowBatteryDevices) {
            this.log.warn(`Alarm zone armed although ${label} reports a low battery`);
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
        this.log.silly(`updateDeviceStates - ${device.type} - ${JSON.stringify(device)}`);
        let unknownChannelDetected = false;
        if (this.initializedChannels[`devices.${device.id}`]) {
            let promises = [];
            promises.push(this.secureSetStateAsync(`devices.${device.id}.info.type`, device.type, true));
            promises.push(this.secureSetStateAsync(`devices.${device.id}.info.modelType`, device.modelType, true));
            promises.push(this.secureSetStateAsync(`devices.${device.id}.info.label`, device.label, true));
            promises.push(
                this.secureSetStateAsync(`devices.${device.id}.info.firmwareVersion`, device.firmwareVersion, true),
            );
            promises.push(this.secureSetStateAsync(`devices.${device.id}.info.updateState`, device.updateState, true));
            switch (device.type) {
                /*case 'PLUGABLE_SWITCH': {
                    promises.push(this.secureSetStateAsync('devices.' + device.id + '.channels.1.on', device.functionalChannels['1'].on, true));
                    break;
                }*/
                default: {
                    break;
                }
            }

            for (let i in device.functionalChannels) {
                if (!Object.prototype.hasOwnProperty.call(device.functionalChannels, i)) {
                    continue;
                }
                let fc = device.functionalChannels[i];
                promises.push(
                    this.secureSetStateAsync(
                        `devices.${device.id}.channels.${i}.functionalChannelType`,
                        fc.functionalChannelType,
                        true,
                    ),
                );
                if (!this.initializedChannels[`devices.${device.id}.channels.${i}`]) {
                    unknownChannelDetected = true;
                    continue;
                }

                if (CHANNEL_STATES[fc.functionalChannelType]) {
                    promises.push(...this._updateChannelStates(device, i, fc.functionalChannelType));
                } else if (STATELESS_CHANNELS.includes(fc.functionalChannelType)) {
                    this.log.silly(`Ignore channel type ${fc.functionalChannelType} - ${device.id}`);
                } else if (Object.keys(fc).length > 6) {
                    // fewer fields than that is a stub channel with nothing to report
                    this.log.info(`unknown channel type - ${fc.functionalChannelType} - ${JSON.stringify(device)}`);
                    this._reportUnknownChannel(device, fc.functionalChannelType);
                }
            }
            await Promise.all(promises);
        } else {
            unknownChannelDetected = true;
        }

        if (unknownChannelDetected) {
            this._reinitializeData(`Device ${device.id}`);
        }
    }

    _reinitializeData(id) {
        if (this.reInitDataTimeout) {
            return;
        }
        this.log.info(`New data structures detected ... reinitialize in 5s... ${id}`);
        this._api.dispose();
        this.reInitDataTimeout = setTimeout(async () => {
            this.reInitDataTimeout = null;
            try {
                await this._initData();
            } catch (err) {
                this.log.error(`error updating Homematic ip for unknown states: ${err}`);
                this.log.error('Try reconnect in 30s');
                this.reInitTimeout && clearTimeout(this.reInitTimeout);
                this.reInitTimeout = setTimeout(() => {
                    this.reInitTimeout = null;
                    this._ready();
                }, 30000);
            }
        }, 5000);
    }

    _reportUnknownChannel(device, channelType) {
        if (this.sendUnknownInfos[channelType]) {
            return;
        }
        this.sendUnknownInfos[channelType] = true;
        this.Sentry &&
            this.Sentry.withScope(scope => {
                scope.setLevel('info');
                scope.setExtra('channelData', JSON.stringify(device));
                this.Sentry.captureMessage(`Unknown Channel type ${channelType}`, 'info');
            });
    }

    _createChannel(device, channel, channelType) {
        const entry = CHANNEL_STATES[channelType];
        let promises = entry.extends ? this._createChannel(device, channel, entry.extends) : [];
        const functionalChannel = device.functionalChannels[channel];
        for (const { field, common, native } of channelStateObjects(
            entry.states,
            device.id,
            channel,
            functionalChannel,
        )) {
            promises.push(
                this.extendObject(`devices.${device.id}.channels.${channel}.${field}`, {
                    type: 'state',
                    common,
                    native,
                }),
            );
        }
        return promises;
    }

    _updateChannelStates(device, channel, channelType) {
        const entry = CHANNEL_STATES[channelType];
        let promises = entry.extends ? this._updateChannelStates(device, channel, entry.extends) : [];
        for (const { field, value } of channelStateValues(entry.states, device.functionalChannels[channel])) {
            promises.push(this.secureSetStateAsync(`devices.${device.id}.channels.${channel}.${field}`, value, true));
        }
        return promises;
    }

    _updateGroupStates(group) {
        this.log.silly(`_updateGroupStates - ${JSON.stringify(group)}`);

        if (this.initializedChannels[`groups.${group.id}`]) {
            let promises = [];
            promises.push(this.secureSetStateAsync(`groups.${group.id}.info.type`, group.type, true));
            promises.push(this.secureSetStateAsync(`groups.${group.id}.info.label`, group.label, true));

            switch (group.type) {
                case 'HEATING': {
                    promises.push(
                        this.secureSetStateAsync(
                            `groups.${group.id}.windowOpenTemperature`,
                            group.windowOpenTemperature,
                            true,
                        ),
                    );
                    promises.push(
                        this.secureSetStateAsync(
                            `groups.${group.id}.setPointTemperature`,
                            group.setPointTemperature,
                            true,
                        ),
                    );
                    promises.push(
                        this.secureSetStateAsync(`groups.${group.id}.minTemperature`, group.minTemperature, true),
                    );
                    promises.push(
                        this.secureSetStateAsync(`groups.${group.id}.maxTemperature`, group.maxTemperature, true),
                    );
                    promises.push(this.secureSetStateAsync(`groups.${group.id}.windowState`, group.windowState, true));
                    promises.push(
                        this.secureSetStateAsync(`groups.${group.id}.windowOpen`, group.windowState === 'OPEN', true),
                    );
                    promises.push(this.secureSetStateAsync(`groups.${group.id}.cooling`, group.cooling, true));
                    promises.push(this.secureSetStateAsync(`groups.${group.id}.partyMode`, group.partyMode, true));
                    promises.push(this.secureSetStateAsync(`groups.${group.id}.controlMode`, group.controlMode, true));
                    promises.push(
                        this.secureSetStateAsync(`groups.${group.id}.activeProfile`, group.activeProfile, true),
                    );
                    promises.push(this.secureSetStateAsync(`groups.${group.id}.boostMode`, group.boostMode, true));
                    promises.push(
                        this.secureSetStateAsync(`groups.${group.id}.boostDuration`, group.boostDuration, true),
                    );
                    promises.push(
                        this.secureSetStateAsync(`groups.${group.id}.actualTemperature`, group.actualTemperature, true),
                    );
                    promises.push(this.secureSetStateAsync(`groups.${group.id}.humidity`, group.humidity, true));
                    promises.push(
                        this.secureSetStateAsync(`groups.${group.id}.coolingAllowed`, group.coolingAllowed, true),
                    );
                    promises.push(
                        this.secureSetStateAsync(`groups.${group.id}.coolingIgnored`, group.coolingIgnored, true),
                    );
                    promises.push(this.secureSetStateAsync(`groups.${group.id}.ecoAllowed`, group.ecoAllowed, true));
                    promises.push(this.secureSetStateAsync(`groups.${group.id}.ecoIgnored`, group.ecoIgnored, true));
                    promises.push(
                        this.secureSetStateAsync(`groups.${group.id}.controllable`, group.controllable, true),
                    );
                    promises.push(
                        this.secureSetStateAsync(`groups.${group.id}.floorHeatingMode`, group.floorHeatingMode, true),
                    );
                    promises.push(
                        this.secureSetStateAsync(
                            `groups.${group.id}.humidityLimitEnabled`,
                            group.humidityLimitEnabled,
                            true,
                        ),
                    );
                    promises.push(
                        this.secureSetStateAsync(
                            `groups.${group.id}.humidityLimitValue`,
                            group.humidityLimitValue,
                            true,
                        ),
                    );
                    promises.push(
                        this.secureSetStateAsync(
                            `groups.${group.id}.externalClockEnabled`,
                            group.externalClockEnabled,
                            true,
                        ),
                    );
                    promises.push(
                        this.secureSetStateAsync(
                            `groups.${group.id}.externalClockHeatingTemperature`,
                            group.externalClockHeatingTemperature,
                            true,
                        ),
                    );
                    promises.push(
                        this.secureSetStateAsync(
                            `groups.${group.id}.externalClockCoolingTemperature`,
                            group.externalClockCoolingTemperature,
                            true,
                        ),
                    );
                    promises.push(
                        this.secureSetStateAsync(`groups.${group.id}.valvePosition`, group.valvePosition, true),
                    );
                    promises.push(this.secureSetStateAsync(`groups.${group.id}.sabotage`, group.sabotage, true));
                    break;
                }
                case 'SWITCHING': {
                    promises.push(this.secureSetStateAsync(`groups.${group.id}.on`, group.on, true));
                    promises.push(
                        this.secureSetStateAsync(`groups.${group.id}.shutterLevel`, group.shutterLevel, true),
                    );
                    promises.push(this.secureSetStateAsync(`groups.${group.id}.slatsLevel`, group.slatsLevel, true));
                    break;
                }
                case 'SECURITY_ZONE': {
                    // request-based panels omit "active" on a disarmed zone
                    promises.push(this.secureSetStateAsync(`groups.${group.id}.active`, group.active === true, true));
                    break;
                }
            }

            return Promise.all(promises);
        }
        this._reinitializeData(`Group ${group.id}`);
    }

    _updateClientStates(client) {
        this.log.silly(`_updateClientStates - ${JSON.stringify(client)}`);
        if (this.initializedChannels[`clients.${client.id}`]) {
            let promises = [];
            promises.push(this.secureSetStateAsync(`clients.${client.id}.info.label`, client.label, true));
            return Promise.all(promises);
        }
        this._reinitializeData(`Client ${client.id}`);
    }

    _updateHomeStates(home) {
        this.log.silly(`_updateHomeStates - ${JSON.stringify(home)}`);
        let promises = [];

        if (home.weather) {
            promises.push(
                this.secureSetStateAsync(`homes.${home.id}.weather.temperature`, home.weather.temperature, true),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.weather.weatherCondition`,
                    home.weather.weatherCondition,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(`homes.${home.id}.weather.weatherDayTime`, home.weather.weatherDayTime, true),
            );
            promises.push(
                this.secureSetStateAsync(`homes.${home.id}.weather.minTemperature`, home.weather.minTemperature, true),
            );
            promises.push(
                this.secureSetStateAsync(`homes.${home.id}.weather.maxTemperature`, home.weather.maxTemperature, true),
            );
            promises.push(this.secureSetStateAsync(`homes.${home.id}.weather.humidity`, home.weather.humidity, true));
            promises.push(this.secureSetStateAsync(`homes.${home.id}.weather.windSpeed`, home.weather.windSpeed, true));
            promises.push(
                this.secureSetStateAsync(`homes.${home.id}.weather.windDirection`, home.weather.windDirection, true),
            );
        }

        if (home.functionalHomes.SECURITY_AND_ALARM) {
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.securityAndAlarm.alarmEventTimestamp`,
                    home.functionalHomes.SECURITY_AND_ALARM.alarmEventTimestamp,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.securityAndAlarm.alarmEventDeviceId`,
                    home.functionalHomes.SECURITY_AND_ALARM.alarmEventDeviceId,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.securityAndAlarm.alarmEventTriggerId`,
                    home.functionalHomes.SECURITY_AND_ALARM.alarmEventTriggerId,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.securityAndAlarm.alarmEventDeviceChannel`,
                    home.functionalHomes.SECURITY_AND_ALARM.alarmEventDeviceChannel,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.securityAndAlarm.alarmSecurityJournalEntryType`,
                    home.functionalHomes.SECURITY_AND_ALARM.alarmSecurityJournalEntryType,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.securityAndAlarm.alarmActive`,
                    home.functionalHomes.SECURITY_AND_ALARM.alarmActive,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.securityAndAlarm.zoneActivationDelay`,
                    home.functionalHomes.SECURITY_AND_ALARM.zoneActivationDelay,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.securityAndAlarm.intrusionAlertThroughSmokeDetectors`,
                    home.functionalHomes.SECURITY_AND_ALARM.intrusionAlertThroughSmokeDetectors,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.securityAndAlarm.securityZoneActivationMode`,
                    home.functionalHomes.SECURITY_AND_ALARM.securityZoneActivationMode,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.securityAndAlarm.solution`,
                    home.functionalHomes.SECURITY_AND_ALARM.solution,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.securityAndAlarm.activationInProgress`,
                    home.functionalHomes.SECURITY_AND_ALARM.activationInProgress,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.securityAndAlarm.active`,
                    home.functionalHomes.SECURITY_AND_ALARM.active,
                    true,
                ),
            );
        }
        if (home.functionalHomes.INDOOR_CLIMATE) {
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.indoorClimate.absenceType`,
                    home.functionalHomes.INDOOR_CLIMATE.absenceType,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.indoorClimate.absenceEndTime`,
                    home.functionalHomes.INDOOR_CLIMATE.absenceEndTime,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.indoorClimate.ecoTemperature`,
                    home.functionalHomes.INDOOR_CLIMATE.ecoTemperature,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.indoorClimate.coolingEnabled`,
                    home.functionalHomes.INDOOR_CLIMATE.coolingEnabled,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.indoorClimate.ecoDuration`,
                    home.functionalHomes.INDOOR_CLIMATE.ecoDuration,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.indoorClimate.optimumStartStopEnabled`,
                    home.functionalHomes.INDOOR_CLIMATE.optimumStartStopEnabled,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.indoorClimate.solution`,
                    home.functionalHomes.INDOOR_CLIMATE.solution,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.indoorClimate.active`,
                    home.functionalHomes.INDOOR_CLIMATE.active,
                    true,
                ),
            );
        }
        if (home.functionalHomes.LIGHT_AND_SHADOW) {
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.lightAndShadow.active`,
                    home.functionalHomes.LIGHT_AND_SHADOW.active,
                    true,
                ),
            );
        }
        if (home.functionalHomes.WEATHER_AND_ENVIRONMENT) {
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.weatherAndEnvironment.active`,
                    home.functionalHomes.WEATHER_AND_ENVIRONMENT.active,
                    true,
                ),
            );
        }

        return Promise.all(promises);
    }

    async _createObjectsForDevices() {
        this.log.silly(`Devices: ${JSON.stringify(this._api.devices)}`);
        for (let i in this._api.devices) {
            if (!Object.prototype.hasOwnProperty.call(this._api.devices, i)) {
                continue;
            }
            await this._createObjectsForDevice(this._api.devices[i]);
        }
    }

    async _createObjectsForGroups() {
        this.log.silly(`Groups: ${JSON.stringify(this._api.groups)}`);
        for (let i in this._api.groups) {
            if (!Object.prototype.hasOwnProperty.call(this._api.groups, i)) {
                continue;
            }
            await this._createObjectsForGroup(this._api.groups[i]);
        }
    }

    async _createObjectsForClients() {
        this.log.silly(`Clients: ${JSON.stringify(this._api.clients)}`);
        for (let i in this._api.clients) {
            if (!Object.prototype.hasOwnProperty.call(this._api.clients, i)) {
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
        this.log.silly(`createObjectsForDevice - ${device.type} - ${JSON.stringify(device)}`);
        let promises = [];
        promises.push(
            this.extendObject(`devices.${device.id}`, {
                type: 'device',
                common: { name: device.label },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`devices.${device.id}.info.type`, {
                type: 'state',
                common: { name: 'type', type: 'string', role: 'text', read: true, write: false },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`devices.${device.id}.info.modelType`, {
                type: 'state',
                common: { name: 'type', type: 'string', role: 'text', read: true, write: false },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`devices.${device.id}.info.label`, {
                type: 'state',
                common: { name: 'type', type: 'string', role: 'text', read: true, write: false },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`devices.${device.id}.info.firmwareVersion`, {
                type: 'state',
                common: { name: 'type', type: 'string', role: 'text', read: true, write: false },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`devices.${device.id}.info.updateState`, {
                type: 'state',
                common: { name: 'type', type: 'string', role: 'text', read: true, write: false },
                native: {},
            }),
        );
        this.initializedChannels[`devices.${device.id}`] = true;
        switch (device.type) {
            /*case 'PLUGABLE_SWITCH': {
                promises.push(this.extendObject('devices.' + device.id + '.channels.1', { type: 'channel', common: {}, native: {} }));
                promises.push(this.extendObject('devices.' + device.id + '.channels.1.on', { type: 'state', common: { name: 'on', type: 'boolean', role: 'switch', read: true, write: true }, native: { id: device.id, channel: 1, parameter: 'switchState' } }));
                break;
            }*/
            default:
                break;
        }
        for (let i in device.functionalChannels) {
            if (!Object.prototype.hasOwnProperty.call(device.functionalChannels, i)) {
                continue;
            }
            let fc = device.functionalChannels[i];
            promises.push(
                this.extendObject(`devices.${device.id}.channels.${i}`, {
                    type: 'channel',
                    common: { name: fc.label || `Channel ${i}` },
                    native: {},
                }),
            );
            this.initializedChannels[`devices.${device.id}.channels.${i}`] = true;

            promises.push(
                this.extendObject(`devices.${device.id}.channels.${i}.functionalChannelType`, {
                    type: 'state',
                    common: { name: 'functionalChannelType', type: 'string', role: 'text', read: true, write: false },
                    native: {},
                }),
            );
            if (CHANNEL_STATES[fc.functionalChannelType]) {
                promises.push(...this._createChannel(device, i, fc.functionalChannelType));
            } else if (STATELESS_CHANNELS.includes(fc.functionalChannelType)) {
                this.log.silly(`Ignore channel type ${fc.functionalChannelType} - ${device.id}`);
            } else {
                this.log.info(`Unknown channel type - ${fc.functionalChannelType} - ${JSON.stringify(device)}`);
            }
        }
        return Promise.all(promises);
    }

    /* Start Channel Types */

    /* End Channel Types */

    _createObjectsForGroup(group) {
        this.log.silly(`createObjectsForGroup - ${JSON.stringify(group)}`);
        let promises = [];
        promises.push(
            this.extendObject(`groups.${group.id}`, { type: 'device', common: { name: group.label }, native: {} }),
        );
        promises.push(
            this.extendObject(`groups.${group.id}.info.type`, {
                type: 'state',
                common: { name: 'type', type: 'string', role: 'text', read: true, write: false },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`groups.${group.id}.info.label`, {
                type: 'state',
                common: { name: 'label', type: 'string', role: 'text', read: true, write: false },
                native: {},
            }),
        );
        this.initializedChannels[`groups.${group.id}`] = true;

        switch (group.type) {
            case 'HEATING': {
                promises.push(
                    this.extendObject(`groups.${group.id}.windowOpenTemperature`, {
                        type: 'state',
                        common: {
                            name: 'windowOpenTemperature',
                            type: 'number',
                            role: 'value',
                            unit: '°C',
                            read: true,
                            write: false,
                        },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.setPointTemperature`, {
                        type: 'state',
                        common: {
                            name: 'setPointTemperature',
                            type: 'number',
                            role: 'level.temperature',
                            unit: '°C',
                            read: true,
                            write: true,
                        },
                        native: { id: [group.id], step: 0.5, debounce: 5000, parameter: 'setPointTemperature' },
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.minTemperature`, {
                        type: 'state',
                        common: {
                            name: 'minTemperature',
                            type: 'number',
                            role: 'value',
                            unit: '°C',
                            read: true,
                            write: false,
                        },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.maxTemperature`, {
                        type: 'state',
                        common: {
                            name: 'maxTemperature',
                            type: 'number',
                            role: 'value',
                            unit: '°C',
                            read: true,
                            write: false,
                        },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.windowState`, {
                        type: 'state',
                        common: { name: 'windowState', type: 'string', role: 'value', read: true, write: false },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.windowOpen`, {
                        type: 'state',
                        common: { name: 'windowOpen', type: 'boolean', role: 'indicator', read: true, write: false },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.cooling`, {
                        type: 'state',
                        common: { name: 'cooling', type: 'boolean', role: 'indicator', read: true, write: false },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.partyMode`, {
                        type: 'state',
                        common: { name: 'partyMode', type: 'boolean', role: 'indicator', read: true, write: false },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.controlMode`, {
                        type: 'state',
                        common: { name: 'controlMode', type: 'string', role: 'text', read: true, write: true },
                        native: { id: [group.id], parameter: 'setControlMode' },
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.boostMode`, {
                        type: 'state',
                        common: { name: 'boostMode', type: 'boolean', role: 'switch', read: true, write: true },
                        native: { id: [group.id], parameter: 'setBoost' },
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.activeProfile`, {
                        type: 'state',
                        common: { name: 'activeProfile', type: 'string', role: 'text', read: true, write: true },
                        native: { id: [group.id], parameter: 'setActiveProfile' },
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.boostDuration`, {
                        type: 'state',
                        common: {
                            name: 'boostDuration',
                            type: 'number',
                            role: 'value',
                            unit: 'min',
                            read: true,
                            write: true,
                        },
                        native: { id: [group.id], parameter: 'setBoostDuration' },
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.actualTemperature`, {
                        type: 'state',
                        common: {
                            name: 'actualTemperature',
                            type: 'number',
                            role: 'value.temperature',
                            unit: '°C',
                            read: true,
                            write: false,
                        },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.humidity`, {
                        type: 'state',
                        common: {
                            name: 'humidity',
                            type: 'number',
                            role: 'value.humidity',
                            unit: '%',
                            read: true,
                            write: false,
                        },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.coolingAllowed`, {
                        type: 'state',
                        common: {
                            name: 'coolingAllowed',
                            type: 'boolean',
                            role: 'indicator',
                            read: true,
                            write: false,
                        },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.coolingIgnored`, {
                        type: 'state',
                        common: {
                            name: 'coolingIgnored',
                            type: 'boolean',
                            role: 'indicator',
                            read: true,
                            write: false,
                        },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.ecoAllowed`, {
                        type: 'state',
                        common: { name: 'ecoAllowed', type: 'boolean', role: 'indicator', read: true, write: false },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.ecoIgnored`, {
                        type: 'state',
                        common: { name: 'ecoIgnored', type: 'boolean', role: 'indicator', read: true, write: false },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.controllable`, {
                        type: 'state',
                        common: { name: 'controllable', type: 'boolean', role: 'indicator', read: true, write: false },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.floorHeatingMode`, {
                        type: 'state',
                        common: { name: 'floorHeatingMode', type: 'string', role: 'text', read: true, write: false },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.humidityLimitEnabled`, {
                        type: 'state',
                        common: {
                            name: 'humidityLimitEnabled',
                            type: 'boolean',
                            role: 'indicator',
                            read: true,
                            write: false,
                        },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.humidityLimitValue`, {
                        type: 'state',
                        common: {
                            name: 'humidityLimitValue',
                            type: 'number',
                            role: 'value',
                            unit: '%',
                            read: true,
                            write: false,
                        },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.externalClockEnabled`, {
                        type: 'state',
                        common: {
                            name: 'externalClockEnabled',
                            type: 'boolean',
                            role: 'indicator',
                            read: true,
                            write: false,
                        },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.externalClockHeatingTemperature`, {
                        type: 'state',
                        common: {
                            name: 'externalClockHeatingTemperature',
                            type: 'number',
                            role: 'value',
                            unit: '°C',
                            read: true,
                            write: false,
                        },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.externalClockCoolingTemperature`, {
                        type: 'state',
                        common: {
                            name: 'externalClockCoolingTemperature',
                            type: 'number',
                            role: 'value',
                            unit: '°C',
                            read: true,
                            write: false,
                        },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.valvePosition`, {
                        type: 'state',
                        common: { name: 'valvePosition', type: 'number', role: 'value', read: true, write: false },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.sabotage`, {
                        type: 'state',
                        common: {
                            name: 'sabotage',
                            type: 'boolean',
                            role: 'indicator.alarm',
                            read: true,
                            write: false,
                        },
                        native: {},
                    }),
                );
                break;
            }
            case 'ALARM_SWITCHING': {
                promises.push(
                    this.extendObject(`groups.${group.id}.setOnTime`, {
                        type: 'state',
                        common: { name: 'setOnTime', type: 'string', role: 'text', read: true, write: true },
                        native: { id: [group.id], parameter: 'setOnTime' },
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.testSignalOptical`, {
                        type: 'state',
                        common: {
                            name: 'testSignalOptical',
                            type: 'string',
                            role: 'text',
                            read: true,
                            write: true,
                            states: {
                                DISABLE_OPTICAL_SIGNAL: 'DISABLE_OPTICAL_SIGNAL',
                                BLINKING_ALTERNATELY_REPEATING: 'BLINKING_ALTERNATELY_REPEATING',
                                BLINKING_BOTH_REPEATING: 'BLINKING_BOTH_REPEATING',
                                DOUBLE_FLASHING_REPEATING: 'DOUBLE_FLASHING_REPEATING',
                                FLASHING_BOTH_REPEATING: 'FLASHING_BOTH_REPEATING',
                                CONFIRMATION_SIGNAL_0: 'CONFIRMATION_SIGNAL_0',
                                CONFIRMATION_SIGNAL_1: 'CONFIRMATION_SIGNAL_1',
                                CONFIRMATION_SIGNAL_2: 'CONFIRMATION_SIGNAL_2',
                            },
                        },
                        native: { id: [group.id], parameter: 'testSignalOptical' },
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.setSignalOptical`, {
                        type: 'state',
                        common: {
                            name: 'setSignalOptical',
                            type: 'string',
                            role: 'text',
                            read: true,
                            write: true,
                            states: {
                                DISABLE_OPTICAL_SIGNAL: 'DISABLE_OPTICAL_SIGNAL',
                                BLINKING_ALTERNATELY_REPEATING: 'BLINKING_ALTERNATELY_REPEATING',
                                BLINKING_BOTH_REPEATING: 'BLINKING_BOTH_REPEATING',
                                DOUBLE_FLASHING_REPEATING: 'DOUBLE_FLASHING_REPEATING',
                                FLASHING_BOTH_REPEATING: 'FLASHING_BOTH_REPEATING',
                                CONFIRMATION_SIGNAL_0: 'CONFIRMATION_SIGNAL_0',
                                CONFIRMATION_SIGNAL_1: 'CONFIRMATION_SIGNAL_1',
                                CONFIRMATION_SIGNAL_2: 'CONFIRMATION_SIGNAL_2',
                            },
                        },
                        native: { id: [group.id], parameter: 'setSignalOptical' },
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.testSignalAcoustic`, {
                        type: 'state',
                        common: {
                            name: 'testSignalAcoustic',
                            type: 'string',
                            role: 'text',
                            read: true,
                            write: true,
                            states: {
                                DISABLE_ACOUSTIC_SIGNAL: 'DISABLE_ACOUSTIC_SIGNAL',
                                FREQUENCY_RISING: 'FREQUENCY_RISING',
                                FREQUENCY_FALLING: 'FREQUENCY_FALLING',
                                FREQUENCY_RISING_AND_FALLING: 'FREQUENCY_RISING_AND_FALLING',
                                FREQUENCY_ALTERNATING_LOW_HIGH: 'FREQUENCY_ALTERNATING_LOW_HIGH',
                                FREQUENCY_ALTERNATING_LOW_MID_HIGH: 'FREQUENCY_ALTERNATING_LOW_MID_HIGH',
                                FREQUENCY_HIGHON_OFF: 'FREQUENCY_HIGHON_OFF',
                                FREQUENCY_HIGHON_LONGOFF: 'FREQUENCY_HIGHON_LONGOFF',
                                FREQUENCY_LOWON_OFF_HIGHON_OFF: 'FREQUENCY_LOWON_OFF_HIGHON_OFF',
                                FREQUENCY_LOWON_LONGOFF_HIGHON_LONGOFF: 'FREQUENCY_LOWON_LONGOFF_HIGHON_LONGOFF',
                                LOW_BATTERY: 'LOW_BATTERY',
                                DISARMED: 'DISARMED',
                                INTERNALLY_ARMED: 'INTERNALLY_ARMED',
                                EXTERNALLY_ARMED: 'EXTERNALLY_ARMED',
                                DELAYED_INTERNALLY_ARMED: 'DELAYED_INTERNALLY_ARMED',
                                DELAYED_EXTERNALLY_ARMED: 'DELAYED_EXTERNALLY_ARMED',
                                EVENT: 'EVENT',
                                ERROR: 'ERROR',
                            },
                        },
                        native: { id: [group.id], parameter: 'testSignalAcoustic' },
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.setSignalAcoustic`, {
                        type: 'state',
                        common: {
                            name: 'setSignalAcoustic',
                            type: 'string',
                            role: 'text',
                            read: true,
                            write: true,
                            states: {
                                DISABLE_ACOUSTIC_SIGNAL: 'DISABLE_ACOUSTIC_SIGNAL',
                                FREQUENCY_RISING: 'FREQUENCY_RISING',
                                FREQUENCY_FALLING: 'FREQUENCY_FALLING',
                                FREQUENCY_RISING_AND_FALLING: 'FREQUENCY_RISING_AND_FALLING',
                                FREQUENCY_ALTERNATING_LOW_HIGH: 'FREQUENCY_ALTERNATING_LOW_HIGH',
                                FREQUENCY_ALTERNATING_LOW_MID_HIGH: 'FREQUENCY_ALTERNATING_LOW_MID_HIGH',
                                FREQUENCY_HIGHON_OFF: 'FREQUENCY_HIGHON_OFF',
                                FREQUENCY_HIGHON_LONGOFF: 'FREQUENCY_HIGHON_LONGOFF',
                                FREQUENCY_LOWON_OFF_HIGHON_OFF: 'FREQUENCY_LOWON_OFF_HIGHON_OFF',
                                FREQUENCY_LOWON_LONGOFF_HIGHON_LONGOFF: 'FREQUENCY_LOWON_LONGOFF_HIGHON_LONGOFF',
                                LOW_BATTERY: 'LOW_BATTERY',
                                DISARMED: 'DISARMED',
                                INTERNALLY_ARMED: 'INTERNALLY_ARMED',
                                EXTERNALLY_ARMED: 'EXTERNALLY_ARMED',
                                DELAYED_INTERNALLY_ARMED: 'DELAYED_INTERNALLY_ARMED',
                                DELAYED_EXTERNALLY_ARMED: 'DELAYED_EXTERNALLY_ARMED',
                                EVENT: 'EVENT',
                                ERROR: 'ERROR',
                            },
                        },
                        native: { id: [group.id], parameter: 'setSignalAcoustic' },
                    }),
                );
                break;
            }
            case 'SWITCHING': {
                promises.push(
                    this.extendObject(`groups.${group.id}.on`, {
                        type: 'state',
                        common: { name: 'on', type: 'boolean', role: 'switch', read: true, write: true },
                        native: { id: group.id, parameter: 'groupSwitchState' },
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.shutterLevel`, {
                        type: 'state',
                        common: {
                            name: 'shutterLevel',
                            type: 'number',
                            role: 'level.blind',
                            min: 0,
                            max: 1,
                            read: true,
                            write: true,
                        },
                        native: { id: group.id, parameter: 'groupShutterLevel', step: 0.05, debounce: 5000 },
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.slatsLevel`, {
                        type: 'state',
                        common: {
                            name: 'slatsLevel',
                            type: 'number',
                            role: 'level.blind',
                            min: 0,
                            max: 1,
                            read: true,
                            write: true,
                        },
                        native: { id: group.id, parameter: 'groupSlatsLevel', step: 0.05, debounce: 5000 },
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.stop`, {
                        type: 'state',
                        common: { name: 'stop', type: 'boolean', role: 'button', read: false, write: true },
                        native: { id: group.id, parameter: 'groupStop' },
                    }),
                );
                break;
            }
            case 'SECURITY_ZONE': {
                promises.push(
                    this.extendObject(`groups.${group.id}.active`, {
                        type: 'state',
                        common: { name: 'active', type: 'boolean', role: 'indicator', read: true, write: false },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.silent`, {
                        type: 'state',
                        common: { name: 'silent', type: 'boolean', role: 'indicator', read: true, write: false },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.windowState`, {
                        type: 'state',
                        common: { name: 'windowState', type: 'string', role: 'text', read: true, write: false },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.motionDetected`, {
                        type: 'state',
                        common: {
                            name: 'motionDetected',
                            type: 'boolean',
                            role: 'indicator.motion',
                            read: true,
                            write: false,
                        },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.presenceDetected`, {
                        type: 'state',
                        common: {
                            name: 'presenceDetected',
                            type: 'boolean',
                            role: 'indicator',
                            read: true,
                            write: false,
                        },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.sabotage`, {
                        type: 'state',
                        common: {
                            name: 'sabotage',
                            type: 'boolean',
                            role: 'indicator.alarm',
                            read: true,
                            write: false,
                        },
                        native: {},
                    }),
                );
                break;
            }
            case 'HOT_WATER': {
                promises.push(
                    this.extendObject(`groups.${group.id}.profileMode`, {
                        type: 'state',
                        common: {
                            name: 'profileMode',
                            type: 'string',
                            role: 'text',
                            read: true,
                            write: true,
                            states: { AUTOMATIC: 'AUTOMATIC', MANUAL: 'MANUAL' },
                        },
                        native: { id: group.id, parameter: 'setProfileMode' },
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.profileId`, {
                        type: 'state',
                        common: { name: 'profileId', type: 'string', role: 'text', read: true, write: false },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.on`, {
                        type: 'state',
                        common: { name: 'on', type: 'boolean', role: 'indicator', read: true, write: false },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.onTime`, {
                        type: 'state',
                        common: {
                            name: 'onTime',
                            type: 'number',
                            role: 'value.interval',
                            unit: 's',
                            read: true,
                            write: false,
                        },
                        native: {},
                    }),
                );
                break;
            }
            case 'SHUTTER_PROFILE': {
                promises.push(
                    this.extendObject(`groups.${group.id}.profileMode`, {
                        type: 'state',
                        common: {
                            name: 'profileMode',
                            type: 'string',
                            role: 'text',
                            read: true,
                            write: true,
                            states: { AUTOMATIC: 'AUTOMATIC', MANUAL: 'MANUAL' },
                        },
                        native: { id: group.id, parameter: 'setProfileMode' },
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.profileId`, {
                        type: 'state',
                        common: { name: 'profileId', type: 'string', role: 'text', read: true, write: false },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.shutterLevel`, {
                        type: 'state',
                        common: {
                            name: 'shutterLevel',
                            type: 'number',
                            role: 'level.blind',
                            min: 0,
                            max: 1,
                            read: true,
                            write: true,
                        },
                        native: { id: group.id, parameter: 'groupShutterLevel', step: 0.05, debounce: 5000 },
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.slatsLevel`, {
                        type: 'state',
                        common: {
                            name: 'slatsLevel',
                            type: 'number',
                            role: 'level.blind',
                            min: 0,
                            max: 1,
                            read: true,
                            write: true,
                        },
                        native: { id: group.id, parameter: 'groupSlatsLevel', step: 0.05, debounce: 5000 },
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.stop`, {
                        type: 'state',
                        common: { name: 'stop', type: 'boolean', role: 'button', read: false, write: true },
                        native: { id: group.id, parameter: 'groupStop' },
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.primaryShadingLevel`, {
                        type: 'state',
                        common: {
                            name: 'primaryShadingLevel',
                            type: 'number',
                            role: 'value',
                            read: true,
                            write: false,
                        },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.primaryShadingStateType`, {
                        type: 'state',
                        common: {
                            name: 'primaryShadingStateType',
                            type: 'string',
                            role: 'text',
                            read: true,
                            write: false,
                        },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.secondaryShadingLevel`, {
                        type: 'state',
                        common: {
                            name: 'secondaryShadingLevel',
                            type: 'number',
                            role: 'value',
                            read: true,
                            write: false,
                        },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.secondaryShadingStateType`, {
                        type: 'state',
                        common: {
                            name: 'secondaryShadingStateType',
                            type: 'string',
                            role: 'text',
                            read: true,
                            write: false,
                        },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.processing`, {
                        type: 'state',
                        common: { name: 'processing', type: 'boolean', role: 'indicator', read: true, write: false },
                        native: {},
                    }),
                );
                break;
            }
            case 'EXTENDED_LINKED_NOTIFICATION':
                promises.push(
                    this.extendObject(`groups.${group.id}.opticalSignalBehaviour`, {
                        type: 'state',
                        common: {
                            name: 'opticalSignalBehaviour',
                            type: 'string',
                            role: 'text',
                            read: true,
                            write: false,
                        },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.onOpticalSignalBehaviour`, {
                        type: 'state',
                        common: {
                            name: 'onOpticalSignalBehaviour',
                            type: 'string',
                            role: 'text',
                            read: true,
                            write: false,
                        },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.simpleRGBColorState`, {
                        type: 'state',
                        common: {
                            name: 'simpleRGBColorState',
                            type: 'string',
                            role: 'text',
                            read: true,
                            write: false,
                        },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.onSimpleRGBColor`, {
                        type: 'state',
                        common: { name: 'onSimpleRGBColor', type: 'string', role: 'text', read: true, write: false },
                        native: {},
                    }),
                );
            // eslint-disable-next-line no-fallthrough
            case 'EXTENDED_LINKED_SWITCHING': {
                promises.push(
                    this.extendObject(`groups.${group.id}.on`, {
                        type: 'state',
                        common: { name: 'on', type: 'boolean', role: 'switch', read: true, write: true },
                        native: { id: group.id, parameter: 'groupSwitchState' },
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.dimLevel`, {
                        type: 'state',
                        common: {
                            name: 'dimLevel',
                            type: 'number',
                            role: 'value.dimmer',
                            min: 0,
                            max: 1,
                            read: true,
                            write: false,
                        },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.onLevel`, {
                        type: 'state',
                        common: { name: 'onLevel', type: 'number', role: 'value', read: true, write: false },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.onTime`, {
                        type: 'state',
                        common: {
                            name: 'onTime',
                            type: 'number',
                            role: 'level.timer',
                            unit: 's',
                            read: true,
                            write: true,
                        },
                        native: { id: group.id, parameter: 'groupLinkedOnTime', debounce: 5000 },
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.dutyCycle`, {
                        type: 'state',
                        common: { name: 'dutyCycle', type: 'boolean', role: 'indicator', read: true, write: false },
                        native: {},
                    }),
                );
                promises.push(
                    this.extendObject(`groups.${group.id}.lowBat`, {
                        type: 'state',
                        common: {
                            name: 'lowBat',
                            type: 'boolean',
                            role: 'indicator.lowbat',
                            read: true,
                            write: false,
                        },
                        native: {},
                    }),
                );
                break;
            }
        }

        return Promise.all(promises);
    }

    async _createObjectsForRules() {
        this.log.silly(`Rules: ${JSON.stringify(this._api.rules)}`);
        for (let i in this._api.rules) {
            if (!Object.prototype.hasOwnProperty.call(this._api.rules, i)) {
                continue;
            }
            await this._createObjectsForRule(this._api.rules[i]);
        }
    }

    _createObjectsForRule(rule) {
        this.log.silly(`createObjectsForRule - ${JSON.stringify(rule)}`);
        let promises = [];
        promises.push(
            this.extendObject(`rules.${rule.id}`, { type: 'device', common: { name: rule.label }, native: {} }),
        );
        promises.push(
            this.extendObject(`rules.${rule.id}.info.type`, {
                type: 'state',
                common: { name: 'type', type: 'string', role: 'text', read: true, write: false },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`rules.${rule.id}.info.label`, {
                type: 'state',
                common: { name: 'label', type: 'string', role: 'text', read: true, write: true },
                native: { id: rule.id, parameter: 'setRuleLabel' },
            }),
        );
        // only a SIMPLE rule can be enabled through the cloud. extendObject merges native, so a
        // rule that stops being SIMPLE has to have its parameter cleared rather than left out.
        const simple = rule.type === 'SIMPLE';
        promises.push(
            this.extendObject(`rules.${rule.id}.active`, {
                type: 'state',
                common: {
                    name: 'active',
                    type: 'boolean',
                    role: simple ? 'switch' : 'indicator',
                    read: true,
                    write: simple,
                },
                native: { id: rule.id, parameter: simple ? 'setRuleEnabled' : null },
            }),
        );
        this.initializedChannels[`rules.${rule.id}`] = true;
        return Promise.all(promises);
    }

    _updateRuleStates(rule) {
        this.log.silly(`_updateRuleStates - ${JSON.stringify(rule)}`);
        if (this.initializedChannels[`rules.${rule.id}`]) {
            let promises = [];
            promises.push(this.secureSetStateAsync(`rules.${rule.id}.info.type`, rule.type, true));
            promises.push(this.secureSetStateAsync(`rules.${rule.id}.info.label`, rule.label, true));
            promises.push(this.secureSetStateAsync(`rules.${rule.id}.active`, rule.active, true));
            return Promise.all(promises);
        }
        this._reinitializeData(`Rule ${rule.id}`);
    }

    /**
     * Confirms a rule value the adapter just sent.
     *
     * The cloud raises no push event for a rule, so without this the state would stay unconfirmed
     * until the next full read of the configuration.
     *
     * @param {string} ruleId the rule that was written to
     * @param {string} field the rule field that was written
     * @param {boolean|string} value the value the cloud accepted
     */
    async _ackRuleValue(ruleId, field, value) {
        const rule = this._api.rules && this._api.rules[ruleId];
        if (rule) {
            rule[field] = value;
        }
        const path = field === 'label' ? `rules.${ruleId}.info.label` : `rules.${ruleId}.${field}`;
        await this.secureSetStateAsync(path, value, true);
    }

    /**
     * Reads the security journal and publishes it.
     *
     * A burst of journal events must not turn into a burst of reads: a read already running
     * absorbs the ones that arrive while it is in flight and repeats once afterwards, so the
     * published journal and the entry split out of it always come from the same response.
     *
     * @returns {Promise<void>}
     */
    async _updateSecurityJournal() {
        if (!this._api.home) {
            return;
        }
        if (this._journalReadRunning) {
            this._journalReadPending = true;
            return;
        }
        this._journalReadRunning = true;
        try {
            do {
                this._journalReadPending = false;
                await this._publishSecurityJournal();
            } while (this._journalReadPending && !this._unloaded);
        } finally {
            this._journalReadRunning = false;
        }
    }

    /**
     * @returns {Promise<void>}
     */
    async _publishSecurityJournal() {
        const base = `homes.${this._api.home.id}.functionalHomes.securityAndAlarm`;
        const journal = await this._api.homeGetSecurityJournal();
        if (this._unloaded) {
            return;
        }
        if (!journal || !Array.isArray(journal.entries)) {
            this.log.debug('No security journal received');
            return;
        }
        // the cloud documents no order for the entries, so the newest is the latest timestamp
        const newest =
            journal.entries.reduce(
                (latest, entry) =>
                    latest && (latest.eventTimestamp ?? 0) >= (entry.eventTimestamp ?? 0) ? latest : entry,
                null,
            ) || {};
        await this.secureSetStateAsync(`${base}.securityJournal`, JSON.stringify(journal.entries), true);
        await this.secureSetStateAsync(`${base}.securityJournalEventTimestamp`, newest.eventTimestamp ?? null, true);
        await this.secureSetStateAsync(`${base}.securityJournalEventType`, newest.eventType ?? null, true);
        await this.secureSetStateAsync(`${base}.securityJournalLabel`, newest.label ?? null, true);
    }

    _createObjectsForClient(client) {
        this.log.silly(`createObjectsForClient - ${JSON.stringify(client)}`);
        let promises = [];
        promises.push(
            this.extendObject(`clients.${client.id}`, {
                type: 'device',
                common: { name: client.label },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`clients.${client.id}.info.label`, {
                type: 'state',
                common: { name: 'label', type: 'string', role: 'text', read: true, write: false },
                native: {},
            }),
        );
        this.initializedChannels[`clients.${client.id}`] = true;
        return Promise.all(promises);
    }

    _createObjectsForHome(home) {
        this.log.silly(`createObjectsForHome - ${JSON.stringify(home)}`);
        let promises = [];
        // a home the cloud sent without a security solution still gets its objects
        const securityAndAlarm = (home.functionalHomes || {}).SECURITY_AND_ALARM || {};
        promises.push(this.extendObject(`homes.${home.id}`, { type: 'device', common: {}, native: {} }));

        promises.push(
            this.extendObject(`homes.${home.id}.powerMeterCurrency`, {
                type: 'state',
                common: { name: 'powerMeterCurrency', type: 'string', role: 'text', read: true, write: false },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.powerMeterUnitPrice`, {
                type: 'state',
                common: { name: 'powerMeterUnitPrice', type: 'number', role: 'level', read: true, write: true },
                native: { id: home.id, parameter: 'setPowerMeterUnitPrice', debounce: 5000 },
            }),
        );

        promises.push(
            this.extendObject(`homes.${home.id}.weather.temperature`, {
                type: 'state',
                common: {
                    name: 'temperature',
                    type: 'number',
                    role: 'value.temperature',
                    unit: '°C',
                    read: true,
                    write: false,
                },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.weather.weatherCondition`, {
                type: 'state',
                common: { name: 'weatherCondition', type: 'string', role: 'text', read: true, write: false },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.weather.weatherDayTime`, {
                type: 'state',
                common: { name: 'weatherDayTime', type: 'string', role: 'text', read: true, write: false },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.weather.minTemperature`, {
                type: 'state',
                common: {
                    name: 'minTemperature',
                    type: 'number',
                    role: 'value.temperature.min',
                    unit: '°C',
                    read: true,
                    write: false,
                },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.weather.maxTemperature`, {
                type: 'state',
                common: {
                    name: 'maxTemperature',
                    type: 'number',
                    role: 'value.temperature.max',
                    unit: '°C',
                    read: true,
                    write: false,
                },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.weather.humidity`, {
                type: 'state',
                common: {
                    name: 'humidity',
                    type: 'number',
                    role: 'value.humidity',
                    unit: '%',
                    read: true,
                    write: false,
                },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.weather.windSpeed`, {
                type: 'state',
                common: {
                    name: 'windSpeed',
                    type: 'number',
                    role: 'value.speed.wind',
                    unit: 'km/h',
                    read: true,
                    write: false,
                },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.weather.windDirection`, {
                type: 'state',
                common: {
                    name: 'windDirection',
                    type: 'number',
                    role: 'value.direction.wind',
                    unit: '°',
                    read: true,
                    write: false,
                },
                native: {},
            }),
        );

        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.securityAndAlarm.alarmEventTimestamp`, {
                type: 'state',
                common: { name: 'alarmEventTimestamp', type: 'number', role: 'value', read: true, write: false },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.securityAndAlarm.alarmEventDeviceId`, {
                type: 'state',
                common: { name: 'alarmEventDeviceId', type: 'string', role: 'text', read: true, write: false },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.securityAndAlarm.alarmEventTriggerId`, {
                type: 'state',
                common: { name: 'alarmEventTriggerId', type: 'string', role: 'text', read: true, write: false },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.securityAndAlarm.alarmEventDeviceChannel`, {
                type: 'state',
                common: { name: 'alarmEventDeviceChannel', type: 'string', role: 'text', read: true, write: false },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.securityAndAlarm.alarmSecurityJournalEntryType`, {
                type: 'state',
                common: {
                    name: 'alarmSecurityJournalEntryType',
                    type: 'string',
                    role: 'text',
                    read: true,
                    write: false,
                },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.securityAndAlarm.alarmActive`, {
                type: 'state',
                common: { name: 'alarmActive', type: 'boolean', role: 'indicator', read: true, write: false },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.securityAndAlarm.zoneActivationDelay`, {
                type: 'state',
                common: {
                    name: 'zoneActivationDelay',
                    type: 'number',
                    role: 'level.timer',
                    unit: 's',
                    read: true,
                    write: true,
                },
                native: { id: home.id, parameter: 'setZoneActivationDelay', debounce: 5000 },
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.indoorClimate.setCooling`, {
                type: 'state',
                common: { name: 'setCooling', type: 'boolean', role: 'switch', read: false, write: true },
                native: { id: home.id, parameter: 'setCooling' },
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.securityAndAlarm.intrusionAlertThroughSmokeDetectors`, {
                type: 'state',
                common: {
                    name: 'intrusionAlertThroughSmokeDetectors',
                    type: 'boolean',
                    role: 'indicator',
                    read: true,
                    write: false,
                },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.securityAndAlarm.securityZoneActivationMode`, {
                type: 'state',
                common: { name: 'securityZoneActivationMode', type: 'string', role: 'text', read: true, write: false },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.securityAndAlarm.solution`, {
                type: 'state',
                common: { name: 'solution', type: 'string', role: 'text', read: true, write: false },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.securityAndAlarm.activationInProgress`, {
                type: 'state',
                common: { name: 'activationInProgress', type: 'boolean', role: 'indicator', read: true, write: false },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.securityAndAlarm.active`, {
                type: 'state',
                common: { name: 'active', type: 'boolean', role: 'indicator', read: true, write: false },
                native: {},
            }),
        );

        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.securityAndAlarm.setOnTime`, {
                type: 'state',
                common: { name: 'setOnTime', type: 'string', role: 'text', read: true, write: true },
                native: { id: home.functionalHomes.SECURITY_AND_ALARM.functionalGroups, parameter: 'setOnTime' },
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.securityAndAlarm.testSignalOptical`, {
                type: 'state',
                common: {
                    name: 'testSignalOptical',
                    type: 'string',
                    role: 'text',
                    read: true,
                    write: true,
                    states: {
                        DISABLE_OPTICAL_SIGNAL: 'DISABLE_OPTICAL_SIGNAL',
                        BLINKING_ALTERNATELY_REPEATING: 'BLINKING_ALTERNATELY_REPEATING',
                        BLINKING_BOTH_REPEATING: 'BLINKING_BOTH_REPEATING',
                        DOUBLE_FLASHING_REPEATING: 'DOUBLE_FLASHING_REPEATING',
                        FLASHING_BOTH_REPEATING: 'FLASHING_BOTH_REPEATING',
                        CONFIRMATION_SIGNAL_0: 'CONFIRMATION_SIGNAL_0',
                        CONFIRMATION_SIGNAL_1: 'CONFIRMATION_SIGNAL_1',
                        CONFIRMATION_SIGNAL_2: 'CONFIRMATION_SIGNAL_2',
                    },
                },
                native: {
                    id: home.functionalHomes.SECURITY_AND_ALARM.securitySwitchingGroups,
                    parameter: 'testSignalOptical',
                },
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.securityAndAlarm.setSignalOptical`, {
                type: 'state',
                common: {
                    name: 'setSignalOptical',
                    type: 'string',
                    role: 'text',
                    read: true,
                    write: true,
                    states: {
                        DISABLE_OPTICAL_SIGNAL: 'DISABLE_OPTICAL_SIGNAL',
                        BLINKING_ALTERNATELY_REPEATING: 'BLINKING_ALTERNATELY_REPEATING',
                        BLINKING_BOTH_REPEATING: 'BLINKING_BOTH_REPEATING',
                        DOUBLE_FLASHING_REPEATING: 'DOUBLE_FLASHING_REPEATING',
                        FLASHING_BOTH_REPEATING: 'FLASHING_BOTH_REPEATING',
                        CONFIRMATION_SIGNAL_0: 'CONFIRMATION_SIGNAL_0',
                        CONFIRMATION_SIGNAL_1: 'CONFIRMATION_SIGNAL_1',
                        CONFIRMATION_SIGNAL_2: 'CONFIRMATION_SIGNAL_2',
                    },
                },
                native: {
                    id: home.functionalHomes.SECURITY_AND_ALARM.securitySwitchingGroups,
                    parameter: 'setSignalOptical',
                },
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.securityAndAlarm.testSignalAcoustic`, {
                type: 'state',
                common: {
                    name: 'testSignalAcoustic',
                    type: 'string',
                    role: 'text',
                    read: true,
                    write: true,
                    states: {
                        DISABLE_ACOUSTIC_SIGNAL: 'DISABLE_ACOUSTIC_SIGNAL',
                        FREQUENCY_RISING: 'FREQUENCY_RISING',
                        FREQUENCY_FALLING: 'FREQUENCY_FALLING',
                        FREQUENCY_RISING_AND_FALLING: 'FREQUENCY_RISING_AND_FALLING',
                        FREQUENCY_ALTERNATING_LOW_HIGH: 'FREQUENCY_ALTERNATING_LOW_HIGH',
                        FREQUENCY_ALTERNATING_LOW_MID_HIGH: 'FREQUENCY_ALTERNATING_LOW_MID_HIGH',
                        FREQUENCY_HIGHON_OFF: 'FREQUENCY_HIGHON_OFF',
                        FREQUENCY_HIGHON_LONGOFF: 'FREQUENCY_HIGHON_LONGOFF',
                        FREQUENCY_LOWON_OFF_HIGHON_OFF: 'FREQUENCY_LOWON_OFF_HIGHON_OFF',
                        FREQUENCY_LOWON_LONGOFF_HIGHON_LONGOFF: 'FREQUENCY_LOWON_LONGOFF_HIGHON_LONGOFF',
                        LOW_BATTERY: 'LOW_BATTERY',
                        DISARMED: 'DISARMED',
                        INTERNALLY_ARMED: 'INTERNALLY_ARMED',
                        EXTERNALLY_ARMED: 'EXTERNALLY_ARMED',
                        DELAYED_INTERNALLY_ARMED: 'DELAYED_INTERNALLY_ARMED',
                        DELAYED_EXTERNALLY_ARMED: 'DELAYED_EXTERNALLY_ARMED',
                        EVENT: 'EVENT',
                        ERROR: 'ERROR',
                    },
                },
                native: {
                    id: home.functionalHomes.SECURITY_AND_ALARM.securitySwitchingGroups,
                    parameter: 'testSignalAcoustic',
                },
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.securityAndAlarm.setSignalAcoustic`, {
                type: 'state',
                common: {
                    name: 'setSignalAcoustic',
                    type: 'string',
                    role: 'text',
                    read: true,
                    write: true,
                    states: {
                        DISABLE_ACOUSTIC_SIGNAL: 'DISABLE_ACOUSTIC_SIGNAL',
                        FREQUENCY_RISING: 'FREQUENCY_RISING',
                        FREQUENCY_FALLING: 'FREQUENCY_FALLING',
                        FREQUENCY_RISING_AND_FALLING: 'FREQUENCY_RISING_AND_FALLING',
                        FREQUENCY_ALTERNATING_LOW_HIGH: 'FREQUENCY_ALTERNATING_LOW_HIGH',
                        FREQUENCY_ALTERNATING_LOW_MID_HIGH: 'FREQUENCY_ALTERNATING_LOW_MID_HIGH',
                        FREQUENCY_HIGHON_OFF: 'FREQUENCY_HIGHON_OFF',
                        FREQUENCY_HIGHON_LONGOFF: 'FREQUENCY_HIGHON_LONGOFF',
                        FREQUENCY_LOWON_OFF_HIGHON_OFF: 'FREQUENCY_LOWON_OFF_HIGHON_OFF',
                        FREQUENCY_LOWON_LONGOFF_HIGHON_LONGOFF: 'FREQUENCY_LOWON_LONGOFF_HIGHON_LONGOFF',
                        LOW_BATTERY: 'LOW_BATTERY',
                        DISARMED: 'DISARMED',
                        INTERNALLY_ARMED: 'INTERNALLY_ARMED',
                        EXTERNALLY_ARMED: 'EXTERNALLY_ARMED',
                        DELAYED_INTERNALLY_ARMED: 'DELAYED_INTERNALLY_ARMED',
                        DELAYED_EXTERNALLY_ARMED: 'DELAYED_EXTERNALLY_ARMED',
                        EVENT: 'EVENT',
                        ERROR: 'ERROR',
                    },
                },
                native: {
                    id: home.functionalHomes.SECURITY_AND_ALARM.securitySwitchingGroups,
                    parameter: 'setSignalAcoustic',
                },
            }),
        );

        promises.push(
            this.extendObject(
                `homes.${home.id}.functionalHomes.securityAndAlarm.setIntrusionAlertThroughSmokeDetectors`,
                {
                    type: 'state',
                    common: {
                        name: 'setIntrusionAlertThroughSmokeDetectors',
                        type: 'boolean',
                        role: 'button',
                        read: false,
                        write: true,
                    },
                    native: { parameter: 'setIntrusionAlertThroughSmokeDetectors' },
                },
            ),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.securityAndAlarm.setSecurityZonesActivationNone`, {
                type: 'state',
                common: {
                    name: 'setSecurityZonesActivationNone',
                    type: 'boolean',
                    role: 'button',
                    read: false,
                    write: true,
                },
                native: { parameter: 'setSecurityZonesActivationNone' },
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.securityAndAlarm.setSecurityZonesActivationInternal`, {
                type: 'state',
                common: {
                    name: 'setSecurityZonesActivationInternal',
                    type: 'boolean',
                    role: 'button',
                    read: false,
                    write: true,
                },
                native: { parameter: 'setSecurityZonesActivationInternal' },
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.securityAndAlarm.setSecurityZonesActivationExternal`, {
                type: 'state',
                common: {
                    name: 'setSecurityZonesActivationExternal',
                    type: 'boolean',
                    role: 'button',
                    read: false,
                    write: true,
                },
                native: { parameter: 'setSecurityZonesActivationExternal' },
            }),
        );
        promises.push(
            this.extendObject(
                `homes.${home.id}.functionalHomes.securityAndAlarm.setSecurityZonesActivationInternalAndExternal`,
                {
                    type: 'state',
                    common: {
                        name: 'setSecurityZonesActivationInternalAndExternal',
                        type: 'boolean',
                        role: 'button',
                        read: false,
                        write: true,
                    },
                    native: { parameter: 'setSecurityZonesActivationInternalAndExternal' },
                },
            ),
        );

        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.indoorClimate.absenceType`, {
                type: 'state',
                common: { name: 'absenceType', type: 'string', role: 'text', read: true, write: false },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.indoorClimate.absenceEndTime`, {
                type: 'state',
                common: { name: 'absenceEndTime', type: 'string', role: 'text', read: true, write: false },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.indoorClimate.ecoTemperature`, {
                type: 'state',
                common: { name: 'ecoTemperature', type: 'number', role: 'value', read: true, write: false },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.indoorClimate.coolingEnabled`, {
                type: 'state',
                common: { name: 'coolingEnabled', type: 'boolean', role: 'indicator', read: true, write: false },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.indoorClimate.ecoDuration`, {
                type: 'state',
                common: { name: 'ecoDuration', type: 'string', role: 'text', read: true, write: false },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.indoorClimate.optimumStartStopEnabled`, {
                type: 'state',
                common: {
                    name: 'optimumStartStopEnabled',
                    type: 'boolean',
                    role: 'indicator',
                    read: true,
                    write: false,
                },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.indoorClimate.solution`, {
                type: 'state',
                common: { name: 'solution', type: 'string', role: 'text', read: true, write: false },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.indoorClimate.active`, {
                type: 'state',
                common: { name: 'active', type: 'boolean', role: 'indicator', read: true, write: false },
                native: {},
            }),
        );

        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.indoorClimate.vacationTemperature`, {
                type: 'state',
                common: { name: 'vacationTemperature', type: 'number', role: 'level', read: true, write: false },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.indoorClimate.activateVacationWithEndTime`, {
                type: 'state',
                common: { name: 'activateVacationWithEndTime', type: 'string', role: 'text', read: false, write: true },
                native: { id: home.id, parameter: 'activateVacation' },
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.indoorClimate.deactivateVacation`, {
                type: 'state',
                common: { name: 'deactivateVacation', type: 'boolean', role: 'button', read: false, write: true },
                native: { parameter: 'deactivateVacation' },
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.indoorClimate.setAbsenceEndTime`, {
                type: 'state',
                common: { name: 'setAbsenceEndTime', type: 'string', role: 'text', read: false, write: true },
                native: { parameter: 'setAbsenceEndTime' },
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.indoorClimate.setAbsenceDuration`, {
                type: 'state',
                common: { name: 'setAbsenceDuration', type: 'string', role: 'text', read: false, write: true },
                native: { parameter: 'setAbsenceDuration' },
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.indoorClimate.deactivateAbsence`, {
                type: 'state',
                common: { name: 'deactivateAbsence', type: 'boolean', role: 'button', read: false, write: true },
                native: { parameter: 'deactivateAbsence' },
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.indoorClimate.activateAbsencePermanent`, {
                type: 'state',
                common: { name: 'activateAbsencePermanent', type: 'boolean', role: 'button', read: false, write: true },
                native: { parameter: 'setAbsencePermanent' },
            }),
        );

        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.lightAndShadow.active`, {
                type: 'state',
                common: { name: 'active', type: 'boolean', role: 'indicator', read: true, write: false },
                native: {},
            }),
        );

        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.weatherAndEnvironment.active`, {
                type: 'state',
                common: { name: 'active', type: 'boolean', role: 'indicator', read: true, write: false },
                native: {},
            }),
        );

        return Promise.all(promises);
    }
}

// If started as allInOne/compact mode => return function to create instance
if (module && module.parent) {
    module.exports = options => new HmIpCloudAccesspointAdapter(options);
} else {
    // or start the instance directly
    new HmIpCloudAccesspointAdapter();
}
