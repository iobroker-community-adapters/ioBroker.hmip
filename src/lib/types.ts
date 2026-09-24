/**
 * Types for the data this adapter does not own: the channel state table it is configured by,
 * and the shapes the Homematic IP cloud answers with.
 */

/** the ioBroker types a channel state can be declared as */
export type ChannelStateType = 'boolean' | 'number' | 'string';

/** the value transforms channelStateValues knows, see DERIVERS */
export type DeriverName = 'windowOpen' | 'percent' | 'millimetres';

/**
 * One ioBroker state derived from a functional channel.
 *
 * `type` and `role` are the ioBroker object basics; a state is read-only unless it says
 * otherwise. A writable state carries `parameter`, which is what _doStateChange dispatches on.
 */
export interface ChannelStateSpec {
    type: ChannelStateType;
    role: string;
    unit?: string;
    min?: number;
    max?: number;
    def?: number;
    /** value -> label, for a state that reads as an enumeration */
    states?: Record<string, string>;
    read?: boolean;
    write?: boolean;
    /** what _doStateChange dispatches on; without it the state is never written to the cloud */
    parameter?: string;
    /** rounding step of a writable value */
    step?: number;
    /** milliseconds a write is held back, so a slider does not send every intermediate value */
    debounce?: number;
    /** the write goes to the heating groups the channel belongs to, not to the device */
    targetGroups?: boolean;
    /** the cloud never reports this one back, so no value is ever read off the channel */
    writeOnly?: boolean;
    /** transform the raw value through DERIVERS rather than publishing it as it arrives */
    derive?: DeriverName;
    /** a fixed value, published instead of anything the channel carries */
    constant?: boolean | null;
    /**
     * Read by channelStateObjects and channelStateValues but set by no channel today. They are
     * kept because the readers support them, not because anything depends on them.
     */
    name?: string;
    from?: string;
}

/** the state table of one functionalChannelType */
export interface ChannelStatesEntry {
    /** pull in the states of another channel type before this one's */
    extends?: string;
    states: Record<string, ChannelStateSpec>;
}

/** what _stateChange dispatches on, stored in the native part of a state object */
export interface ChannelStateNative {
    /** null clears a parameter a previous version had set, because extendObject merges */
    parameter: string | null;
    id?: string | string[];
    channel?: string | number;
    step?: number;
    debounce?: number;
}

/** one ioBroker object definition derived from a channel */
export interface ChannelStateObject {
    field: string;
    common: ioBroker.StateCommon;
    native: ChannelStateNative;
}

/** one value read off a channel */
export interface ChannelStateValue {
    field: string;
    value: boolean | number | string | null | undefined;
}

/** a functional channel as the cloud delivers it: known keys plus whatever else it carries */
export interface FunctionalChannel {
    functionalChannelType?: string;
    groups?: string[];
    windowState?: string;
    [key: string]: unknown;
}

/* ---------------------------------------------------------------------------------------------
 * What the Homematic IP cloud answers with. Only the keys this adapter reads are named; the rest
 * of a payload is carried through untouched, so every shape stays open.
 * ------------------------------------------------------------------------------------------- */

/** a device with its functional channels, keyed by channel index */
export interface HmIpDevice {
    id: string;
    type?: string;
    label?: string;
    functionalChannels?: Record<string, FunctionalChannel>;
    [key: string]: unknown;
}

/** a group: heating, switching, a security zone, ... */
export interface HmIpGroup {
    id: string;
    type?: string;
    label?: string;
    /** a request-based panel omits this on a disarmed zone */
    active?: boolean;
    channels?: { deviceId?: string; channelIndex?: number }[];
    [key: string]: unknown;
}

export interface HmIpClient {
    id: string;
    label?: string;
    [key: string]: unknown;
}

/**
 * The functional homes a home is divided into: SECURITY_AND_ALARM, INDOOR_CLIMATE,
 * WEATHER_AND_ENVIRONMENT, LIGHT_AND_SHADOW and whatever else a firmware adds. Each one is a
 * flat map the adapter publishes field by field, so its values stay unknown until they are read.
 */
export type HmIpFunctionalHomes = Record<string, Record<string, unknown> | undefined>;

export interface HmIpHome {
    id: string;
    functionalHomes?: HmIpFunctionalHomes;
    weather?: Record<string, unknown>;
    ruleMetaDatas?: Record<string, HmIpRule>;
    [key: string]: unknown;
}

export interface HmIpRule {
    id: string;
    type?: string;
    label?: string;
    [key: string]: unknown;
}

/** a getCurrentState response */
export interface HmIpCurrentState {
    home: HmIpHome;
    groups?: Record<string, HmIpGroup>;
    clients?: Record<string, HmIpClient>;
    devices?: Record<string, HmIpDevice>;
}

/** the credentials the adapter stores in its native config and hands to the api */
export interface HmCloudConfigData {
    authToken: string;
    clientAuthToken: string;
    clientId: string;
    accessPointSgtin: string;
    pin?: string | null;
    deviceId?: string;
}

/** what securityZonesArmedState answers */
export interface SecurityZonesArmedState {
    /** the panel's own kind, even when a mixed home is armed in the classic family */
    requestBased: boolean;
    internal: boolean;
    external: boolean;
    /** the same state the two booleans carry, in the vocabulary of the zone family */
    mode: string;
}

/** what homeSetZonesActivation answers */
export interface ZonesActivationOutcome {
    requestBased: boolean;
    classicZonesPresent: boolean;
    /** the request never reached the cloud */
    requestFailed: boolean;
    /** false when the panel answered 200 with nothing to inspect */
    confirmed: boolean;
    /** what blocked the activation as {device label: [reason]}, null on panels that say nothing */
    problems: Record<string, string[]> | null;
    lowBatteryDevices: string[];
    lowBatteryLookupIncomplete: boolean;
}

/** one entry of a websocket frame; the cloud names the kind and carries the entity that changed */
export interface CloudEvent {
    pushEventType?: string;
    device?: HmIpDevice;
    group?: HmIpGroup;
    client?: HmIpClient;
    home?: HmIpHome;
    id?: string;
    [key: string]: unknown;
}

/** a DEVICE_CHANNEL_EVENT: a button press, a door bell, ... */
export interface ChannelEvent {
    deviceId?: string;
    channelIndex?: number | string;
    functionalChannelIndex?: number | string;
    channelEventType?: string;
    [key: string]: unknown;
}

/** a DEVICE_CODE_STATE_EVENT, raised by the keypads */
export interface CodeStateEvent {
    deviceId?: string;
    codeState?: string;
    codeId?: string;
    [key: string]: unknown;
}

/** one entry of the security journal */
export interface SecurityJournalEntry {
    eventTimestamp?: number;
    eventType?: string;
    label?: string;
    homeId?: string;
    [key: string]: unknown;
}

/** the state object _doStateChange dispatches on: its native names the command to send */
export interface DispatchObject extends ioBroker.BaseObject {
    native: ChannelStateNative & Record<string, unknown>;
}
