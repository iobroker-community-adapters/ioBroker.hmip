import { Adapter, type AdapterOptions } from '@iobroker/adapter-core';
import { randomUUID } from 'node:crypto';
import { HmCloudAPI } from './lib/hmCloudAPI';
import {
    CHANNEL_STATES,
    STATELESS_CHANNELS,
    CHANNEL_EVENTS,
    CODE_STATES,
    CODE_STATE_CHANNELS,
    EVENT_CHANNELS,
    channelStateObjects,
    channelStateValues,
} from './lib/channelStates';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type {
    ChannelEvent,
    ChannelStateNative,
    CloudEvent,
    CodeStateEvent,
    DispatchObject,
    HmIpClient,
    HmIpDevice,
    HmIpGroup,
    HmIpHome,
    HmIpRule,
    HmIpCurrentState,
    SecurityJournalEntry,
} from './lib/types';

// the compiled adapter lives in build/, so package.json is no longer a sibling of this file;
// the name it used to be read from is fixed and matches common.name in io-package.json
const adapterName = 'hmip';

// the home's alarm fields only arrive with a full read, which answers with every device in the
// home, so a panel raising the security journal event every few minutes must not drive one each time
const HOME_REREAD_INTERVAL = 300000;

// a read that failed published nothing, so it must not reserve the whole interval
const HOME_READ_RETRY_INTERVAL = 30000;

// what a mode selected in activateSecurityZones asks of the classic internal/external pair;
// homeSetZonesActivation maps that onto a request-based panel's ABSENCE/PRESENCE zones
const SECURITY_ZONE_MODES = Object.assign(Object.create(null), {
    OFF: { internal: false, external: false },
    PRESENCE: { internal: false, external: true },
    ABSENCE: { internal: true, external: true },
    INTERNAL: { internal: true, external: false },
    EXTERNAL: { internal: false, external: true },
    INTERNAL_AND_EXTERNAL: { internal: true, external: true },
});

// every heating group carries these six, whether or not the payload of the moment lists them;
// HmIP drives 1-3 as the heating profiles and 4-6 as the cooling profiles
const PROFILE_INDEXES = ['PROFILE_1', 'PROFILE_2', 'PROFILE_3', 'PROFILE_4', 'PROFILE_5', 'PROFILE_6'];

// a profile nobody renamed answers with an empty name, while the app shows the default the
// manufacturer gives it, so the adapter publishes what the user sees rather than an empty string
const DEFAULT_PROFILE_NAMES = {
    de: {
        PROFILE_1: 'Standardprofil',
        PROFILE_2: 'Alternativprofil 1',
        PROFILE_3: 'Alternativprofil 2',
        PROFILE_4: 'Kühlprofil',
        PROFILE_5: 'Kühlprofil 2',
        PROFILE_6: 'Kühlprofil 3',
    },
    en: {
        PROFILE_1: 'Standard profile',
        PROFILE_2: 'Alternative profile 1',
        PROFILE_3: 'Alternative profile 2',
        PROFILE_4: 'Cooling profile',
        PROFILE_5: 'Cooling profile 2',
        PROFILE_6: 'Cooling profile 3',
    },
};

/** the part of the Sentry plugin object this adapter uses */
interface SentryLike {
    withScope: (
        callback: (scope: {
            setLevel: (level: string) => void;
            setExtra: (key: string, value: string) => void;
        }) => void,
    ) => void;
    captureMessage: (message: string, level?: string) => void;
}

/** what axios hands over when a request failed */
interface RequestFailure {
    response?: { data?: unknown; status?: number };
    request?: unknown;
    message?: string;
}

/** one entry of the per-datapoint write throttle */
interface DelayTimeout {
    timeout?: ioBroker.Timeout;
    lastVal?: ioBroker.StateValue;
}

/** where a pairing attempt stands, as the admin dialog polls it */
interface RequestTokenState {
    state: 'idle' | 'startedTokenCreation' | 'waitForBlueButton' | 'confirmToken' | 'tokenCreated' | 'errorOccurred';
    error?: unknown;
}

class HmIpCloudAccesspointAdapter extends Adapter {
    private readonly _api: HmCloudAPI;

    private _unloaded = false;
    private _requestTokenState: RequestTokenState = { state: 'idle' };
    private _homeReadInterval = HOME_REREAD_INTERVAL;
    private _homeReadRetryInterval = HOME_READ_RETRY_INTERVAL;
    private _nextHomeRead = 0;
    private _homeReadRunning = false;
    private _homeReadPending = false;
    private _homePublishSeq = 0;
    private _dataEpoch = 0;
    private _journalReadRunning = false;
    private _journalReadPending = false;

    private wsConnected = false;
    private wsConnectionStableTimeout: ioBroker.Timeout | undefined;
    private wsConnectionErrorCounter = 0;
    private expectWsError: ioBroker.Timeout | undefined;
    private reInitTimeout: ioBroker.Timeout | undefined;
    private reInitDataTimeout: ioBroker.Timeout | undefined;

    /** channel types already reported as unknown, so each one is reported once */
    private sendUnknownInfos: Record<string, boolean> = {};
    /** the acknowledged value of every datapoint, so an unchanged write is not sent on */
    private currentValues: Record<string, ioBroker.StateValue> = {};
    private delayTimeouts: Record<string, DelayTimeout> = {};
    /** objects that have been built, so states are only written onto objects that exist */
    private initializedChannels: Record<string, boolean> = {};
    /** the language the default profile names are published in */
    private profileNameLanguage: keyof typeof DEFAULT_PROFILE_NAMES = 'en';

    private Sentry: SentryLike | null = null;

    public constructor(options: Partial<AdapterOptions> = {}) {
        super({ ...options, name: adapterName });

        this._api = new HmCloudAPI();
        this._api.eventRaised = event => void this._eventRaised(event as CloudEvent);
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
    }

    _unload(callback: () => void): void {
        this._unloaded = true;
        this.expectWsError && this.clearTimeout(this.expectWsError);
        this.reInitTimeout && this.clearTimeout(this.reInitTimeout);
        this.reInitDataTimeout && this.clearTimeout(this.reInitDataTimeout);
        for (const pending of Object.values(this.delayTimeouts)) {
            pending && pending.timeout && this.clearTimeout(pending.timeout);
        }
        this.delayTimeouts = {};
        this._api.dispose();
        try {
            this.log.info('cleaned everything up...');
            callback();
        } catch {
            callback();
        }
    }

    _objectChange(id: string, obj: ioBroker.Object | null | undefined): void {
        this.log.info(`objectChange ${id} ${JSON.stringify(obj)}`);
    }

    async _message(msg: ioBroker.Message): Promise<void> {
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

    /**
     * setNonCoolingGroups takes the whole set rather than the group that just changed, so every
     * group that is ignored for cooling is collected, the one being written among them: it is
     * already in the states database, unacknowledged, by the time the change reaches the adapter.
     */
    async _updateNonCoolingGroups(): Promise<void> {
        const states = await this.getStatesAsync('groups.*.coolingIgnored');
        const prefix = `${this.namespace}.`;
        const nonCoolingGroups = [];
        for (const id of Object.keys(states)) {
            const state = states[id];
            if (!state || state.val !== true) {
                continue;
            }
            // <namespace>.groups.<groupId>.coolingIgnored, and a controller that answers without one
            const path = id.startsWith(prefix) ? id.substring(prefix.length) : id;
            nonCoolingGroups.push(path.split('.')[1]);
        }
        this.log.debug(`Sending nonCoolingGroups: ${JSON.stringify(nonCoolingGroups)}`);
        await this._api.homeHeatingSetNonCoolingGroups(nonCoolingGroups);
    }

    async _startTokenRequest(msg: ioBroker.Message): Promise<void> {
        try {
            this.log.info('started token request');
            const config = msg.message;
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
                this._requestTokenState = { ...this._api.getSaveData(), state: 'tokenCreated' };
            }
        } catch (err) {
            this._requestTokenState = { state: 'errorOccurred' };
            this.log.error(`error requesting token: ${String(err)}`);
        }
    }

