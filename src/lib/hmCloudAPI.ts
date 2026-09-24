import axios from 'axios';
import { sha512 } from 'js-sha512';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type {
    HmCloudConfigData,
    HmIpClient,
    HmIpCurrentState,
    HmIpDevice,
    HmIpGroup,
    HmIpHome,
    HmIpRule,
    CloudEvent,
    SecurityZonesArmedState,
    ZonesActivationOutcome,
} from './types';

const WS_PING_INTERVAL = 5000;
// four unanswered pings. The cloud drops a connection silently often enough that this deadline is
// the only thing that notices; too short a one would recycle a connection that is merely slow.
const WS_STALE_TIMEOUT = 25000;

/** the clientCharacteristics every getCurrentState call identifies this client with */
interface ClientCharacteristics {
    clientCharacteristics: {
        apiVersion: string;
        applicationIdentifier: string;
        applicationVersion: string;
        deviceManufacturer: string;
        deviceType: string;
        language: string;
        osType: string;
        osVersion: string;
    };
    id: string;
}

export class HmCloudAPI {
    // credentials and endpoints, filled by parseConfigData before anything else runs
    private _accessPointSgtin = '';
    private _authToken = '';
    private _clientAuthToken = '';
    private _clientId = '';
    private _deviceId = '';
    private _pin: string | null | undefined;
    private _urlREST = '';
    private _urlWebSocket = '';
    // the adapter reads this for the full home read it drives itself
    public _clientCharacteristics: ClientCharacteristics | null = null;

    private _ws: WebSocket | null = null;
    private _pingInterval: NodeJS.Timeout | null = null;
    private _connectTimeout: NodeJS.Timeout | null = null;
    private _lastAlive = 0;
    public isClosed = false;

    // the cached configuration, replaced wholesale by every getCurrentState
    public home: HmIpHome | null = null;
    public groups: Record<string, HmIpGroup> = {};
    public clients: Record<string, HmIpClient> = {};
    public devices: Record<string, HmIpDevice> = {};
    public rules: Record<string, HmIpRule> = {};

    // what the adapter hangs its handlers on; every one of them is optional
    public eventRaised: ((event: unknown) => void) | null = null;
    public dataReceived: ((data: string) => void) | null = null;
    public opened: (() => void) | null = null;
    public closed: ((code: number, reason: string) => void) | null = null;
    public errored: ((error: Error) => void) | null = null;
    public requestError: ((error: unknown) => void) | null = null;
    public unexpectedResponse: ((request: ClientRequest, response: IncomingMessage) => void) | null = null;
    public staleConnection: ((silentFor: number) => void) | null = null;

    constructor(configDataOrApId?: string | HmCloudConfigData, pin?: string | null) {
        if (configDataOrApId !== undefined) {
            this.parseConfigData(configDataOrApId, pin);
        }

        this.eventRaised = null;
    }

    parseConfigData(configDataOrApId: string | HmCloudConfigData, pin?: string | null, deviceId?: string): void {
        if (typeof configDataOrApId === 'string') {
            this._accessPointSgtin = configDataOrApId.replace(/[^a-fA-F0-9 ]/g, '');
            this._clientAuthToken = sha512(`${this._accessPointSgtin}jiLpVitHvWnIGD1yo7MA`).toUpperCase();
            this._authToken = '';
            this._clientId = '';

            this._urlREST = '';
            this._urlWebSocket = '';
            this._deviceId = deviceId || randomUUID();
            this._pin = pin;
        } else {
            this._authToken = configDataOrApId.authToken;
            this._clientAuthToken = configDataOrApId.clientAuthToken;
            this._clientId = configDataOrApId.clientId;
            this._accessPointSgtin = configDataOrApId.accessPointSgtin.replace(/[^a-fA-F0-9 ]/g, '');
            this._pin = configDataOrApId.pin;
            this._deviceId = configDataOrApId.deviceId || randomUUID();
        }

        this._clientCharacteristics = {
            clientCharacteristics: {
                apiVersion: '12',
                applicationIdentifier: 'iobroker',
                applicationVersion: '1.0',
                deviceManufacturer: 'none',
                deviceType: 'Computer',
                language: 'en_US',
                osType: 'Linux',
                osVersion: 'NT',
            },
            id: this._accessPointSgtin,
        };
    }

    getSaveData(): HmCloudConfigData {
        return {
            authToken: this._authToken,
            clientAuthToken: this._clientAuthToken,
            clientId: this._clientId,
            accessPointSgtin: this._accessPointSgtin,
            pin: this._pin,
            deviceId: this._deviceId,
        };
    }

    async getHomematicHosts(): Promise<void> {
        let res;
        try {
            const response = await axios.post(
                'https://lookup.homematic.com:48335/getHost',
                this._clientCharacteristics,
            );
            res = response.data;
        } catch (err) {
            this.requestError && this.requestError(err);
        }
        if (res && typeof res === 'object') {
            this._urlREST = res.urlREST;
            this._urlWebSocket = res.urlWebSocket;
            if (this._urlWebSocket.startsWith('http')) {
                this._urlWebSocket = `ws${this._urlWebSocket.substring(4)}`; // make sure it is ws:// or wss://
            }
        }
        if (!this._urlREST || !this._urlWebSocket) {
            throw new Error('Could not get host details. Please check the SGTIN.');
        }
    }

    // =========== API for Token generation ===========

    async auth1connectionRequest(deviceName: string = 'hmipnodejs'): Promise<unknown> {
        const headers: Record<string, string> = {
            'content-type': 'application/json',
            accept: 'application/json',
            VERSION: '12',
            CLIENTAUTH: this._clientAuthToken,
            'ACCESSPOINT-ID': this._accessPointSgtin,
        };
        if (this._pin) {
            headers.PIN = this._pin;
        }
        const body = {
            deviceId: this._deviceId,
            deviceName,
            sgtin: this._accessPointSgtin,
        };
        try {
            const response = await axios.post(`${this._urlREST}/hmip/auth/connectionRequest`, body, {
                headers,
                validateStatus: status => status < 400,
            });
            return response.data;
        } catch (err) {
            this.requestError && this.requestError(err);
            return null;
        }
    }