    async _ready(): Promise<void> {
        // set UUID if not set
        if (!this.config.deviceId) {
            const config = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
            if (!config) {
                this.log.error(`Cannot read system.adapter.${this.namespace}`);
                return;
            }
            config.native.deviceId = randomUUID();
            await this.setForeignObjectAsync(config._id, config);
            return;
        }

        this.reInitTimeout && this.clearTimeout(this.reInitTimeout);
        this.log.debug('ready');

        // the default profile names are published in the language the user reads the rest of ioBroker in
        const systemConfig = await this.getForeignObjectAsync('system.config');
        const language = systemConfig?.common?.language;
        this.profileNameLanguage = language === 'de' ? 'de' : 'en';
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
                this.log.error(`error starting Homematic: ${String(err)}`);
                this.log.error('Try reconnect in 30s');
                this.reInitTimeout && this.clearTimeout(this.reInitTimeout);
                this.reInitTimeout = this.setTimeout(() => {
                    this.reInitTimeout = null;
                    void this._ready();
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

    async _initData(): Promise<void> {
        await this._api.loadCurrentConfig();
        // a read that started before this snapshot answers for the configuration it replaces
        this._dataEpoch++;
        this._nextHomeRead = performance.now() + this._homeReadInterval;
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
            for (const d in this._api.devices) {
                if (!Object.prototype.hasOwnProperty.call(this._api.devices, d)) {
                    continue;
                }
                await this._updateDeviceStates(this._api.devices[d]);
            }
        } else {
            this.log.debug('No devices');
        }
        if (this._api.groups) {
            for (const g in this._api.groups) {
                if (!Object.prototype.hasOwnProperty.call(this._api.groups, g)) {
                    continue;
                }
                await this._updateGroupStates(this._api.groups[g]);
            }
        } else {
            this.log.debug('No groups');
        }
        if (this._api.clients) {
            for (const c in this._api.clients) {
                if (!Object.prototype.hasOwnProperty.call(this._api.clients, c)) {
                    continue;
                }
                await this._updateClientStates(this._api.clients[c]);
            }
        } else {
            this.log.debug('No clients');
        }
        if (this._api.rules) {
            for (const r in this._api.rules) {
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

    round(value: number, step: number): number {
        step = step || 1.0;
        const inv = 1.0 / step;
        return Math.round(value * inv) / inv;
    }

    async _doStateChange(id: string, o: DispatchObject, state: ioBroker.State): Promise<void> {
        // a device command addresses one device and one channel; the states that act on the
        // channel's groups carry a list of group ids in native.id and go through _targetGroups
        const deviceId = o.native.id as string;
        const channel = o.native.channel;
        try {
            switch (o.native.parameter) {
                case 'switchState':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceControlSetSwitchState(deviceId, state.val as boolean, channel);
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
                    await this._api.deviceControlSendDoorCommand(deviceId, state.val, channel);
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
                        const pin = await this._channelState(o.native, 'pin');
                        this.log.info(`Call setLockState for ${state.val} ${pin.val ? 'with' : 'without'} PIN`);
                        await this._api.deviceControlSetLockState(
                            deviceId,
                            state.val,
                            pin.val as string | null | undefined,
                            channel,
                        );
                    }
                    break;
                case 'resetEnergyCounter':
                    await this._api.deviceControlResetEnergyCounter(deviceId, channel);
                    break;
                case 'startImpulse':
                    await this._api.deviceControlStartImpulse(deviceId, channel);
                    break;
                case 'shutterlevel':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceControlSetShutterLevel(
                        deviceId,
                        this._levelFraction(state.val) as number,
                        channel,
                    );
                    break;
                case 'slatsLevel':
                    {
                        const slats = await this._channelState(o.native, 'slatsLevel');
                        const shutter = await this._channelState(o.native, 'shutterLevel');
                        if (
                            slats.val === this.currentValues[slats.id] &&
                            shutter.val === this.currentValues[shutter.id]
                        ) {
                            this.log.info(`Value unchanged, do not send this value`);
                            await this.secureSetStateAsync(id, this.currentValues[id], true);
                            return;
                        }
                        await this._api.deviceControlSetSlatsLevel(
                            deviceId,
                            this._levelFraction(slats.val) as number,
                            this._levelFraction(shutter.val) as number,
                            channel,
                        );
                    }
                    break;
                case 'setPrimaryShadingLevel':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceControlSetPrimaryShadingLevel(
                        deviceId,
                        this._levelFraction(state.val) as number,
                        channel,
                    );
                    break;
                case 'setSecondaryShadingLevel':
                    {
                        const primary = await this._channelState(o.native, 'primaryShadingLevel');
                        const secondary = await this._channelState(o.native, 'secondaryShadingLevel');
                        if (
                            primary.val === this.currentValues[primary.id] &&
                            secondary.val === this.currentValues[secondary.id]
                        ) {
                            this.log.info(`Value unchanged, do not send this value`);
                            await this.secureSetStateAsync(id, this.currentValues[id], true);
                            return;
                        }
                        await this._api.deviceControlSetSecondaryShadingLevel(
                            deviceId,
                            this._levelFraction(primary.val) as number,
                            this._levelFraction(secondary.val) as number,
                            channel,
                        );
                    }
                    break;
                case 'stop':
                    await this._api.deviceControlStop(deviceId, channel);
                    break;
                case 'setPointTemperature':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    for (const id of this._targetGroups(o.native, o.native.parameter)) {
                        await this._api.groupHeatingSetPointTemperature(id, state.val as number);
                    }
                    break;
                case 'setBoost':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    for (const id of this._targetGroups(o.native, o.native.parameter)) {
                        await this._api.groupHeatingSetBoost(id, state.val as boolean);
                    }
                    break;
                case 'setBoostDuration':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    for (const id of this._targetGroups(o.native, o.native.parameter)) {
                        await this._api.groupHeatingSetBoostDuration(id, state.val as number);
                    }
                    break;
                case 'setActiveProfile':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    for (const id of this._targetGroups(o.native, o.native.parameter)) {
                        await this._api.groupHeatingSetActiveProfile(id, state.val as string);
                    }
                    break;
                case 'setControlMode':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    for (const id of this._targetGroups(o.native, o.native.parameter)) {
                        await this._api.groupHeatingSetControlMode(id, state.val as string);
                    }
                    break;
                case 'setOperationLock':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceConfigurationSetOperationLock(deviceId, state.val as boolean, channel);
                    break;
                case 'setClimateControlDisplay':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceConfigurationSetClimateControlDisplay(deviceId, state.val as string, channel);
                    break;
                case 'setMinimumFloorHeatingValvePosition':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceConfigurationSetMinimumFloorHeatingValvePosition(
                        deviceId,
                        this._levelFraction(state.val) as number,
                        channel,
                    );
                    break;
                case 'setDimLevel':
                    {
                        const times = await this._controlTimes(o.native);
                        if (state.val === this.currentValues[id] && !times.timed) {
                            this.log.info(`Value unchanged, do not send this value`);
                            await this.secureSetStateAsync(id, this.currentValues[id], true);
                            return;
                        }
                        const dimLevel = this._levelFraction(state.val);
                        if (times.timed) {
                            await this._api.deviceControlSetDimLevelWithTime(
                                deviceId,
                                dimLevel as number,
                                times.onTime,
                                times.rampTime,
                                channel,
                            );
                        } else {
                            await this._api.deviceControlSetDimLevel(deviceId, dimLevel as number, channel);
                        }
                    }
                    break;
                case 'setRgbDimLevel':
                    {
                        const rgb = await this._channelState(o.native, 'simpleRGBColorState');
                        const dimLevel = await this._channelState(o.native, 'dimLevel');
                        const times = await this._controlTimes(o.native);
                        if (
                            rgb.val === this.currentValues[rgb.id] &&
                            dimLevel.val === this.currentValues[dimLevel.id] &&
                            !times.timed
                        ) {
                            this.log.info(`Value unchanged, do not send this value`);
                            await this.secureSetStateAsync(id, this.currentValues[id], true);
                            return;
                        }
                        const dimLevelValue = this._levelFraction(dimLevel.val);
                        if (times.timed) {
                            await this._api.deviceControlSetRgbDimLevelWithTime(
                                deviceId,
                                rgb.val as string,
                                dimLevelValue as number,
                                times.onTime,
                                times.rampTime,
                                channel,
                            );
                        } else {
                            await this._api.deviceControlSetRgbDimLevel(
                                deviceId,
                                rgb.val as string,
                                dimLevelValue as number,
                                channel,
                            );
                        }
                    }
                    break;
                case 'toggleWateringState':
                    await this._api.deviceControlToggleWateringState(deviceId, channel);
                    break;
                case 'resetWaterVolume':
                    await this._api.deviceControlResetWaterVolume(deviceId, channel);
                    break;
                case 'resetPassageCounter':
                    await this._api.deviceControlResetPassageCounter(deviceId, channel);
                    break;
                case 'setFavoriteShadingPosition':
                    await this._api.deviceControlSetFavoriteShadingPosition(deviceId, channel);
                    break;
                case 'setMotionDetectionActive':
                    await this._api.deviceControlSetMotionDetectionActive(deviceId, state.val as boolean, channel);
                    break;
                case 'pullLatch':
                    {
                        const latchPin = await this.getStateAsync(
                            `devices.${String(o.native.id)}.channels.${channel}.pin`,
                        );
                        await this._api.deviceControlPullLatch(
                            deviceId,
                            (latchPin ? latchPin.val : '') as string | undefined,
                            channel,
                        );
                    }
                    break;
                case 'setSoundFileVolumeLevel':
                    {
                        const base = `devices.${String(o.native.id)}.channels.${channel}`;
                        const soundFile = await this.getStateAsync(`${base}.soundFile`);
                        const volumeLevel = await this.getStateAsync(`${base}.volumeLevel`);
                        await this._api.deviceControlSetSoundFileVolumeLevel(
                            deviceId,
                            (soundFile ? soundFile.val : null) as string,
                            (volumeLevel ? volumeLevel.val : null) as number,
                            channel,
                        );
                    }
                    break;
                case 'startLightScene':
                    {
                        const base = `devices.${String(o.native.id)}.channels.${channel}`;
                        const sceneId = await this.getStateAsync(`${base}.lightSceneId`);
                        const sceneDimLevel = await this.getStateAsync(`${base}.dimLevel`);
                        await this._api.deviceControlStartLightScene(
                            deviceId,
                            (sceneId ? sceneId.val : null) as number,
                            this._levelFraction(sceneDimLevel ? sceneDimLevel.val : null) as number,
                            channel,
                        );
                    }
                    break;
                case 'setWateringSwitchState':
                    {
                        const times = await this._controlTimes(o.native);
                        if (times.onTime > 0) {
                            await this._api.deviceControlSetWateringSwitchStateWithTime(
                                deviceId,
                                state.val as boolean,
                                times.onTime,
                                channel,
                            );
                        } else {
                            await this._api.deviceControlSetWateringSwitchState(
                                deviceId,
                                state.val as boolean,
                                channel,
                            );
                        }
                    }
                    break;
                case 'setHueSaturationDimLevel':
                    {
                        const base = `devices.${String(o.native.id)}.channels.${channel}`;
                        const hue = await this.getStateAsync(`${base}.hue`);
                        const saturation = await this.getStateAsync(`${base}.saturationLevel`);
                        const dimLevel = await this.getStateAsync(`${base}.dimLevel`);
                        const dimLevelValue = this._levelFraction(dimLevel ? dimLevel.val : null);
                        const times = await this._controlTimes(o.native);
                        if (times.timed) {
                            await this._api.deviceControlSetHueSaturationDimLevelWithTime(
                                deviceId,
                                (hue ? hue.val : null) as number,
                                (saturation ? saturation.val : null) as number,
                                dimLevelValue as number,
                                times.onTime,
                                times.rampTime,
                                channel,
                            );
                        } else {
                            await this._api.deviceControlSetHueSaturationDimLevel(
                                deviceId,
                                (hue ? hue.val : null) as number,
                                (saturation ? saturation.val : null) as number,
                                dimLevelValue as number,
                                channel,
                            );
                        }
                    }
                    break;
                case 'setColorTemperatureDimLevel':
                    {
                        const base = `devices.${String(o.native.id)}.channels.${channel}`;
                        const colorTemperature = await this.getStateAsync(`${base}.colorTemperature`);
                        const dimLevel = await this.getStateAsync(`${base}.dimLevel`);
                        const dimLevelValue = this._levelFraction(dimLevel ? dimLevel.val : null);
                        const times = await this._controlTimes(o.native);
                        if (times.timed) {
                            await this._api.deviceControlSetColorTemperatureDimLevelWithTime(
                                deviceId,
                                (colorTemperature ? colorTemperature.val : null) as number,
                                dimLevelValue as number,
                                times.onTime,
                                times.rampTime,
                                channel,
                            );
                        } else {
                            await this._api.deviceControlSetColorTemperatureDimLevel(
                                deviceId,
                                (colorTemperature ? colorTemperature.val : null) as number,
                                dimLevelValue as number,
                                channel,
                            );
                        }
                    }
                    break;
                case 'setOpticalSignalBehaviour':
                    {
                        const rgb = await this._channelState(o.native, 'simpleRGBColorState');
                        const dimLevel = await this._channelState(o.native, 'dimLevel');
                        const opticalSignal = await this._channelState(o.native, 'opticalSignalBehaviour');
                        const times = await this._controlTimes(o.native);
                        if (
                            rgb.val === this.currentValues[rgb.id] &&
                            dimLevel.val === this.currentValues[dimLevel.id] &&
                            !times.timed
                        ) {
                            this.log.info(`Value unchanged, do not send this value`);
                            await this.secureSetStateAsync(id, this.currentValues[id], true);
                            return;
                        }
                        const dimLevelValue = this._levelFraction(dimLevel.val);
                        if (times.timed) {
                            await this._api.deviceControlSetOpticalSignalWithTime(
                                deviceId,
                                opticalSignal.val as string,
                                rgb.val as string,
                                dimLevelValue as number,
                                times.onTime,
                                times.rampTime,
                                channel,
                            );
                        } else {
                            await this._api.deviceControlOpticalSignalBehaviour(
                                deviceId,
                                rgb.val as string,
                                dimLevelValue as number,
                                channel as number | undefined,
                                opticalSignal.val as string,
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
                    await this._api.deviceConfigurationSetAcousticAlarmSignal(deviceId, state.val as string, channel);
                    break;
                case 'setAcousticAlarmTiming':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceConfigurationSetAcousticAlarmTiming(deviceId, state.val as string, channel);
                    break;
                case 'setAcousticWaterAlarmTrigger':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceConfigurationSetAcousticWaterAlarmTrigger(
                        deviceId,
                        state.val as string,
                        channel,
                    );
                    break;
                case 'setInAppWaterAlarmTrigger':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceConfigurationSetInAppWaterAlarmTrigger(
                        deviceId,
                        state.val as string,
                        channel,
                    );
                    break;
                case 'setSirenWaterAlarmTrigger':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceConfigurationSetSirenWaterAlarmTrigger(
                        deviceId,
                        state.val as string,
                        channel,
                    );
                    break;
                case 'setAccelerationSensorMode':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceConfigurationSetAccelerationSensorMode(
                        deviceId,
                        state.val as string,
                        channel,
                    );
                    break;
                case 'setAccelerationSensorNeutralPosition':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceConfigurationSetAccelerationSensorNeutralPosition(
                        deviceId,
                        state.val as string,
                        channel,
                    );
                    break;
                case 'setAccelerationSensorTriggerAngle':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceConfigurationSetAccelerationSensorTriggerAngle(
                        deviceId,
                        state.val as number,
                        channel,
                    );
                    break;
                case 'setAccelerationSensorSensitivity':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceConfigurationSetAccelerationSensorSensitivity(
                        deviceId,
                        state.val as string,
                        channel,
                    );
                    break;
                case 'setAccelerationSensorEventFilterPeriod':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceConfigurationSetAccelerationSensorEventFilterPeriod(
                        deviceId,
                        state.val as number,
                        channel,
                    );
                    break;
                case 'setNotificationSoundType':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceConfigurationSetNotificationSoundType(
                        deviceId,
                        state.val as string,
                        id.endsWith('HighToLow'),
                        channel,
                    );
                    break;
                case 'setRouterModuleEnabled':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.deviceConfigurationSetRouterModuleEnabled(deviceId, state.val as boolean, channel);
                    break;
                case 'setAbsenceEndTime':
                    await this._api.homeHeatingActivateAbsenceWithPeriod(state.val as string);
                    break;
                case 'setAbsenceDuration':
                    await this._api.homeHeatingActivateAbsenceWithDuration(state.val as number);
                    break;
                case 'deactivateAbsence':
                    await this._api.homeHeatingDeactivateAbsence();
                    break;
                case 'setAbsencePermanent':
                    await this._api.homeHeatingActivateAbsencePermanent();
                    break;
                case 'coolingEnabled':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.homeHeatingSetCoolingEnabled(state.val as boolean);
                    break;
                case 'coolingIgnored':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._updateNonCoolingGroups();
                    break;
                case 'setIntrusionAlertThroughSmokeDetectors':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.homeSetIntrusionAlertThroughSmokeDetectors(state.val as boolean);
                    break;
                case 'activateVacation':
                    {
                        const vacTemp = await this.getStateAsync(
                            `homes.${String(o.native.id)}.functionalHomes.indoorClimate.vacationTemperature`,
                        );
                        if (!vacTemp || vacTemp.val === null || vacTemp.val === undefined) {
                            this.log.warn(
                                'Set functionalHomes.indoorClimate.vacationTemperature before activating vacation mode.',
                            );
                            return;
                        }
                        await this._api.homeHeatingActivateVacation(vacTemp.val as number, state.val as string);
                    }
                    break;
                case 'deactivateVacation':
                    await this._api.homeHeatingDeactivateVacation();
                    break;
                case 'activateSecurityZones': {
                    // scripts and widgets write the mode in whatever case they please
                    const mode = SECURITY_ZONE_MODES[String(state.val).trim().toUpperCase()];
                    if (!mode) {
                        this.log.info(`Ignore invalid value for activateSecurityZones: ${state.val}`);
                        return;
                    }
                    await this._setSecurityZonesActivation(mode.internal, mode.external);
                    break;
                }
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
                    await this._api.groupSwitchingSetState(deviceId, state.val as boolean);
                    break;
                case 'groupShutterLevel':
                    await this._api.groupSwitchingSetShutterLevel(deviceId, state.val as number);
                    break;
                case 'groupSlatsLevel':
                    {
                        const groupShutter = await this.getStateAsync(`groups.${String(o.native.id)}.shutterLevel`);
                        await this._api.groupSwitchingSetSlatsLevel(
                            deviceId,
                            state.val as number,
                            (groupShutter ? groupShutter.val : null) as number,
                        );
                    }
                    break;
                case 'groupStop':
                    await this._api.groupSwitchingStop(deviceId);
                    break;
                case 'setCooling':
                    await this._api.homeHeatingSetCooling(state.val as boolean);
                    break;
                case 'setZoneActivationDelay':
                    await this._api.homeSetZoneActivationDelay(state.val as number);
                    break;
                case 'setOnTime':
                    for (const id of this._targetGroups(o.native, o.native.parameter)) {
                        await this._api.groupSwitchingAlarmSetOnTime(id, state.val as number);
                    }
                    break;
                case 'testSignalOptical':
                    for (const id of this._targetGroups(o.native, o.native.parameter)) {
                        await this._api.groupSwitchingAlarmTestSignalOptical(id, state.val as string);
                    }
                    break;
                case 'setSignalOptical':
                    for (const id of this._targetGroups(o.native, o.native.parameter)) {
                        await this._api.groupSwitchingAlarmSetSignalOptical(id, state.val as string);
                    }
                    break;
                case 'testSignalAcoustic':
                    for (const id of this._targetGroups(o.native, o.native.parameter)) {
                        await this._api.groupSwitchingAlarmTestSignalAcoustic(id, state.val as string);
                    }
                    break;
                case 'setSignalAcoustic':
                    for (const id of this._targetGroups(o.native, o.native.parameter)) {
                        await this._api.groupSwitchingAlarmSetSignalAcoustic(id, state.val as string);
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
                    await this._api.groupHeatingSetProfileMode(deviceId, state.val as string);
                    break;
                case 'groupLinkedOnTime':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.groupSwitchingLinkedSetOnTime(deviceId, state.val as number);
                    break;
                case 'setPowerMeterUnitPrice':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    await this._api.homeSetPowerMeterUnitPrice(state.val as number);
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
                    if ((await this._api.ruleEnableSimpleRule(deviceId, state.val as boolean)) === undefined) {
                        this.log.error(`Could not enable rule ${String(o.native.id)}, it is unchanged.`);
                        return;
                    }
                    await this._ackRuleValue(deviceId, 'active', state.val);
                    break;
                case 'setRuleLabel':
                    if (state.val === this.currentValues[id]) {
                        this.log.info(`Value unchanged, do not send this value`);
                        await this.secureSetStateAsync(id, this.currentValues[id], true);
                        return;
                    }
                    if ((await this._api.ruleSetRuleLabel(deviceId, state.val as string)) === undefined) {
                        this.log.error(`Could not relabel rule ${String(o.native.id)}, it is unchanged.`);
                        return;
                    }
                    await this._ackRuleValue(deviceId, 'label', state.val);
                    break;
                default:
                    // an object whose native names a parameter nothing handles: the write is lost,
                    // and silence here reads as a broken datapoint rather than a stale object
                    this.log.warn(
                        `${o.native.parameter} - id ${o.native.id ? JSON.stringify(deviceId) : ''} - no command is dispatched on this parameter, the value was not sent`,
                    );
                    break;
            }
        } catch (err) {
            this.log.warn(
                `${o.native.parameter} - id ${o.native.id ? String(o.native.id) : ''} - state change error: ${String(err)}`,
            );
        }
    }

    async _stateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!id || !state || state.ack || this._unloaded) {
            return;
        }

        const o = await this.getObjectAsync(id);
        if (o && o.native && o.native.parameter) {
            if (o.native.step) {
                state.val = this.round(state.val as number, o.native.step);
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
                this.clearTimeout(this.delayTimeouts[id].timeout);
                delete this.delayTimeouts[id].timeout;
            }
            if (o.native.debounce) {
                // debounce, delay sending command
                this.delayTimeouts[id].lastVal = state.val;
                this.delayTimeouts[id].timeout = this.setTimeout(
                    (id, o, state) => {
                        this.delayTimeouts[id].timeout = null;
                        this.log.debug(
                            `${o.native.parameter} - id ${o.native.id ? JSON.stringify(o.native.id) : ''} - Send debounced value ${state.val} now to HMIP`,
                        );
                        void this._doStateChange(id, o, state);
                    },
                    o.native.debounce,
                    id,
                    o,
                    state,
                );
            } else {
                this.delayTimeouts[id].timeout = this.setTimeout(() => {
                    this.delayTimeouts[id].timeout = null;
                }, o.native.throttle || 1000);
                await this._doStateChange(id, o as unknown as DispatchObject, state);
            }
        }
    }

    _dataReceived(data: string): void {
        this.log.silly(`data received - ${data}`);
    }

    _opened(): void {
        this.log.info('ws connection opened');
        this.wsConnected = true;
        this.wsConnectionStableTimeout && this.clearTimeout(this.wsConnectionStableTimeout);
        this.wsConnectionStableTimeout = this.setTimeout(() => {
            this.wsConnectionStableTimeout = null;
            this.wsConnectionErrorCounter = 0;
        }, 5000); // set null when connection is stable
    }

    _closed(code: number, reason: string, forced = false): void {
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
        this.expectWsError && this.clearTimeout(this.expectWsError);
        if (!forced && !this.reInitTimeout) {
            // When no error happens within 5 seconds, we refresh our self
            this.expectWsError = this.setTimeout(() => this._closed(code, reason, true), 5000);
        }
        if ((forced || this.wsConnectionErrorCounter > 6) && !this._unloaded) {
            this._api.dispose();
            this.log.error(`close on websocket connection: ${code} - ${reason}`);
            this.log.error('Try reconnect in 30s');
            this.reInitTimeout && this.clearTimeout(this.reInitTimeout);
            this.reInitTimeout = this.setTimeout(async () => {
                this.reInitTimeout = null;
                await this._ready();
            }, 30000);
        }
    }

    _staleConnection(silentFor: number): void {
        this.log.warn(`ws connection stopped answering ${Math.round(silentFor / 1000)}s ago, reconnecting`);
    }

    _errored(error: Error): void {
        this.log.warn(`ws connection error (${this.wsConnectionErrorCounter}): ${String(error)}`);
        const reason = error ? String(error) : '';
        if (!this.wsConnected) {
            this.wsConnectionErrorCounter++;
        }
        if (reason.includes('ECONNREFUSED') && !this._unloaded) {
            this._api.dispose();
            this.log.error(`error on websocket connection: ${reason}`);
            this.log.error('Try reconnect in 30s');
            this.reInitTimeout && this.clearTimeout(this.reInitTimeout);
            this.reInitTimeout = this.setTimeout(() => {
                this.reInitTimeout = null;
                void this._ready();
            }, 30000);
        }
    }

    _requestError(error: unknown): void {
        const failure = error as RequestFailure;
        if (failure.response) {
            // The request was made and the server responded with a status code
            // that falls out of the range of 2xx
            this.log.warn(
                `Request error data: ${String(failure.response.data)}, (${JSON.stringify(failure.response.data)})`,
            );
            this.log.warn(`Request error status: ${failure.response.status}`);
        } else if (failure.request) {
            // The request was made but no response was received
            // `failure.request` is an instance of XMLHttpRequest in the browser and an instance of
            // http.ClientRequest in node.js
            // a ClientRequest has no useful string form, but this line has always said only that
            // a request was made and nothing came back
            this.log.warn(`Request error: ${JSON.stringify(failure.request)}`);
        } else {
            // Something happened in setting up the request that triggered an Error
            this.log.warn(`Request error: ${failure.message} (${String(error)}, ${JSON.stringify(error)})`);
        }
    }

    _unexpectedResponse(req: ClientRequest, res: IncomingMessage): void {
        this.log.warn(`ws connection unexpected response: ${res.statusCode}`);
    }

    async _eventRaised(ev: CloudEvent): Promise<void> {
        if (this._unloaded) {
            return;
        }
        switch (ev.pushEventType) {
            case 'DEVICE_ADDED':
                await this._createObjectsForDevice(ev.device as HmIpDevice);
                await this._updateDeviceStates(ev.device as HmIpDevice);
                break;
            case 'DEVICE_CHANGED':
                await this._updateDeviceStates(ev.device as HmIpDevice);
                break;
            case 'GROUP_ADDED':
                await this._createObjectsForGroup(ev.group as HmIpGroup);
                await this._updateGroupStates(ev.group as HmIpGroup);
                break;
            case 'GROUP_CHANGED':
                await this._updateGroupStates(ev.group as HmIpGroup);
                break;
            case 'CLIENT_ADDED':
                await this._createObjectsForClient(ev.client as HmIpClient);
                await this._updateClientStates(ev.client as HmIpClient);
                break;
            case 'CLIENT_CHANGED':
                await this._updateClientStates(ev.client as HmIpClient);
                break;
            case 'DEVICE_REMOVED':
                break;
            case 'GROUP_REMOVED':
                // the api has already dropped the group, so the armed zones are whatever is left
                if (this._api.home) {
                    await Promise.all(this._updateSecurityZonesArmed(this._api.home.id));
                }
                break;
            case 'CLIENT_REMOVED':
                break;
            case 'HOME_CHANGED':
                if (ev && ev.home) {
                    this._homePublishSeq++;
                    await this._updateHomeStates(ev.home);
                } else {
                    this.log.warn(`No home in HOME_CHANGED: ${JSON.stringify(ev)}`);
                }
                break;
            case 'SECURITY_JOURNAL_CHANGED':
                if (ev && ev.home) {
                    this._homePublishSeq++;
                    await this._updateHomeStates(ev.home);
                } else {
                    // the read waits out its interval, which must not hold up the journal
                    this._readHomeForAlarmFields().catch(err =>
                        this.log.warn(`Could not read the home for its alarm fields: ${String(err)}`),
                    );
                }
                await this._updateSecurityJournal();
                break;
            case 'DEVICE_CHANNEL_EVENT':
                await this._channelEventRaised(ev);
                break;
            case 'DEVICE_CODE_STATE_EVENT':
                await this._codeStateEventRaised(ev);
                break;
            default:
                this.log.warn(`unhandled event - ${JSON.stringify(ev)}`);
        }
    }

    /**
     * An indicator for something the cloud reports as a moment rather than as a state.
     *
     * @param id the state to create
     * @param name the event the state stands for
     * @returns when the object exists
     */
    _createEventState(id: string, name: string): Promise<unknown> {
        return this.extendObject(id, {
            type: 'state',
            common: { name, type: 'boolean', role: 'indicator', read: true, write: false },
            native: {},
        });
    }

    /**
     * Marks an event as raised.
     *
     * The datapoint is never reset: ioBroker notifies subscribers of every write whether or not
     * the value changed, so every press stays an update and `lc` carries when it last happened.
     *
     * @param id the state to raise
     * @param name the event the state stands for
     * @returns when the event has been published
     */
    async _raiseEventState(id: string, name: string): Promise<void> {
        await this._createEventState(id, name);
        await this.secureSetStateAsync(id, true, true);
    }

    /**
     * A name the cloud sent that is safe to build a state id from.
     *
     * @param name the name as it arrived
     * @returns whether it is one of the cloud's own upper-case identifiers
     */
    _isEventName(name: unknown): boolean {
        return typeof name === 'string' && /^[A-Z][A-Z0-9_]*$/.test(name);
    }

    /**
     * @param ev the DEVICE_CHANNEL_EVENT as the cloud sent it
     * @returns when the event has been published
     */
    async _channelEventRaised(ev: ChannelEvent): Promise<void> {
        // the cloud names the channel either way round
        const channel = ev.channelIndex ?? ev.functionalChannelIndex;
        if (!ev.deviceId || channel === undefined || channel === null || !this._isEventName(ev.channelEventType)) {
            this.log.warn(`Unusable channel event - ${JSON.stringify(ev)}`);
            return;
        }
        this.log.debug(`channel event ${ev.channelEventType} on ${ev.deviceId}:${channel}`);
        await this._raiseEventState(
            `devices.${ev.deviceId}.channels.${channel}.events.${ev.channelEventType}`,
            ev.channelEventType as string,
        );
    }

    /**
     * @param ev the DEVICE_CODE_STATE_EVENT as the cloud sent it
     * @returns when the event has been published
     */
    async _codeStateEventRaised(ev: CodeStateEvent): Promise<void> {
        if (!ev.deviceId || !this._isEventName(ev.codeState)) {
            this.log.warn(`Unusable code state event - ${JSON.stringify(ev)}`);
            return;
        }
        const base = `devices.${ev.deviceId}.events`;
        this.log.debug(`code state ${ev.codeState} on ${ev.deviceId}`);
        // the index is written first, so a script woken by the event below already reads this one
        if (typeof ev.codeIndex === 'number') {
            await this.extendObject(`${base}.codeIndex`, {
                type: 'state',
                common: { name: 'codeIndex', type: 'number', role: 'value', read: true, write: false },
                native: {},
            });
            await this.secureSetStateAsync(`${base}.codeIndex`, ev.codeIndex, true);
        }
        await this._raiseEventState(`${base}.${ev.codeState}`, ev.codeState as string);
    }

    /**
     * The on and ramp time a channel is configured to control with.
     *
     * Both default to 0, which selects the plain command; anything above 0 selects the cloud's
     * ...WithTime variant, so a channel only ramps once someone asks it to.
     *
     * @param native the object's native block, carrying the device id and channel
     * @returns the configured times
     */
    async _controlTimes(native: ChannelStateNative): Promise<{ onTime: number; rampTime: number; timed: boolean }> {
        const base = `devices.${String(native.id)}.channels.${native.channel}`;
        const onTimeState = await this.getStateAsync(`${base}.controlOnTime`);
        const rampTimeState = await this.getStateAsync(`${base}.controlRampTime`);
        const onTime = (onTimeState?.val as number) || 0;
        const rampTime = (rampTimeState?.val as number) || 0;
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
     * @param native the object's native block
     * @param parameter the command being dispatched, for the log line
     * @returns the group ids, empty when the channel belongs to none
     */
    _targetGroups(native: ChannelStateNative, parameter: string): string[] {
        const groups = Array.isArray(native.id) ? native.id : [];
        if (!groups.length) {
            this.log.warn(`${parameter} has no group to act on - assign the channel to a group first`);
        }
        return groups;
    }

    _levelFraction(value: ioBroker.StateValue): number | null | undefined {
        return typeof value === 'number' && value > 1 ? value / 100 : (value as number | null | undefined);
    }

    /**
     * Reads a state of the given channel together with the id it is cached under.
     *
     * @param native the object's native block, carrying the device id and channel
     * @param field the state below the channel
     * @returns the cache id and the value
     */
    async _channelState(native: ChannelStateNative, field: string): Promise<{ id: string; val: ioBroker.StateValue }> {
        const path = `devices.${String(native.id)}.channels.${native.channel}.${field}`;
        const state = await this.getStateAsync(path);
        return { id: `${this.namespace}.${path}`, val: state ? state.val : null };
    }

    async _setZonesSilentAlarm(internal: boolean, external: boolean): Promise<void> {
        if ((await this._api.homeSetZonesSilentAlarm(internal, external)) === undefined) {
            this.log.error(
                `Could not set the silent alarm to internal=${internal}, external=${external}, it is unchanged.`,
            );
        }
    }

    async _setSecurityZonesActivation(internal: boolean, external: boolean): Promise<void> {
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
        if (!outcome.confirmed) {
            this.log.info(
                `The alarm system accepted ${requested} but reported no detail, so it is not confirmed. Check securityAndAlarm.securityZonesArmedMode.`,
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

    async secureSetStateAsync(id: string, value: unknown, ack: boolean): Promise<void> {
        if (value && typeof value === 'object') {
            value = (value as ioBroker.State).val;
        }
        if (value === undefined) {
            value = null;
        }
        await this.setStateAsync(id, value as ioBroker.StateValue, ack);
        if (ack) {
            const prefix = `${this.namespace}.`;
            this.currentValues[id.startsWith(prefix) ? id : `${prefix}${id}`] = value as ioBroker.StateValue;
        }
    }

    async _updateDeviceStates(device: HmIpDevice): Promise<void> {
        this.log.silly(`updateDeviceStates - ${device.type} - ${JSON.stringify(device)}`);
        let unknownChannelDetected = false;
        if (this.initializedChannels[`devices.${device.id}`]) {
            const promises = [];
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

            for (const i in device.functionalChannels) {
                if (!Object.prototype.hasOwnProperty.call(device.functionalChannels, i)) {
                    continue;
                }
                const fc = device.functionalChannels[i];
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

                if (CHANNEL_STATES[fc.functionalChannelType as string]) {
                    promises.push(...this._updateChannelStates(device, i, fc.functionalChannelType as string));
                } else if (STATELESS_CHANNELS.includes(fc.functionalChannelType as string)) {
                    this.log.silly(`Ignore channel type ${fc.functionalChannelType} - ${device.id}`);
                } else if (Object.keys(fc).length > 6) {
                    // fewer fields than that is a stub channel with nothing to report
                    this.log.info(`unknown channel type - ${fc.functionalChannelType} - ${JSON.stringify(device)}`);
                    this._reportUnknownChannel(device, fc.functionalChannelType as string);
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

    _reinitializeData(id: string): void {
        if (this.reInitDataTimeout) {
            return;
        }
        this.log.info(`New data structures detected ... reinitialize in 5s... ${id}`);
        // a read still in flight answers for the configuration this replaces
        this._dataEpoch++;
        this._api.dispose();
        this.reInitDataTimeout = this.setTimeout(async () => {
            this.reInitDataTimeout = null;
            try {
                await this._initData();
            } catch (err) {
                this.log.error(`error updating Homematic ip for unknown states: ${String(err)}`);
                this.log.error('Try reconnect in 30s');
                this.reInitTimeout && this.clearTimeout(this.reInitTimeout);
                this.reInitTimeout = this.setTimeout(() => {
                    this.reInitTimeout = null;
                    void this._ready();
                }, 30000);
            }
        }, 5000);
    }

    _reportUnknownChannel(device: HmIpDevice, channelType: string): void {
        if (this.sendUnknownInfos[channelType]) {
            return;
        }
        this.sendUnknownInfos[channelType] = true;
        const sentry = this.Sentry;
        sentry?.withScope(scope => {
            scope.setLevel('info');
            scope.setExtra('channelData', JSON.stringify(device));
            sentry.captureMessage(`Unknown Channel type ${channelType}`, 'info');
        });
    }

    _createChannel(device: HmIpDevice, channel: string, channelType: string): Promise<unknown>[] {
        const entry = CHANNEL_STATES[channelType];
        const promises = entry.extends ? this._createChannel(device, channel, entry.extends) : [];
        const functionalChannel = device.functionalChannels?.[channel];
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

    _updateChannelStates(device: HmIpDevice, channel: string, channelType: string): Promise<unknown>[] {
        const entry = CHANNEL_STATES[channelType];
        const promises = entry.extends ? this._updateChannelStates(device, channel, entry.extends) : [];
        for (const { field, value } of channelStateValues(entry.states, device.functionalChannels?.[channel])) {
            promises.push(this.secureSetStateAsync(`devices.${device.id}.channels.${channel}.${field}`, value, true));
        }
        return promises;
    }

    /**
     * The name a profile carries in the app: what the user called it, or the manufacturer's default
     * for the profiles nobody ever renamed, which the cloud answers for with an empty name.
     *
     * @param group the group the profile belongs to
     * @param profileIndex PROFILE_1 .. PROFILE_6
     * @returns the name to publish
     */
    _profileName(group: HmIpGroup, profileIndex: string): string {
        const profiles = group.profiles as Record<string, { name?: string } | null> | undefined;
        const profile = profiles?.[profileIndex];
        const defaults: Record<string, string> =
            DEFAULT_PROFILE_NAMES[this.profileNameLanguage] || DEFAULT_PROFILE_NAMES.en;
        return profile?.name || defaults[profileIndex] || profileIndex;
    }

    _updateGroupStates(group: HmIpGroup): Promise<unknown[]> | undefined {
        this.log.silly(`_updateGroupStates - ${JSON.stringify(group)}`);

        if (this.initializedChannels[`groups.${group.id}`]) {
            const promises = [];
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
                    // a payload that carries no profiles cannot name them, so the last known names stay
                    if (group.profiles && typeof group.profiles === 'object') {
                        for (const profileIndex of PROFILE_INDEXES) {
                            promises.push(
                                this.secureSetStateAsync(
                                    `groups.${group.id}.profiles.${profileIndex}`,
                                    this._profileName(group, profileIndex),
                                    true,
                                ),
                            );
                        }
                        promises.push(
                            this.secureSetStateAsync(
                                `groups.${group.id}.activeProfileName`,
                                group.activeProfile ? this._profileName(group, group.activeProfile as string) : null,
                                true,
                            ),
                        );
                    }
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
                    if (this._api.home) {
                        promises.push(...this._updateSecurityZonesArmed(this._api.home.id));
                    }
                    promises.push(this.secureSetStateAsync(`groups.${group.id}.silent`, group.silent, true));
                    promises.push(this.secureSetStateAsync(`groups.${group.id}.windowState`, group.windowState, true));
                    promises.push(
                        this.secureSetStateAsync(`groups.${group.id}.motionDetected`, group.motionDetected, true),
                    );
                    promises.push(
                        this.secureSetStateAsync(`groups.${group.id}.presenceDetected`, group.presenceDetected, true),
                    );
                    promises.push(this.secureSetStateAsync(`groups.${group.id}.sabotage`, group.sabotage, true));
                    break;
                }
                case 'HOT_WATER': {
                    promises.push(this.secureSetStateAsync(`groups.${group.id}.profileMode`, group.profileMode, true));
                    promises.push(this.secureSetStateAsync(`groups.${group.id}.profileId`, group.profileId, true));
                    promises.push(this.secureSetStateAsync(`groups.${group.id}.on`, group.on, true));
                    promises.push(this.secureSetStateAsync(`groups.${group.id}.onTime`, group.onTime, true));
                    break;
                }
                case 'SHUTTER_PROFILE': {
                    promises.push(this.secureSetStateAsync(`groups.${group.id}.profileMode`, group.profileMode, true));
                    promises.push(this.secureSetStateAsync(`groups.${group.id}.profileId`, group.profileId, true));
                    promises.push(
                        this.secureSetStateAsync(`groups.${group.id}.shutterLevel`, group.shutterLevel, true),
                    );
                    promises.push(this.secureSetStateAsync(`groups.${group.id}.slatsLevel`, group.slatsLevel, true));
                    promises.push(
                        this.secureSetStateAsync(
                            `groups.${group.id}.primaryShadingLevel`,
                            group.primaryShadingLevel,
                            true,
                        ),
                    );
                    promises.push(
                        this.secureSetStateAsync(
                            `groups.${group.id}.primaryShadingStateType`,
                            group.primaryShadingStateType,
                            true,
                        ),
                    );
                    promises.push(
                        this.secureSetStateAsync(
                            `groups.${group.id}.secondaryShadingLevel`,
                            group.secondaryShadingLevel,
                            true,
                        ),
                    );
                    promises.push(
                        this.secureSetStateAsync(
                            `groups.${group.id}.secondaryShadingStateType`,
                            group.secondaryShadingStateType,
                            true,
                        ),
                    );
                    promises.push(this.secureSetStateAsync(`groups.${group.id}.processing`, group.processing, true));
                    break;
                }
                case 'EXTENDED_LINKED_NOTIFICATION':
                    promises.push(
                        this.secureSetStateAsync(
                            `groups.${group.id}.opticalSignalBehaviour`,
                            group.opticalSignalBehaviour,
                            true,
                        ),
                    );
                    promises.push(
                        this.secureSetStateAsync(
                            `groups.${group.id}.onOpticalSignalBehaviour`,
                            group.onOpticalSignalBehaviour,
                            true,
                        ),
                    );
                    promises.push(
                        this.secureSetStateAsync(
                            `groups.${group.id}.simpleRGBColorState`,
                            group.simpleRGBColorState,
                            true,
                        ),
                    );
                    promises.push(
                        this.secureSetStateAsync(`groups.${group.id}.onSimpleRGBColor`, group.onSimpleRGBColor, true),
                    );
                // eslint-disable-next-line no-fallthrough
                case 'EXTENDED_LINKED_SWITCHING': {
                    promises.push(this.secureSetStateAsync(`groups.${group.id}.on`, group.on, true));
                    promises.push(this.secureSetStateAsync(`groups.${group.id}.dimLevel`, group.dimLevel, true));
                    promises.push(this.secureSetStateAsync(`groups.${group.id}.onLevel`, group.onLevel, true));
                    promises.push(this.secureSetStateAsync(`groups.${group.id}.onTime`, group.onTime, true));
                    promises.push(this.secureSetStateAsync(`groups.${group.id}.dutyCycle`, group.dutyCycle, true));
                    promises.push(this.secureSetStateAsync(`groups.${group.id}.lowBat`, group.lowBat, true));
                    break;
                }
            }

            return Promise.all(promises);
        }
        this._reinitializeData(`Group ${group.id}`);
    }

    _updateClientStates(client: HmIpClient): Promise<unknown[]> | undefined {
        this.log.silly(`_updateClientStates - ${JSON.stringify(client)}`);
        if (this.initializedChannels[`clients.${client.id}`]) {
            const promises = [];
            promises.push(this.secureSetStateAsync(`clients.${client.id}.info.label`, client.label, true));
            return Promise.all(promises);
        }
        this._reinitializeData(`Client ${client.id}`);
    }

    /**
     * Publishes which security zones are armed on the home, where a user looks for it.
     *
     * The zone groups carry the armed flag, but their labels differ between panel generations
     * and their ids are opaque, so the home is the only place a script can read it reliably.
     *
     * @param homeId the home the security zones belong to
     * @returns one promise per published state
     */
    _updateSecurityZonesArmed(homeId: string): Promise<unknown>[] {
        const armed = this._api.securityZonesArmedState();
        const base = `homes.${homeId}.functionalHomes.securityAndAlarm`;
        return [
            this.secureSetStateAsync(`${base}.securityZonesArmedMode`, armed.mode, true),
            this.secureSetStateAsync(`${base}.internalZoneArmed`, armed.internal, true),
            this.secureSetStateAsync(`${base}.externalZoneArmed`, armed.external, true),
        ];
    }

    _updateHomeStates(home: HmIpHome): Promise<unknown[]> {
        this.log.silly(`_updateHomeStates - ${JSON.stringify(home)}`);
        const promises = [];

        promises.push(this.secureSetStateAsync(`homes.${home.id}.powerMeterCurrency`, home.powerMeterCurrency, true));
        promises.push(this.secureSetStateAsync(`homes.${home.id}.powerMeterUnitPrice`, home.powerMeterUnitPrice, true));

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

        const functionalHomes = home.functionalHomes || {};
        // the cloud names the device that raised the alarm only inside alarmEventDeviceChannel,
        // and there is no alarmEventDeviceId beside it
        const alarmEventChannel = ((functionalHomes.SECURITY_AND_ALARM || {}).alarmEventDeviceChannel || {}) as {
            deviceId?: string;
            channelIndex?: number;
        };
        const alarmEventDevice = alarmEventChannel.deviceId ? this._api.devices[alarmEventChannel.deviceId] : undefined;
        if (functionalHomes.SECURITY_AND_ALARM) {
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.securityAndAlarm.alarmEventTimestamp`,
                    functionalHomes.SECURITY_AND_ALARM.alarmEventTimestamp,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.securityAndAlarm.alarmEventDeviceId`,
                    alarmEventChannel.deviceId,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.securityAndAlarm.alarmEventDeviceLabel`,
                    alarmEventDevice ? alarmEventDevice.label : null,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.securityAndAlarm.alarmEventTriggerId`,
                    functionalHomes.SECURITY_AND_ALARM.alarmEventTriggerId,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.securityAndAlarm.alarmEventDeviceChannel`,
                    alarmEventChannel.channelIndex,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.securityAndAlarm.alarmSecurityJournalEntryType`,
                    functionalHomes.SECURITY_AND_ALARM.alarmSecurityJournalEntryType,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.securityAndAlarm.alarmActive`,
                    functionalHomes.SECURITY_AND_ALARM.alarmActive,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.securityAndAlarm.zoneActivationDelay`,
                    functionalHomes.SECURITY_AND_ALARM.zoneActivationDelay,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.securityAndAlarm.intrusionAlertThroughSmokeDetectors`,
                    functionalHomes.SECURITY_AND_ALARM.intrusionAlertThroughSmokeDetectors,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.securityAndAlarm.securityZoneActivationMode`,
                    functionalHomes.SECURITY_AND_ALARM.securityZoneActivationMode,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.securityAndAlarm.solution`,
                    functionalHomes.SECURITY_AND_ALARM.solution,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.securityAndAlarm.activationInProgress`,
                    functionalHomes.SECURITY_AND_ALARM.activationInProgress,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.securityAndAlarm.active`,
                    functionalHomes.SECURITY_AND_ALARM.active,
                    true,
                ),
            );
            promises.push(...this._updateSecurityZonesArmed(home.id));
        }
        if (functionalHomes.INDOOR_CLIMATE) {
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.indoorClimate.absenceType`,
                    functionalHomes.INDOOR_CLIMATE.absenceType,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.indoorClimate.absenceEndTime`,
                    functionalHomes.INDOOR_CLIMATE.absenceEndTime,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.indoorClimate.ecoTemperature`,
                    functionalHomes.INDOOR_CLIMATE.ecoTemperature,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.indoorClimate.coolingEnabled`,
                    functionalHomes.INDOOR_CLIMATE.coolingEnabled,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.indoorClimate.ecoDuration`,
                    functionalHomes.INDOOR_CLIMATE.ecoDuration,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.indoorClimate.optimumStartStopEnabled`,
                    functionalHomes.INDOOR_CLIMATE.optimumStartStopEnabled,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.indoorClimate.solution`,
                    functionalHomes.INDOOR_CLIMATE.solution,
                    true,
                ),
            );
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.indoorClimate.active`,
                    functionalHomes.INDOOR_CLIMATE.active,
                    true,
                ),
            );
        }
        if (functionalHomes.LIGHT_AND_SHADOW) {
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.lightAndShadow.active`,
                    functionalHomes.LIGHT_AND_SHADOW.active,
                    true,
                ),
            );
        }
        if (functionalHomes.WEATHER_AND_ENVIRONMENT) {
            promises.push(
                this.secureSetStateAsync(
                    `homes.${home.id}.functionalHomes.weatherAndEnvironment.active`,
                    functionalHomes.WEATHER_AND_ENVIRONMENT.active,
                    true,
                ),
            );
        }

        return Promise.all(promises);
    }

    async _createObjectsForDevices(): Promise<void> {
        this.log.silly(`Devices: ${JSON.stringify(this._api.devices)}`);
        for (const i in this._api.devices) {
            if (!Object.prototype.hasOwnProperty.call(this._api.devices, i)) {
                continue;
            }
            await this._createObjectsForDevice(this._api.devices[i]);
        }
    }

    async _createObjectsForGroups(): Promise<void> {
        this.log.silly(`Groups: ${JSON.stringify(this._api.groups)}`);
        for (const i in this._api.groups) {
            if (!Object.prototype.hasOwnProperty.call(this._api.groups, i)) {
                continue;
            }
            await this._createObjectsForGroup(this._api.groups[i]);
        }
    }

    async _createObjectsForClients(): Promise<void> {
        this.log.silly(`Clients: ${JSON.stringify(this._api.clients)}`);
        for (const i in this._api.clients) {
            if (!Object.prototype.hasOwnProperty.call(this._api.clients, i)) {
                continue;
            }
            await this._createObjectsForClient(this._api.clients[i]);
        }
    }

    async _createObjectsForHomes(): Promise<void> {
        this.log.silly(`Home: ${JSON.stringify(this._api.home)}`);
        await this._createObjectsForHome(this._api.home as HmIpHome);
    }

    _createObjectsForDevice(device: HmIpDevice): Promise<unknown[]> {
        this.log.silly(`createObjectsForDevice - ${device.type} - ${JSON.stringify(device)}`);
        const promises = [];
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
        for (const i in device.functionalChannels) {
            if (!Object.prototype.hasOwnProperty.call(device.functionalChannels, i)) {
                continue;
            }
            const fc = device.functionalChannels[i];
            promises.push(
                this.extendObject(`devices.${device.id}.channels.${i}`, {
                    type: 'channel',
                    common: { name: (fc.label as string) || `Channel ${i}` },
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
            if (EVENT_CHANNELS.includes(fc.functionalChannelType as string)) {
                promises.push(
                    ...CHANNEL_EVENTS.map(event =>
                        this._createEventState(`devices.${device.id}.channels.${i}.events.${event}`, event),
                    ),
                );
            }
            if (CODE_STATE_CHANNELS.includes(fc.functionalChannelType as string)) {
                promises.push(
                    ...CODE_STATES.map(codeState =>
                        this._createEventState(`devices.${device.id}.events.${codeState}`, codeState),
                    ),
                );
            }
            if (CHANNEL_STATES[fc.functionalChannelType as string]) {
                promises.push(...this._createChannel(device, i, fc.functionalChannelType as string));
            } else if (STATELESS_CHANNELS.includes(fc.functionalChannelType as string)) {
                this.log.silly(`Ignore channel type ${fc.functionalChannelType} - ${device.id}`);
            } else {
                this.log.info(`Unknown channel type - ${fc.functionalChannelType} - ${JSON.stringify(device)}`);
            }
        }
        return Promise.all(promises);
    }

    /* Start Channel Types */

    /* End Channel Types */

    _createObjectsForGroup(group: HmIpGroup): Promise<unknown[]> {
        this.log.silly(`createObjectsForGroup - ${JSON.stringify(group)}`);
        const promises = [];
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
                    this.extendObject(`groups.${group.id}.profiles`, {
                        type: 'channel',
                        common: { name: 'profiles' },
                        native: {},
                    }),
                );
                for (const profileIndex of PROFILE_INDEXES) {
                    promises.push(
                        this.extendObject(`groups.${group.id}.profiles.${profileIndex}`, {
                            type: 'state',
                            common: { name: profileIndex, type: 'string', role: 'text', read: true, write: false },
                            native: {},
                        }),
                    );
                }
                promises.push(
                    this.extendObject(`groups.${group.id}.activeProfileName`, {
                        type: 'state',
                        common: {
                            name: 'activeProfileName',
                            type: 'string',
                            role: 'text',
                            read: true,
                            write: false,
                        },
                        native: {},
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
                            // true leaves the group out of cooling, the way the app reads it
                            name: 'coolingIgnored',
                            type: 'boolean',
                            role: 'switch',
                            read: true,
                            write: true,
                        },
                        native: { id: [group.id], parameter: 'coolingIgnored' },
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

    async _createObjectsForRules(): Promise<void> {
        this.log.silly(`Rules: ${JSON.stringify(this._api.rules)}`);
        for (const i in this._api.rules) {
            if (!Object.prototype.hasOwnProperty.call(this._api.rules, i)) {
                continue;
            }
            await this._createObjectsForRule(this._api.rules[i]);
        }
    }

    _createObjectsForRule(rule: HmIpRule): Promise<unknown[]> {
        this.log.silly(`createObjectsForRule - ${JSON.stringify(rule)}`);
        const promises = [];
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

    _updateRuleStates(rule: HmIpRule): Promise<unknown[]> | undefined {
        this.log.silly(`_updateRuleStates - ${JSON.stringify(rule)}`);
        if (this.initializedChannels[`rules.${rule.id}`]) {
            const promises = [];
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
     * @param ruleId the rule that was written to
     * @param field the rule field that was written
     * @param value the value the cloud accepted
     */
    async _ackRuleValue(ruleId: string, field: string, value: ioBroker.StateValue): Promise<void> {
        const rule = this._api.rules && this._api.rules[ruleId];
        if (rule) {
            rule[field] = value;
        }
        const path = field === 'label' ? `rules.${ruleId}.info.label` : `rules.${ruleId}.${field}`;
        await this.secureSetStateAsync(path, value, true);
    }

    /**
     * Reads the home so its alarm fields can be published, at most once per `_homeReadInterval`.
     *
     * Only a full read carries those fields, and the event announcing them arrives every few
     * minutes on some homes, so the interval is waited out inside the lock: events arriving
     * meanwhile are absorbed and answered by one read afterwards. `_updateSecurityJournal` holds
     * its reads apart the same way.
     *
     */
    async _readHomeForAlarmFields(): Promise<void> {
        if (this._homeReadRunning) {
            this._homeReadPending = true;
            return;
        }
        this._homeReadRunning = true;
        try {
            do {
                // wall clock steps, and this measures an elapsed interval. A reload reads the
                // configuration itself and moves the deadline, so it is sampled again after waking
                let wait = this._nextHomeRead - performance.now();
                while (wait > 0) {
                    await this._sleep(wait);
                    if (this._unloaded) {
                        return;
                    }
                    wait = this._nextHomeRead - performance.now();
                }
                // the request about to go out answers for every event that waited for it, so only
                // the ones arriving while it is in flight are worth another read
                this._homeReadPending = false;
                await this._publishHomeFromCloud();
            } while (this._homeReadPending && !this._unloaded);
        } finally {
            this._homeReadRunning = false;
        }
    }

    /**
     * Reads the configuration and publishes the home out of it.
     *
     */
    async _publishHomeFromCloud(): Promise<void> {
        const epoch = this._dataEpoch;
        const publishSeq = this._homePublishSeq;
        this.log.debug('Read Home for its alarm fields');
        const state = (await this._api.callRestApi('home/getCurrentState', this._api._clientCharacteristics)) as
            HmIpCurrentState | undefined;
        if (this._unloaded || this._dataEpoch !== epoch) {
            return;
        }
        if (!state || !state.home) {
            // the api logs why; retrying beats leaving the alarm fields unpublished for the interval
            this._nextHomeRead = performance.now() + this._homeReadRetryInterval;
            return;
        }
        if (this._homePublishSeq !== publishSeq) {
            // the cloud composed this answer before that push, so it is the older of the two. The
            // push need not have carried the alarm fields, so this read is owed another attempt
            this.log.debug('Discard the home read a push overtook');
            this._nextHomeRead = performance.now() + this._homeReadRetryInterval;
            this._homeReadPending = true;
            return;
        }
        this._nextHomeRead = performance.now() + this._homeReadInterval;
        await this._updateHomeStates(state.home);
    }

    /**
     * @param ms how long to wait
     */
    _sleep(ms: number): Promise<void> {
        return new Promise(resolve => {
            const timer = setTimeout(resolve, ms);
            timer.unref && timer.unref();
        });
    }

    /**
     * Reads the security journal and publishes it.
     *
     * A burst of journal events must not turn into a burst of reads: a read already running
     * absorbs the ones that arrive while it is in flight and repeats once afterwards, so the
     * published journal and the entry split out of it always come from the same response.
     *
     */
    async _updateSecurityJournal(): Promise<void> {
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

    async _publishSecurityJournal(): Promise<void> {
        const base = `homes.${this._api.home?.id}.functionalHomes.securityAndAlarm`;
        const journal = (await this._api.homeGetSecurityJournal()) as { entries?: SecurityJournalEntry[] } | undefined;
        if (this._unloaded) {
            return;
        }
        if (!journal || !Array.isArray(journal.entries)) {
            this.log.debug('No security journal received');
            return;
        }
        // the cloud documents no order for the entries, so the newest is the latest timestamp
        const newest =
            journal.entries.reduce<SecurityJournalEntry | null>(
                (latest: SecurityJournalEntry | null, entry: SecurityJournalEntry) =>
                    latest && (latest.eventTimestamp ?? 0) >= (entry.eventTimestamp ?? 0) ? latest : entry,
                null,
            ) || {};
        await this.secureSetStateAsync(`${base}.securityJournal`, JSON.stringify(journal.entries), true);
        await this.secureSetStateAsync(`${base}.securityJournalEventTimestamp`, newest.eventTimestamp ?? null, true);
        await this.secureSetStateAsync(`${base}.securityJournalEventType`, newest.eventType ?? null, true);
        await this.secureSetStateAsync(`${base}.securityJournalLabel`, newest.label ?? null, true);
    }

    _createObjectsForClient(client: HmIpClient): Promise<unknown[]> {
        this.log.silly(`createObjectsForClient - ${JSON.stringify(client)}`);
        const promises = [];
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

    _createObjectsForHome(home: HmIpHome): Promise<unknown[]> {
        this.log.silly(`createObjectsForHome - ${JSON.stringify(home)}`);
        const promises = [];
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
            this.extendObject(`homes.${home.id}.functionalHomes.securityAndAlarm.alarmEventDeviceLabel`, {
                type: 'state',
                common: { name: 'alarmEventDeviceLabel', type: 'string', role: 'text', read: true, write: false },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.securityAndAlarm.alarmEventDeviceChannel`, {
                type: 'state',
                common: { name: 'alarmEventDeviceChannel', type: 'number', role: 'value', read: true, write: false },
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
                common: { name: 'setCooling', type: 'boolean', role: 'switch', read: true, write: true },
                native: { id: home.id, parameter: 'setCooling' },
            }),
        );
        // every mode works on either dashboard, so this map must not depend on the panel a home
        // has today: extendObject merges, and a narrowed map would leave the wider one's keys
        const armedModes = Object.fromEntries(Object.keys(SECURITY_ZONE_MODES).map(mode => [mode, mode]));
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.securityAndAlarm.securityZonesArmedMode`, {
                type: 'state',
                common: {
                    name: 'securityZonesArmedMode',
                    type: 'string',
                    role: 'text',
                    read: true,
                    write: false,
                    states: armedModes,
                },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.securityAndAlarm.internalZoneArmed`, {
                type: 'state',
                common: {
                    name: 'internalZoneArmed',
                    type: 'boolean',
                    role: 'indicator',
                    read: true,
                    write: false,
                },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.securityAndAlarm.externalZoneArmed`, {
                type: 'state',
                common: {
                    name: 'externalZoneArmed',
                    type: 'boolean',
                    role: 'indicator',
                    read: true,
                    write: false,
                },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.securityAndAlarm.activateSecurityZones`, {
                type: 'state',
                common: {
                    name: 'activateSecurityZones',
                    type: 'string',
                    role: 'text',
                    read: false,
                    write: true,
                    states: armedModes,
                },
                native: { parameter: 'activateSecurityZones' },
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
                native: { id: securityAndAlarm.functionalGroups, parameter: 'setOnTime' },
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
                    id: securityAndAlarm.securitySwitchingGroups,
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
                    id: securityAndAlarm.securitySwitchingGroups,
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
                    id: securityAndAlarm.securitySwitchingGroups,
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
                    id: securityAndAlarm.securitySwitchingGroups,
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
            this.extendObject(`homes.${home.id}.functionalHomes.securityAndAlarm.setZonesSilentAlarmNone`, {
                type: 'state',
                common: {
                    name: 'setZonesSilentAlarmNone',
                    type: 'boolean',
                    role: 'button',
                    read: false,
                    write: true,
                },
                native: { parameter: 'setZonesSilentAlarmNone' },
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.securityAndAlarm.setZonesSilentAlarmInternal`, {
                type: 'state',
                common: {
                    name: 'setZonesSilentAlarmInternal',
                    type: 'boolean',
                    role: 'button',
                    read: false,
                    write: true,
                },
                native: { parameter: 'setZonesSilentAlarmInternal' },
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.securityAndAlarm.setZonesSilentAlarmExternal`, {
                type: 'state',
                common: {
                    name: 'setZonesSilentAlarmExternal',
                    type: 'boolean',
                    role: 'button',
                    read: false,
                    write: true,
                },
                native: { parameter: 'setZonesSilentAlarmExternal' },
            }),
        );
        promises.push(
            this.extendObject(
                `homes.${home.id}.functionalHomes.securityAndAlarm.setZonesSilentAlarmInternalAndExternal`,
                {
                    type: 'state',
                    common: {
                        name: 'setZonesSilentAlarmInternalAndExternal',
                        type: 'boolean',
                        role: 'button',
                        read: false,
                        write: true,
                    },
                    native: { parameter: 'setZonesSilentAlarmInternalAndExternal' },
                },
            ),
        );

        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.securityAndAlarm.securityJournal`, {
                type: 'state',
                common: { name: 'securityJournal', type: 'string', role: 'json', read: true, write: false },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.securityAndAlarm.securityJournalEventTimestamp`, {
                type: 'state',
                common: {
                    name: 'securityJournalEventTimestamp',
                    type: 'number',
                    role: 'value.time',
                    read: true,
                    write: false,
                },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.securityAndAlarm.securityJournalEventType`, {
                type: 'state',
                common: { name: 'securityJournalEventType', type: 'string', role: 'text', read: true, write: false },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.securityAndAlarm.securityJournalLabel`, {
                type: 'state',
                common: { name: 'securityJournalLabel', type: 'string', role: 'text', read: true, write: false },
                native: {},
            }),
        );
        promises.push(
            this.extendObject(`homes.${home.id}.functionalHomes.securityAndAlarm.readSecurityJournal`, {
                type: 'state',
                common: { name: 'readSecurityJournal', type: 'boolean', role: 'button', read: false, write: true },
                native: { parameter: 'getSecurityJournal' },
            }),
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
                common: { name: 'coolingEnabled', type: 'boolean', role: 'switch', read: true, write: true },
                native: { id: home.id, parameter: 'coolingEnabled' },
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
                common: {
                    name: 'vacationTemperature',
                    type: 'number',
                    role: 'level',
                    unit: '°C',
                    read: true,
                    write: true,
                },
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

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<AdapterOptions> | undefined) => new HmIpCloudAccesspointAdapter(options);
} else {
    // otherwise start the instance directly
    (() => new HmIpCloudAccesspointAdapter())();
}