    async auth2isRequestAcknowledged(): Promise<boolean> {
        const headers = {
            'content-type': 'application/json',
            accept: 'application/json',
            VERSION: '12',
            CLIENTAUTH: this._clientAuthToken,
            'ACCESSPOINT-ID': this._accessPointSgtin,
        };
        const body = { deviceId: this._deviceId, accessPointId: this._accessPointSgtin };
        try {
            await axios.post(`${this._urlREST}/hmip/auth/isRequestAcknowledged`, body, {
                headers,
                validateStatus: status => status === 200,
            });
            return true;
        } catch (err) {
            if (err.response && err.response.status !== 400) {
                this.requestError && this.requestError(err);
            }
            return false;
        }
    }

    async auth3requestAuthToken(): Promise<void> {
        const headers = {
            'content-type': 'application/json',
            accept: 'application/json',
            VERSION: '12',
            CLIENTAUTH: this._clientAuthToken,
            'ACCESSPOINT-ID': this._accessPointSgtin,
        };
        let body: Record<string, string> = { deviceId: this._deviceId };
        let res;
        try {
            let response = await axios.post(`${this._urlREST}/hmip/auth/requestAuthToken`, body, {
                headers,
                validateStatus: status => status < 400,
            });
            res = response.data;
            this._authToken = res.authToken;
            body = {
                deviceId: this._deviceId,
                authToken: this._authToken,
            };
            response = await axios.post(`${this._urlREST}/hmip/auth/confirmAuthToken`, body, {
                headers,
                validateStatus: status => status < 400,
            });
            res = response.data;
            this._clientId = res.clientId;
        } catch (err) {
            this.requestError && this.requestError(err);
        }
    }

    async callRestApi(path: string, data?: unknown): Promise<unknown> {
        const headers = {
            'content-type': 'application/json',
            accept: 'application/json',
            VERSION: '12',
            AUTHTOKEN: this._authToken,
            CLIENTAUTH: this._clientAuthToken,
            'ACCESSPOINT-ID': this._accessPointSgtin,
        };
        try {
            const response = await axios.post(`${this._urlREST}/hmip/${path}`, data, { headers });
            return response.data;
        } catch (err) {
            this.requestError && this.requestError(err);
        }
    }

    // =========== API for HM ===========
    /**
     * Replaces the cached configuration with a getCurrentState response.
     *
     * @param state a getCurrentState response
     */
    applyCurrentState(state: HmIpCurrentState): void {
        this.home = state.home;
        this.groups = state.groups || {};
        this.clients = state.clients || {};
        this.devices = state.devices || {};
        this.rules = (state.home && state.home.ruleMetaDatas) || {};
    }

    async loadCurrentConfig(): Promise<void> {
        const state = (await this.callRestApi('home/getCurrentState', this._clientCharacteristics)) as
            HmIpCurrentState | undefined;
        if (!state) {
            throw new Error('No current State received');
        }
        this.applyCurrentState(state);
    }

    // =========== Event Handling ===========

    dispose(): void {
        this.isClosed = true;
        if (this._ws) {
            this._ws.close();
        }
        if (this._connectTimeout) {
            clearTimeout(this._connectTimeout);
            this._connectTimeout = null;
        }
        if (this._pingInterval) {
            clearInterval(this._pingInterval);
            this._pingInterval = null;
        }
    }

    /**
     * Pings the cloud, and gives up on a connection that has stopped answering.
     *
     * A connection the cloud or a NAT table drops silently stays readyState OPEN and raises
     * neither an error nor a close, so this deadline is the only thing that ever notices.
     */
    _checkConnectionAlive(): void {
        if (!this._ws) {
            return;
        }
        const silentFor = Date.now() - this._lastAlive;
        if (silentFor > WS_STALE_TIMEOUT) {
            this.staleConnection && this.staleConnection(silentFor);
            this._ws.terminate();
            return;
        }
        this._ws.ping(() => {});
    }

    connectWebsocket(): void {
        // dispose() disables the reconnect below, and a reconnect is exactly what this is
        this.isClosed = false;
        this._lastAlive = Date.now();
        if (this._pingInterval) {
            clearInterval(this._pingInterval);
            this._pingInterval = null;
        }
        this._ws = new WebSocket(this._urlWebSocket, {
            headers: {
                AUTHTOKEN: this._authToken,
                CLIENTAUTH: this._clientAuthToken,
                'ACCESSPOINT-ID': this._accessPointSgtin,
            },
            perMessageDeflate: false,
        });

        this._ws.on('open', () => {
            this.opened && this.opened();

            this._lastAlive = Date.now();
            this._pingInterval && clearInterval(this._pingInterval);
            this._pingInterval = setInterval(() => this._checkConnectionAlive(), WS_PING_INTERVAL);
        });

        this._ws.on('close', (code, reason) => {
            this.closed && this.closed(code, reason.toString('utf8'));
            if (this._pingInterval) {
                clearInterval(this._pingInterval);
                this._pingInterval = null;
            }
            if (!this.isClosed) {
                this._connectTimeout && clearTimeout(this._connectTimeout);
                this._connectTimeout = setTimeout(() => {
                    this._connectTimeout = null;
                    this.connectWebsocket();
                }, 10000);
            }
        });

        this._ws.on('error', error => {
            this.errored && this.errored(error);
            if (this._pingInterval) {
                clearInterval(this._pingInterval);
                this._pingInterval = null;
            }
            if (!this.isClosed) {
                this._connectTimeout && clearTimeout(this._connectTimeout);
                this._connectTimeout = setTimeout(() => {
                    this._connectTimeout = null;
                    this.connectWebsocket();
                }, 10000);
            }
        });

        this._ws.on('unexpected-response', (request, response) => {
            this.unexpectedResponse && this.unexpectedResponse(request, response);
            if (this._pingInterval) {
                clearInterval(this._pingInterval);
                this._pingInterval = null;
            }
            if (!this.isClosed) {
                this._connectTimeout && clearTimeout(this._connectTimeout);
                this._connectTimeout = setTimeout(() => {
                    this._connectTimeout = null;
                    this.connectWebsocket();
                }, 10000);
            }
        });

        this._ws.on('message', d => {
            this._lastAlive = Date.now();
            // the cloud only sends text frames, which ws hands over as a Buffer; the other shapes
            // RawData allows are joined rather than run through Object.prototype.toString
            const dString = Buffer.isBuffer(d)
                ? d.toString('utf8')
                : (Array.isArray(d) ? Buffer.concat(d) : Buffer.from(d)).toString('utf8');
            this.dataReceived && this.dataReceived(dString);
            const data = JSON.parse(dString);
            this._parseEventdata(data);
        });

        this._ws.on('ping', () => {
            this._lastAlive = Date.now();
            this.dataReceived && this.dataReceived('ping');
        });

        this._ws.on('pong', () => {
            this._lastAlive = Date.now();
            this.dataReceived && this.dataReceived('pong');
        });
    }

    _parseEventdata(data: unknown): void {
        const events = (data as { events?: Record<string, CloudEvent> } | null)?.events ?? {};
        for (const i in events) {
            const ev = events[i];
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
                    ev.group && delete this.groups[ev.group.id];
                    break;
                case 'CLIENT_REMOVED':
                    ev.client && delete this.clients[ev.client.id];
                    break;
                case 'HOME_CHANGED':
                    this.home = ev.home ?? null;
                    break;
            }
            this.eventRaised && this.eventRaised(ev);
        }
    }

    // =========== API for HM Devices ===========

    // boolean
    async deviceControlSetSwitchState(deviceId: string, on: boolean, channelIndex: string | number = 1): Promise<void> {
        const data = {
            deviceId,
            on,
            channelIndex,
        };
        await this.callRestApi('device/control/setSwitchState', data);
    }

    // door commands as number: 1 = open; 2 = stop; 3 = close; 4 = ventilation position
    // DoorState
    //     CLOSED = auto()
    //     OPEN = auto()
    //     VENTILATION_POSITION = auto()
    //     POSITION_UNKNOWN = auto()
    //
    // DoorCommand
    //     OPEN = auto()
    //     STOP = auto()
    //     CLOSE = auto()
    //     PARTIAL_OPEN = auto()
    async deviceControlSendDoorCommand(
        deviceId: string,
        doorCommand: number,
        channelIndex: string | number = 1,
    ): Promise<void> {
        const data = { deviceId, channelIndex, doorCommand };
        await this.callRestApi('device/control/sendDoorCommand', data);
    }

    async deviceControlSetLockState(
        deviceId: string,
        // the dispatcher rewrites 1/2/3 to OPEN/LOCKED/UNLOCKED before this is called
        lockState: string,
        pin: string | null | undefined,
        channelIndex: string | number = 1,
    ): Promise<void> {
        const data = {
            deviceId,
            channelIndex,
            authorizationPin: pin === null || pin === undefined ? '' : String(pin),
            targetLockState: lockState,
        };
        await this.callRestApi('device/control/setLockState', data);
    }

    async deviceControlResetEnergyCounter(deviceId: string, channelIndex: string | number = 1): Promise<void> {
        const data = { deviceId, channelIndex };
        await this.callRestApi('device/control/resetEnergyCounter', data);
    }

    async deviceConfigurationSetOperationLock(
        deviceId: string,
        operationLock: boolean,
        channelIndex: string | number = 1,
    ): Promise<void> {
        const data = { deviceId, channelIndex, operationLock: operationLock };
        await this.callRestApi('device/configuration/setOperationLock', data);
    }

    // ClimateControlDisplay
    //     ACTUAL = auto()
    //     SETPOINT = auto()
    //     ACTUAL_HUMIDITY = auto()
    async deviceConfigurationSetClimateControlDisplay(
        deviceId: string,
        display: string,
        channelIndex: string | number = 1,
    ): Promise<void> {
        const data = { deviceId, channelIndex, display };
        await this.callRestApi('device/configuration/setClimateControlDisplay', data);
    }

    // float 0.0-1.0
    async deviceConfigurationSetMinimumFloorHeatingValvePosition(
        deviceId: string,
        minimumFloorHeatingValvePosition: number,
        channelIndex: string | number = 1,
    ): Promise<void> {
        const data = { deviceId, channelIndex, minimumFloorHeatingValvePosition };
        await this.callRestApi('device/configuration/setMinimumFloorHeatingValvePosition', data);
    }

    // float 0.0-1.0??
    async deviceControlSetDimLevel(
        deviceId: string,
        dimLevel: number,
        channelIndex: string | number = 1,
    ): Promise<void> {
        const data = { deviceId, channelIndex, dimLevel };
        await this.callRestApi('device/control/setDimLevel', data);
    }

    // float 0.0-1.0??
    async deviceControlSetRgbDimLevel(
        deviceId: string,
        rgb: string,
        dimLevel: number,
        channelIndex: string | number = 1,
    ): Promise<void> {
        const data = { deviceId, channelIndex, simpleRGBColorState: rgb, dimLevel };
        await this.callRestApi('device/control/setSimpleRGBColorDimLevel', data);
    }

    // float 0.0-1.0??
    // not used right now
    async deviceControlSetRgbDimLevelWithTime(
        deviceId: string,
        rgb: string,
        dimLevel: number,
        onTime: number,
        rampTime: number,
        channelIndex: string | number = 1,
    ): Promise<void> {
        const data = { deviceId, channelIndex, simpleRGBColorState: rgb, dimLevel, onTime, rampTime };
        await this.callRestApi('device/control/setSimpleRGBColorDimLevelWithTime', data);
    }

    // float 0.0-1.0??
    async deviceControlOpticalSignalBehaviour(
        deviceId: string,
        rgb: string,
        dimLevel: number,
        channelIndex = 2,
        opticalSignalBehaviour: string,
    ): Promise<void> {
        const data = { deviceId, channelIndex, dimLevel, simpleRGBColorState: rgb, opticalSignalBehaviour };
        await this.callRestApi('device/control/setOpticalSignal', data);
    }

    // float 0.0 = open - 1.0 = closed
    async deviceControlPullLatch(
        deviceId: string,
        authorizationPin: string = '',
        channelIndex: string | number = 1,
    ): Promise<void> {
        const data = {
            deviceId,
            channelIndex,
            authorizationPin: authorizationPin === null ? '' : String(authorizationPin),
        };
        await this.callRestApi('device/control/pullLatch', data);
    }

    async deviceControlResetPassageCounter(deviceId: string, channelIndex: string | number = 1): Promise<void> {
        const data = { deviceId, channelIndex };
        await this.callRestApi('device/control/resetPassageCounter', data);
    }

    async deviceControlResetWaterVolume(deviceId: string, channelIndex: string | number = 1): Promise<void> {
        const data = { deviceId, channelIndex };
        await this.callRestApi('device/control/resetWaterVolume', data);
    }

    async deviceControlToggleWateringState(deviceId: string, channelIndex: string | number = 1): Promise<void> {
        const data = { deviceId, channelIndex };
        await this.callRestApi('device/control/toggleWateringState', data);
    }

    async deviceControlSetWateringSwitchStateWithTime(
        deviceId: string,
        wateringActive: boolean,
        wateringTime: number,
        channelIndex: string | number = 1,
    ): Promise<void> {
        const data = { deviceId, channelIndex, wateringActive, wateringTime };
        await this.callRestApi('device/control/setWateringSwitchStateWithTime', data);
    }

    async deviceControlSetFavoriteShadingPosition(deviceId: string, channelIndex: string | number = 1): Promise<void> {
        const data = { deviceId, channelIndex };
        await this.callRestApi('device/control/setFavoriteShadingPosition', data);
    }

    async deviceControlSetMotionDetectionActive(
        deviceId: string,
        motionDetectionActive: boolean,
        channelIndex: string | number = 1,
    ): Promise<void> {
        const data = { deviceId, channelIndex, motionDetectionActive };
        await this.callRestApi('device/control/setMotionDetectionActive', data);
    }

    async deviceControlSetSoundFileVolumeLevel(
        deviceId: string,
        soundFile: string,
        volumeLevel: number,
        channelIndex: string | number = 1,
    ): Promise<void> {
        const data = { deviceId, channelIndex, soundFile, volumeLevel };
        await this.callRestApi('device/control/setSoundFileVolumeLevel', data);
    }

    async deviceControlStartLightScene(
        deviceId: string,
        id: number,
        dimLevel: number,
        channelIndex: string | number = 1,
    ): Promise<void> {
        const data = { deviceId, channelIndex, id, dimLevel };
        await this.callRestApi('device/control/startLightScene', data);
    }

    async deviceControlSetDimLevelWithTime(
        deviceId: string,
        dimLevel: number,
        onTime: number,
        rampTime: number,
        channelIndex: string | number = 1,
    ): Promise<void> {
        const data = { deviceId, channelIndex, dimLevel, onTime, rampTime };
        await this.callRestApi('device/control/setDimLevelWithTime', data);
    }

    async deviceControlSetHueSaturationDimLevelWithTime(
        deviceId: string,
        hue: number,
        saturationLevel: number,
        dimLevel: number,
        onTime: number,
        rampTime: number,
        channelIndex: string | number = 1,
    ): Promise<void> {
        const data = { deviceId, channelIndex, hue, saturationLevel, dimLevel, onTime, rampTime };
        await this.callRestApi('device/control/setHueSaturationDimLevelWithTime', data);
    }

    async deviceControlSetColorTemperatureDimLevelWithTime(
        deviceId: string,
        colorTemperature: number,
        dimLevel: number,
        onTime: number,
        rampTime: number,
        channelIndex: string | number = 1,
    ): Promise<void> {
        const data = { deviceId, channelIndex, colorTemperature, dimLevel, onTime, rampTime };
        await this.callRestApi('device/control/setColorTemperatureDimLevelWithTime', data);
    }

    async deviceControlSetOpticalSignalWithTime(
        deviceId: string,
        opticalSignalBehaviour: string,
        simpleRGBColorState: string,
        dimLevel: number,
        onTime: number,
        rampTime: number,
        channelIndex: string | number = 1,
    ): Promise<void> {
        const data = {
            deviceId,
            channelIndex,
            opticalSignalBehaviour,
            simpleRGBColorState,
            dimLevel,
            onTime,
            rampTime,
        };
        await this.callRestApi('device/control/setOpticalSignalWithTime', data);
    }

    async deviceControlSetWateringSwitchState(
        deviceId: string,
        wateringActive: boolean,
        channelIndex: string | number = 1,
    ): Promise<void> {
        const data = { deviceId, channelIndex, wateringActive };
        await this.callRestApi('device/control/setWateringSwitchState', data);
    }

    async deviceControlSetHueSaturationDimLevel(
        deviceId: string,
        hue: number,
        saturationLevel: number,
        dimLevel: number,
        channelIndex: string | number = 1,
    ): Promise<void> {
        const data = { deviceId, channelIndex, hue, saturationLevel, dimLevel };
        await this.callRestApi('device/control/setHueSaturationDimLevel', data);
    }

    async deviceControlSetColorTemperatureDimLevel(
        deviceId: string,
        colorTemperature: number,
        dimLevel: number,
        channelIndex: string | number = 1,
    ): Promise<void> {
        const data = { deviceId, channelIndex, colorTemperature, dimLevel };
        await this.callRestApi('device/control/setColorTemperatureDimLevel', data);
    }

    async deviceControlSetShutterLevel(
        deviceId: string,
        shutterLevel: number,
        channelIndex: string | number = 1,
    ): Promise<void> {
        const data = { deviceId, channelIndex, shutterLevel };
        await this.callRestApi('device/control/setShutterLevel', data);
    }

    async deviceControlStartImpulse(deviceId: string, channelIndex: string | number = 1): Promise<void> {
        const data = { deviceId, channelIndex };
        await this.callRestApi('device/control/startImpulse', data);
    }

    // float 0.0 = open - 1.0 = closed
    async deviceControlSetSlatsLevel(
        deviceId: string,
        slatsLevel: number,
        shutterLevel: number,
        channelIndex: string | number = 1,
    ): Promise<void> {
        const data = { deviceId, channelIndex, slatsLevel, shutterLevel };
        await this.callRestApi('device/control/setSlatsLevel', data);
    }

    async deviceControlStop(deviceId: string, channelIndex: string | number = 1): Promise<void> {
        const data = { deviceId, channelIndex };
        await this.callRestApi('device/control/stop', data);
    }

    async deviceControlSetPrimaryShadingLevel(
        deviceId: string,
        primaryShadingLevel: number,
        channelIndex: string | number = 1,
    ): Promise<void> {
        const data = { deviceId, channelIndex, primaryShadingLevel: primaryShadingLevel };
        await this.callRestApi('device/control/setPrimaryShadingLevel', data);
    }

    async deviceControlSetSecondaryShadingLevel(
        deviceId: string,
        primaryShadingLevel: number,
        secondaryShadingLevel: number,
        channelIndex: string | number = 1,
    ): Promise<void> {
        const data = { deviceId, channelIndex, primaryShadingLevel, secondaryShadingLevel };
        await this.callRestApi('device/control/setSecondaryShadingLevel', data);
    }

    // AcousticAlarmSignal
    //     DISABLE_ACOUSTIC_SIGNAL = auto()
    //     FREQUENCY_RISING = auto()
    //     FREQUENCY_FALLING = auto()
    //     FREQUENCY_RISING_AND_FALLING = auto()
    //     FREQUENCY_ALTERNATING_LOW_HIGH = auto()
    //     FREQUENCY_ALTERNATING_LOW_MID_HIGH = auto()
    //     FREQUENCY_HIGHON_OFF = auto()
    //     FREQUENCY_HIGHON_LONGOFF = auto()
    //     FREQUENCY_LOWON_OFF_HIGHON_OFF = auto()
    //     FREQUENCY_LOWON_LONGOFF_HIGHON_LONGOFF = auto()
    //     LOW_BATTERY = auto()
    //     DISARMED = auto()
    //     INTERNALLY_ARMED = auto()
    //     EXTERNALLY_ARMED = auto()
    //     DELAYED_INTERNALLY_ARMED = auto()
    //     DELAYED_EXTERNALLY_ARMED = auto()
    //     EVENT = auto()
    //     ERROR = auto()
    async deviceConfigurationSetAcousticAlarmSignal(
        deviceId: string,
        acousticAlarmSignal: string,
        channelIndex: string | number = 1,
    ): Promise<void> {
        const data = { deviceId, acousticAlarmSignal, channelIndex };
        await this.callRestApi('device/configuration/setAcousticAlarmSignal', data);
    }

    // AcousticAlarmTiming
    //     PERMANENT = auto()
    //     THREE_MINUTES = auto()
    //     SIX_MINUTES = auto()
    //     ONCE_PER_MINUTE = auto()
    async deviceConfigurationSetAcousticAlarmTiming(
        deviceId: string,
        acousticAlarmTiming: string,
        channelIndex: string | number = 1,
    ): Promise<void> {
        const data = { deviceId, acousticAlarmTiming, channelIndex };
        await this.callRestApi('device/configuration/setAcousticAlarmTiming', data);
    }

    // WaterAlarmTrigger
    //     NO_ALARM = auto()
    //     MOISTURE_DETECTION = auto()
    //     WATER_DETECTION = auto()
    //     WATER_MOISTURE_DETECTION = auto()
    async deviceConfigurationSetAcousticWaterAlarmTrigger(
        deviceId: string,
        acousticWaterAlarmTrigger: string,
        channelIndex: string | number = 1,
    ): Promise<void> {
        const data = { deviceId, acousticWaterAlarmTrigger, channelIndex };
        await this.callRestApi('device/configuration/setAcousticWaterAlarmTrigger', data);
    }

    // WaterAlarmTrigger
    //     NO_ALARM = auto()
    //     MOISTURE_DETECTION = auto()
    //     WATER_DETECTION = auto()
    //     WATER_MOISTURE_DETECTION = auto()
    async deviceConfigurationSetInAppWaterAlarmTrigger(
        deviceId: string,
        inAppWaterAlarmTrigger: string,
        channelIndex: string | number = 1,
    ): Promise<void> {
        const data = { deviceId, inAppWaterAlarmTrigger, channelIndex };
        await this.callRestApi('device/configuration/setInAppWaterAlarmTrigger', data);
    }

    // WaterAlarmTrigger
    //     NO_ALARM = auto()
    //     MOISTURE_DETECTION = auto()
    //     WATER_DETECTION = auto()
    //     WATER_MOISTURE_DETECTION = auto()
    async deviceConfigurationSetSirenWaterAlarmTrigger(
        deviceId: string,
        sirenWaterAlarmTrigger: string,
        channelIndex: string | number = 1,
    ): Promise<void> {
        const data = { deviceId, sirenWaterAlarmTrigger, channelIndex };
        await this.callRestApi('device/configuration/setSirenWaterAlarmTrigger', data);
    }

    // AccelerationSensorMode
    //     ANY_MOTION = auto()
    //     FLAT_DECT = auto()
    async deviceConfigurationSetAccelerationSensorMode(
        deviceId: string,
        accelerationSensorMode: string,
        channelIndex: string | number = 1,
    ): Promise<void> {
        const data = { deviceId, accelerationSensorMode, channelIndex };
        await this.callRestApi('device/configuration/setAccelerationSensorMode', data);
    }

    // AccelerationSensorNeutralPosition
    //     HORIZONTAL = auto()
    //     VERTICAL = auto()
    async deviceConfigurationSetAccelerationSensorNeutralPosition(
        deviceId: string,
        accelerationSensorNeutralPosition: string,
        channelIndex: string | number = 1,
    ): Promise<void> {
        const data = { deviceId, accelerationSensorNeutralPosition, channelIndex };
        await this.callRestApi('device/configuration/setAccelerationSensorNeutralPosition', data);
    }

    // accelerationSensorTriggerAngle = int
    async deviceConfigurationSetAccelerationSensorTriggerAngle(
        deviceId: string,
        accelerationSensorTriggerAngle: number,
        channelIndex: string | number = 1,
    ): Promise<void> {
        const data = { deviceId, accelerationSensorTriggerAngle, channelIndex };
        await this.callRestApi('device/configuration/setAccelerationSensorTriggerAngle', data);
    }

    // AccelerationSensorSensitivity
    //     SENSOR_RANGE_16G = auto()
    //     SENSOR_RANGE_8G = auto()
    //     SENSOR_RANGE_4G = auto()
    //     SENSOR_RANGE_2G = auto()
    //     SENSOR_RANGE_2G_PLUS_SENS = auto()
    //     SENSOR_RANGE_2G_2PLUS_SENSE = auto()
    async deviceConfigurationSetAccelerationSensorSensitivity(
        deviceId: string,
        accelerationSensorSensitivity: string,
        channelIndex: string | number = 1,
    ): Promise<void> {
        const data = { deviceId, accelerationSensorSensitivity, channelIndex };
        await this.callRestApi('device/configuration/setAccelerationSensorSensitivity', data);
    }

    // accelerationSensorEventFilterPeriod = float
    async deviceConfigurationSetAccelerationSensorEventFilterPeriod(
        deviceId: string,
        accelerationSensorEventFilterPeriod: number,
        channelIndex: string | number = 1,
    ): Promise<void> {
        const data = { deviceId, accelerationSensorEventFilterPeriod, channelIndex };
        await this.callRestApi('device/configuration/setAccelerationSensorEventFilterPeriod', data);
    }

    // NotificationSoundType
    //     SOUND_NO_SOUND = auto()
    //     SOUND_SHORT = auto()
    //     SOUND_SHORT_SHORT = auto()
    //     SOUND_LONG = auto()
    async deviceConfigurationSetNotificationSoundType(
        deviceId: string,
        notificationSoundType: string,
        isHighToLow: boolean,
        channelIndex: string | number = 1,
    ): Promise<void> {
        const data = { deviceId, notificationSoundType, isHighToLow, channelIndex };
        await this.callRestApi('device/configuration/setNotificationSoundType', data);
    }

    async deviceConfigurationSetRouterModuleEnabled(
        deviceId: string,
        routerModuleEnabled: boolean,
        channelIndex: string | number = 1,
    ): Promise<void> {
        const data = { deviceId, routerModuleEnabled, channelIndex };
        await this.callRestApi('device/configuration/setRouterModuleEnabled', data);
    }

    async deviceDeleteDevice(deviceId: string): Promise<void> {
        const data = { deviceId };
        await this.callRestApi('device/deleteDevice', data);
    }

    async deviceSetDeviceLabel(deviceId: string, label: string): Promise<void> {
        const data = { deviceId, label };
        await this.callRestApi('device/setDeviceLabel', data);
    }

    async deviceIsUpdateApplicable(deviceId: string): Promise<void> {
        const data = { deviceId };
        await this.callRestApi('device/isUpdateApplicable', data);
    }

    async deviceAuthorizeUpdate(deviceId: string): Promise<void> {
        const data = { deviceId };
        await this.callRestApi('device/authorizeUpdate', data);
    }

    // =========== API for HM Groups ===========

    async groupHeatingSetPointTemperature(groupId: string, setPointTemperature: number): Promise<void> {
        const data = { groupId, setPointTemperature };
        await this.callRestApi('group/heating/setSetPointTemperature', data);
    }

    async groupHeatingSetBoostDuration(groupId: string, boostDuration: number): Promise<void> {
        const data = { groupId, boostDuration };
        await this.callRestApi('group/heating/setBoostDuration', data);
    }

    async groupHeatingSetBoost(groupId: string, boost: boolean): Promise<void> {
        const data = { groupId, boost };
        await this.callRestApi('group/heating/setBoost', data);
    }

    async groupHeatingSetControlMode(groupId: string, controlMode: string): Promise<void> {
        const data = { groupId, controlMode };
        //AUTOMATIC,MANUAL
        await this.callRestApi('group/heating/setControlMode', data);
    }

    async groupHeatingSetActiveProfile(groupId: string, profileIndex: string): Promise<void> {
        const data = { groupId, profileIndex };
        await this.callRestApi('group/heating/setActiveProfile', data);
    }

    async groupSwitchingSetState(groupId: string, on: boolean): Promise<void> {
        const data = { groupId, on };
        await this.callRestApi('group/switching/setState', data);
    }

    async groupSwitchingSetShutterLevel(groupId: string, shutterLevel: number): Promise<void> {
        const data = { groupId, shutterLevel };
        await this.callRestApi('group/switching/setShutterLevel', data);
    }

    async groupSwitchingSetSlatsLevel(groupId: string, slatsLevel: number, shutterLevel: number): Promise<void> {
        const data = { groupId, shutterLevel, slatsLevel };
        await this.callRestApi('group/switching/setSlatsLevel', data);
    }

    async groupSwitchingStop(groupId: string): Promise<void> {
        const data = { groupId };
        await this.callRestApi('group/switching/stop', data);
    }

    async groupSwitchingLinkedSetOnTime(groupId: string, onTime: number): Promise<void> {
        const data = { groupId, onTime };
        await this.callRestApi('group/switching/linked/setOnTime', data);
    }

    async groupHeatingSetProfileMode(groupId: string, profileMode: string): Promise<void> {
        const data = { groupId, profileMode };
        await this.callRestApi('group/heating/setProfileMode', data);
    }

    async groupSetGroupLabel(groupId: string, label: string): Promise<void> {
        const data = { groupId, label };
        await this.callRestApi('group/setGroupLabel', data);
    }

    async groupDeleteGroup(groupId: string): Promise<void> {
        const data = { groupId };
        await this.callRestApi('group/deleteGroup', data);
    }

    async groupSwitchingAlarmSetOnTime(groupId: string, onTime: number): Promise<void> {
        const data = { groupId, onTime };
        await this.callRestApi('group/switching/alarm/setOnTime', data);
    }

    async groupSwitchingAlarmTestSignalOptical(groupId: string, signalOptical: string): Promise<void> {
        const data = { groupId, signalOptical };
        await this.callRestApi('group/switching/alarm/testSignalOptical', data);
    }

    async groupSwitchingAlarmSetSignalOptical(groupId: string, signalOptical: string): Promise<void> {
        const data = { groupId, signalOptical };
        await this.callRestApi('group/switching/alarm/setSignalOptical', data);
    }

    async groupSwitchingAlarmTestSignalAcoustic(groupId: string, signalAcoustic: string): Promise<void> {
        const data = { groupId, signalAcoustic };
        await this.callRestApi('group/switching/alarm/testSignalAcoustic', data);
    }

    async groupSwitchingAlarmSetSignalAcoustic(groupId: string, signalAcoustic: string): Promise<void> {
        const data = { groupId, signalAcoustic };
        await this.callRestApi('group/switching/alarm/setSignalAcoustic', data);
    }

    // =========== API for HM Clients ===========

    async clientDeleteClient(clientId: string): Promise<void> {
        const data = { clientId };
        await this.callRestApi('client/deleteClient', data);
    }

    // =========== API for HM Home ===========

    async homeHeatingActivateAbsenceWithPeriod(endTime: string): Promise<void> {
        const data = { endTime };
        await this.callRestApi('home/heating/activateAbsenceWithPeriod', data);
    }

    async homeHeatingActivateAbsenceWithDuration(duration: number): Promise<void> {
        const data = { duration };
        await this.callRestApi('home/heating/activateAbsenceWithDuration', data);
    }

    async homeHeatingActivateAbsencePermanent(): Promise<void> {
        await this.callRestApi('home/heating/activateAbsencePermanent');
    }

    async homeHeatingDeactivateAbsence(): Promise<void> {
        await this.callRestApi('home/heating/deactivateAbsence');
    }

    async homeHeatingActivateVacation(temperature: number, endTime: string): Promise<void> {
        const data = { temperature, endTime };
        await this.callRestApi('home/heating/activateVacation', data);
    }

    async homeHeatingDeactivateVacation(): Promise<void> {
        await this.callRestApi('home/heating/deactivateVacation');
    }

    async homeSetIntrusionAlertThroughSmokeDetectors(intrusionAlertThroughSmokeDetectors: boolean): Promise<void> {
        const data = { intrusionAlertThroughSmokeDetectors };
        await this.callRestApi('home/security/setIntrusionAlertThroughSmokeDetectors', data);
    }

    _securityZoneGroups(): HmIpGroup[] {
        return Object.values(this.groups || {}).filter(group => group && group.type === 'SECURITY_ZONE');
    }

    async homeHeatingSetCooling(cooling: boolean): Promise<void> {
        const data = { cooling };
        await this.callRestApi('home/heating/setCooling', data);
    }

    async homeHeatingSetCoolingEnabled(coolingEnabled: boolean): Promise<void> {
        const data = { coolingEnabled };
        await this.callRestApi('home/heating/setCoolingEnabled', data);
    }

    /**
     * The cloud takes the whole set of groups that are left out of cooling, not one group at a time.
     *
     * @param nonCoolingGroups the ids of every group that is not to be cooled
     */
    async homeHeatingSetNonCoolingGroups(nonCoolingGroups: string[]): Promise<void> {
        const data = { nonCoolingGroups };
        await this.callRestApi('home/heating/setNonCoolingGroups', data);
    }

    /**
     * @param internal silence the internal zone
     * @param external silence the external zone
     * @returns undefined when the request never reached the cloud
     */
    async homeSetZonesSilentAlarm(internal: boolean, external: boolean): Promise<unknown> {
        const data = { zonesSilentAlarm: { INTERNAL: internal, EXTERNAL: external } };
        return this.callRestApi('home/security/setZonesSilentAlarm', data);
    }

    async homeSetZoneActivationDelay(zoneActivationDelay: number): Promise<void> {
        const data = { zoneActivationDelay };
        await this.callRestApi('home/security/setZoneActivationDelay', data);
    }

    async homeGetSecurityJournal(): Promise<unknown> {
        return this.callRestApi('home/security/getSecurityJournal');
    }

    async homeSetLocation(city: string, latitude: string, longitude: string): Promise<void> {
        const data = { city, latitude, longitude };
        await this.callRestApi('home/setLocation', data);
    }

    async homeSetTimezone(timezoneId: string): Promise<void> {
        const data = { timezoneId };
        await this.callRestApi('home/setTimezone', data);
    }

    async homeSetPowerMeterUnitPrice(powerMeterUnitPrice: number): Promise<void> {
        const data = { powerMeterUnitPrice };
        await this.callRestApi('home/setPowerMeterUnitPrice', data);
    }

    async homeStartInclusionModeForDevice(deviceId: string): Promise<void> {
        const data = { deviceId };
        await this.callRestApi('home/startInclusionModeForDevice', data);
    }

    /**
     * @param ruleId the rule to enable or disable
     * @param enabled whether the rule should run
     * @returns undefined when the request never reached the cloud
     */
    async ruleEnableSimpleRule(ruleId: string, enabled: boolean): Promise<unknown> {
        const data = { ruleId, enabled };
        return this.callRestApi('rule/enableSimpleRule', data);
    }

    /**
     * @param ruleId the rule to relabel
     * @param label the new label
     * @returns undefined when the request never reached the cloud
     */
    async ruleSetRuleLabel(ruleId: string, label: string): Promise<unknown> {
        const data = { ruleId, label };
        return this.callRestApi('rule/setRuleLabel', data);
    }

    hasRequestBasedSecurityZones(): boolean {
        return this._securityZoneGroups().some(group => group.label === 'ABSENCE' || group.label === 'PRESENCE');
    }

    hasClassicSecurityZones(): boolean {
        return this._securityZoneGroups().some(group => group.label === 'INTERNAL' || group.label === 'EXTERNAL');
    }

    /**
     * Reports which security zones are armed, mapped onto the classic internal/external pair.
     *
     * A request-based panel arms the mutually exclusive ABSENCE or PRESENCE zone instead, so
     * ABSENCE reads as armed away (both) and PRESENCE as armed at home (external only) - the
     * same mapping `_buildZonesActivation` writes.
     *
     * @returns
     *          `mode` names the same state the two booleans carry, in the vocabulary of the zone
     *          family it is armed in: OFF, PRESENCE or ABSENCE for ABSENCE/PRESENCE zones, OFF,
     *          INTERNAL, EXTERNAL or INTERNAL_AND_EXTERNAL for the classic ones. `requestBased`
     *          stays the panel's own kind even when a mixed home is armed in the classic family.
     */
    securityZonesArmedState(): SecurityZonesArmedState {
        // zone labels come from the cloud, so they must not reach an object's prototype
        const armed = Object.create(null);
        for (const group of this._securityZoneGroups()) {
            // request-based panels omit "active" on a disarmed zone
            armed[String(group.label)] = group.active === true;
        }
        // a home can carry both zone families, and an armed zone of either is an armed zone: the
        // pair is the union, so no armed zone can be lost whichever family the panel prefers
        const away = armed.ABSENCE === true;
        const internal = armed.INTERNAL === true || away;
        const external = armed.EXTERNAL === true || away || armed.PRESENCE === true;
        // the mode is only a name for that pair, never a second opinion about it, and it is the
        // classic one whenever a classic zone is armed - ABSENCE and PRESENCE could not say so
        const classicArmed = armed.INTERNAL === true || armed.EXTERNAL === true;
        return {
            requestBased: this.hasRequestBasedSecurityZones(),
            internal,
            external,
            mode:
                this.hasRequestBasedSecurityZones() && !classicArmed
                    ? this._requestBasedZoneMode(internal, external)
                    : this._classicZoneMode(internal, external),
        };
    }

    /**
     * @param internal whether the internal zone is armed
     * @param external whether the external zone is armed
     * @returns OFF, PRESENCE or ABSENCE, the modes an ABSENCE/PRESENCE dashboard offers
     */
    _requestBasedZoneMode(internal: boolean, external: boolean): string {
        if (internal) {
            return 'ABSENCE';
        }
        return external ? 'PRESENCE' : 'OFF';
    }

    /**
     * @param internal whether the internal zone is armed
     * @param external whether the external zone is armed
     * @returns the zone combination as an INTERNAL/EXTERNAL dashboard names it
     */
    _classicZoneMode(internal: boolean, external: boolean): string {
        if (internal && external) {
            return 'INTERNAL_AND_EXTERNAL';
        }
        if (internal) {
            return 'INTERNAL';
        }
        return external ? 'EXTERNAL' : 'OFF';
    }

    _buildZonesActivation(requestBased: boolean, internal: boolean, external: boolean): Record<string, boolean> {
        if (requestBased) {
            // the classic internal zone is the away mode, and ABSENCE/PRESENCE are mutually
            // exclusive: away -> ABSENCE, home -> PRESENCE, neither -> disarmed
            return { PRESENCE: external && !internal, ABSENCE: internal };
        }
        return { INTERNAL: internal, EXTERNAL: external };
    }

    _asReasonList(reasons: unknown): string[] {
        return (Array.isArray(reasons) ? reasons : [reasons])
            .filter(reason => reason !== undefined && reason !== null)
            .map(reason => (typeof reason === 'object' ? JSON.stringify(reason) : String(reason)));
    }

    _securityZoneActivationProblems(response: Record<string, unknown>): Record<string, string[]> {
        // device labels are user-chosen, so a plain object would inherit "constructor", "toString", ...
        const problems = Object.create(null);
        if (!response || typeof response !== 'object') {
            return problems;
        }
        const add = (label: string, reasons: unknown): void => {
            const list = this._asReasonList(reasons);
            if (list.length) {
                problems[label] = (problems[label] || []).concat(list);
            }
        };
        add('', response.activationProblems);
        const channelProblems = response.channelActivationProblems as Record<string, unknown> | undefined;
        if (channelProblems && typeof channelProblems === 'object') {
            for (const key of Object.keys(channelProblems)) {
                const device = this.devices && this.devices[String(key).split(':')[0]];
                add(device && device.label ? device.label : String(key), channelProblems[key]);
            }
        }
        return problems;
    }

    _lowBatteryDevicesInZones(zonesActivation: Record<string, boolean>): { devices: string[]; unresolved: number } {
        const labels = new Set<string>();
        let unresolved = 0;
        for (const group of this._securityZoneGroups()) {
            if (zonesActivation[String(group.label)] !== true) {
                continue;
            }
            for (const channel of group.channels || []) {
                const device = channel?.deviceId ? this.devices[channel.deviceId] : undefined;
                const baseChannel = device && device.functionalChannels && device.functionalChannels['0'];
                if (!baseChannel) {
                    unresolved++;
                    continue;
                }
                if (baseChannel.lowBat === true) {
                    labels.add(device.label || String(channel.deviceId));
                }
            }
        }
        return { devices: [...labels], unresolved };
    }

    /**
     * Arms or disarms the alarm system.
     *
     * @param internal arm the internal zone
     * @param external arm the external zone
     * @returns
     *
     *
     *          `requestFailed` marks a request that never reached the cloud. `problems` names what blocked the
     *          activation as {device label: [reason]} and is null on panels that give no such feedback.
     *          `confirmed` is false when the panel answered 200 with nothing to inspect, so an empty
     *          `problems` means "nothing was reported" rather than "nothing blocked it".
     */
    async homeSetZonesActivation(internal: boolean, external: boolean): Promise<ZonesActivationOutcome> {
        const requestBased = this.hasRequestBasedSecurityZones();
        const zonesActivation = this._buildZonesActivation(requestBased, internal, external);
        const data: { zonesActivation: Record<string, boolean>; ignoreLowBat?: boolean } = { zonesActivation };
        const outcome: ZonesActivationOutcome = {
            requestBased,
            classicZonesPresent: this.hasClassicSecurityZones(),
            requestFailed: false,
            confirmed: true,
            problems: null,
            lowBatteryDevices: [],
            lowBatteryLookupIncomplete: false,
        };

        if (!requestBased) {
            outcome.requestFailed = (await this.callRestApi('home/security/setZonesActivation', data)) === undefined;
            return outcome;
        }

        // the request-based panel answers setZonesActivation with 400, and answers the extended call
        // with 200 even when a sensor blocks arming - hence both the endpoint and the problem check.
        // A low battery cannot be fixed at arming time, so it must not leave the whole home unarmed.
        data.ignoreLowBat = true;
        const response = await this.callRestApi('home/security/setExtendedZonesActivation', data);
        if (response === undefined) {
            outcome.requestFailed = true;
            return outcome;
        }
        // a 200 with no body is an accepted request with no blocker detail, and arming is
        // asynchronous (the home reports activationInProgress), so it cannot be confirmed here
        outcome.confirmed = !!response && typeof response === 'object';
        outcome.problems = this._securityZoneActivationProblems(response as Record<string, unknown>);
        if (outcome.confirmed && !Object.keys(outcome.problems ?? {}).length) {
            const lowBattery = this._lowBatteryDevicesInZones(zonesActivation);
            outcome.lowBatteryDevices = lowBattery.devices;
            outcome.lowBatteryLookupIncomplete = lowBattery.unresolved > 0;
        }
        return outcome;
    }
}
