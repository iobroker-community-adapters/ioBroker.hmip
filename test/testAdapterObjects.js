'use strict';

const assert = require('node:assert');
const Module = require('node:module');

/**
 * The smallest ioBroker adapter the object builders in main.js need, so they can be exercised
 * without a running js-controller. Objects and states are kept in memory for the assertions.
 */
class AdapterStub {
    constructor(options) {
        this.options = options;
        this.namespace = 'hmip.0';
        this.config = {};
        this.objects = {};
        this.states = {};
        this.logged = { warn: [], error: [], info: [] };
        this.log = {
            silly: () => {},
            debug: () => {},
            info: message => this.logged.info.push(message),
            warn: message => this.logged.warn.push(message),
            error: message => this.logged.error.push(message),
        };
    }

    on() {}

    // ioBroker merges an extendObject into what is already stored, deeply, so neither a stale
    // native nor a key of a states map a later start narrows is ever removed
    extendObject(id, obj) {
        const previous = this.objects[id];
        this.objects[id] = previous
            ? {
                  ...previous,
                  ...obj,
                  common: {
                      ...previous.common,
                      ...obj.common,
                      ...(previous.common && previous.common.states
                          ? { states: { ...previous.common.states, ...(obj.common || {}).states } }
                          : {}),
                  },
                  native: { ...previous.native, ...obj.native },
              }
            : obj;
        return Promise.resolve();
    }

    setStateAsync(id, val, ack) {
        this.states[id] = { val, ack };
        return Promise.resolve();
    }

    setState(id, val, ack) {
        return this.setStateAsync(id, val, ack);
    }

    getStateAsync(id) {
        return Promise.resolve(this.states[id]);
    }

    getObjectAsync(id) {
        return Promise.resolve(this.objects[id]);
    }

    subscribeStates() {}

    supportsFeature() {
        return false;
    }
}

function loadAdapterFactory() {
    const originalLoad = Module._load;
    Module._load = function (request) {
        if (request === '@iobroker/adapter-core') {
            return { Adapter: AdapterStub };
        }
        // eslint-disable-next-line prefer-rest-params
        return originalLoad.apply(this, arguments);
    };
    try {
        delete require.cache[require.resolve('../main.js')];
        return require('../main.js');
    } finally {
        Module._load = originalLoad;
    }
}

const createAdapter = loadAdapterFactory();

/** an adapter whose api records every command instead of sending it */
function createHarness(apiOverrides) {
    assert.strictEqual(typeof createAdapter, 'function', 'main.js must export a factory when it is required');
    const adapter = createAdapter({});
    adapter.calls = [];
    const record =
        name =>
        (...args) => {
            adapter.calls.push({ method: name, args });
            // callRestApi answers with the response body, and undefined when nothing landed
            return Promise.resolve('');
        };
    adapter._api = {
        dispose: () => {},
        home: { id: 'HOME' },
        rules: {},
        groups: {},
        devices: {},
        clients: {},
        homeSetZonesSilentAlarm: record('homeSetZonesSilentAlarm'),
        groupHeatingSetProfileMode: record('groupHeatingSetProfileMode'),
        groupSwitchingLinkedSetOnTime: record('groupSwitchingLinkedSetOnTime'),
        groupSwitchingSetState: record('groupSwitchingSetState'),
        groupSwitchingSetShutterLevel: record('groupSwitchingSetShutterLevel'),
        groupSwitchingSetSlatsLevel: record('groupSwitchingSetSlatsLevel'),
        groupSwitchingStop: record('groupSwitchingStop'),
        homeSetPowerMeterUnitPrice: record('homeSetPowerMeterUnitPrice'),
        homeHeatingActivateVacation: record('homeHeatingActivateVacation'),
        ruleEnableSimpleRule: record('ruleEnableSimpleRule'),
        ruleSetRuleLabel: record('ruleSetRuleLabel'),
        callRestApi: record('callRestApi'),
        homeGetSecurityJournal: () => Promise.resolve({ entries: [] }),
        applyCurrentState: () => {},
        hasRequestBasedSecurityZones: () => false,
        securityZonesArmedState: () => ({ requestBased: false, internal: false, external: false, mode: 'OFF' }),
        homeSetZonesActivation: (...args) => {
            adapter.calls.push({ method: 'homeSetZonesActivation', args });
            return Promise.resolve({
                requestBased: false,
                classicZonesPresent: false,
                requestFailed: false,
                confirmed: true,
                problems: {},
                lowBatteryDevices: [],
                lowBatteryLookupIncomplete: false,
            });
        },
        ...apiOverrides,
    };
    return adapter;
}

/** dispatches a state change the way _stateChange would, but without its timers */
function change(adapter, id, value) {
    return adapter._doStateChange(`${adapter.namespace}.${id}`, adapter.objects[id], { val: value, ack: false });
}

const HOME = {
    id: 'HOME',
    powerMeterCurrency: 'EUR',
    powerMeterUnitPrice: 0.31,
    weather: {},
    functionalHomes: {
        SECURITY_AND_ALARM: {
            functionalGroups: ['G-1'],
            securitySwitchingGroups: ['G-2'],
            alarmActive: true,
            activationInProgress: false,
        },
        INDOOR_CLIMATE: {},
    },
};

describe('rule objects', () => {
    it('offers a switch and a label for a simple rule', async () => {
        const adapter = createHarness();
        await adapter._createObjectsForRule({ id: 'R1', label: 'Night', active: true, type: 'SIMPLE' });

        assert.deepStrictEqual(adapter.objects['rules.R1.active'].common.write, true);
        assert.strictEqual(adapter.objects['rules.R1.active'].common.role, 'switch');
        assert.deepStrictEqual(adapter.objects['rules.R1.active'].native, { id: 'R1', parameter: 'setRuleEnabled' });
        assert.deepStrictEqual(adapter.objects['rules.R1.info.label'].native, { id: 'R1', parameter: 'setRuleLabel' });
    });

    it('leaves a rule the cloud cannot enable read-only', async () => {
        const adapter = createHarness();
        await adapter._createObjectsForRule({ id: 'R2', label: 'Other', active: false, type: 'COMPLEX' });

        assert.strictEqual(adapter.objects['rules.R2.active'].common.write, false);
        assert.strictEqual(adapter.objects['rules.R2.active'].native.parameter, null);
    });

    it('publishes the values of a rule it has created objects for', async () => {
        const adapter = createHarness();
        const rule = { id: 'R1', label: 'Night', active: true, type: 'SIMPLE' };
        await adapter._createObjectsForRule(rule);
        await adapter._updateRuleStates(rule);

        assert.deepStrictEqual(adapter.states['rules.R1.active'], { val: true, ack: true });
        assert.deepStrictEqual(adapter.states['rules.R1.info.label'], { val: 'Night', ack: true });
        assert.deepStrictEqual(adapter.states['rules.R1.info.type'], { val: 'SIMPLE', ack: true });
    });

    it('confirms a written rule value against the cache, because no event will', async () => {
        const adapter = createHarness();
        adapter._api.rules = { R1: { id: 'R1', label: 'Night', active: true, type: 'SIMPLE' } };
        await adapter._createObjectsForRule(adapter._api.rules.R1);

        await change(adapter, 'rules.R1.active', false);
        assert.deepStrictEqual(adapter.calls, [{ method: 'ruleEnableSimpleRule', args: ['R1', false] }]);
        assert.deepStrictEqual(adapter.states['rules.R1.active'], { val: false, ack: true });
        assert.strictEqual(adapter._api.rules.R1.active, false);

        adapter.calls = [];
        await change(adapter, 'rules.R1.info.label', 'Away');
        assert.deepStrictEqual(adapter.calls, [{ method: 'ruleSetRuleLabel', args: ['R1', 'Away'] }]);
        assert.deepStrictEqual(adapter.states['rules.R1.info.label'], { val: 'Away', ack: true });
        assert.strictEqual(adapter._api.rules.R1.label, 'Away');
    });

    it('does not confirm a rule value the cloud never accepted', async () => {
        const adapter = createHarness();
        adapter._api.rules = { R1: { id: 'R1', label: 'Night', active: true, type: 'SIMPLE' } };
        await adapter._createObjectsForRule(adapter._api.rules.R1);
        adapter._api.ruleEnableSimpleRule = () => Promise.resolve(undefined);

        await change(adapter, 'rules.R1.active', false);
        assert.strictEqual(adapter.states['rules.R1.active'], undefined, 'a failed write must not be acked');
        assert.strictEqual(adapter._api.rules.R1.active, true, 'the cache must not claim the change happened');
        assert.match(adapter.logged.error.join(' '), /Could not enable rule R1/);
    });

    it('takes the dispatch away from a rule that stops being simple', async () => {
        const adapter = createHarness();
        await adapter._createObjectsForRule({ id: 'R1', label: 'Night', active: true, type: 'SIMPLE' });
        await adapter._createObjectsForRule({ id: 'R1', label: 'Night', active: true, type: 'COMPLEX' });

        assert.strictEqual(adapter.objects['rules.R1.active'].common.write, false);
        assert.strictEqual(
            adapter.objects['rules.R1.active'].native.parameter,
            null,
            'a merged native must not keep dispatching',
        );
    });

    it('reinitializes rather than writing states for a rule it does not know', async () => {
        const adapter = createHarness();
        let reinitialized = null;
        adapter._reinitializeData = id => (reinitialized = id);
        adapter._updateRuleStates({ id: 'R9' });

        assert.strictEqual(reinitialized, 'Rule R9');
        assert.deepStrictEqual(adapter.states, {});
    });
});

describe('group objects', () => {
    // a captured getCurrentState carries profileMode on HOT_WATER and SHUTTER_PROFILE only, and
    // group/heating/setProfileMode is what those two groups are driven with despite its path
    it('does not invent a profile mode on a heating group', async () => {
        const adapter = createHarness();
        const group = { id: 'G-H', type: 'HEATING', label: 'Living' };
        await adapter._createObjectsForGroup(group);
        await adapter._updateGroupStates(group);

        assert.strictEqual(adapter.objects['groups.G-H.profileMode'], undefined);
        assert.ok(!('groups.G-H.profileMode' in adapter.states));
    });

    for (const type of ['HOT_WATER', 'SHUTTER_PROFILE']) {
        it(`makes the profile mode of a ${type} group writable`, async () => {
            const adapter = createHarness();
            const group = { id: `G-${type}`, type, label: 'Profile', profileMode: 'AUTOMATIC' };
            await adapter._createObjectsForGroup(group);
            await adapter._updateGroupStates(group);

            assert.deepStrictEqual(adapter.objects[`groups.G-${type}.profileMode`].native, {
                id: `G-${type}`,
                parameter: 'setProfileMode',
            });
            assert.deepStrictEqual(adapter.states[`groups.G-${type}.profileMode`], {
                val: 'AUTOMATIC',
                ack: true,
            });

            await change(adapter, `groups.G-${type}.profileMode`, 'MANUAL');
            assert.deepStrictEqual(adapter.calls, [
                { method: 'groupHeatingSetProfileMode', args: [`G-${type}`, 'MANUAL'] },
            ]);
        });
    }

    it('drives a shutter profile with the switching commands the cloud accepts for it', async () => {
        const adapter = createHarness();
        const group = { id: 'G-SP', type: 'SHUTTER_PROFILE', label: 'Blinds', shutterLevel: 0.5, slatsLevel: 0.25 };
        await adapter._createObjectsForGroup(group);
        await adapter._updateGroupStates(group);

        assert.deepStrictEqual(adapter.states['groups.G-SP.shutterLevel'], { val: 0.5, ack: true });
        await change(adapter, 'groups.G-SP.shutterLevel', 0.75);
        assert.deepStrictEqual(adapter.calls, [{ method: 'groupSwitchingSetShutterLevel', args: ['G-SP', 0.75] }]);
    });

    it('publishes what a security zone reports besides its armed state', async () => {
        const adapter = createHarness();
        const group = {
            id: 'G-Z',
            type: 'SECURITY_ZONE',
            label: 'INTERNAL',
            silent: true,
            windowState: 'CLOSED',
            motionDetected: false,
            presenceDetected: null,
            sabotage: false,
        };
        await adapter._createObjectsForGroup(group);
        await adapter._updateGroupStates(group);

        assert.deepStrictEqual(adapter.states['groups.G-Z.silent'], { val: true, ack: true });
        assert.deepStrictEqual(adapter.states['groups.G-Z.windowState'], { val: 'CLOSED', ack: true });
        assert.deepStrictEqual(adapter.states['groups.G-Z.presenceDetected'], { val: null, ack: true });
        assert.strictEqual(adapter.objects['groups.G-Z.silent'].common.write, false);
    });

    it('gives an extended linked switching group a switch and an on time', async () => {
        const adapter = createHarness();
        const group = {
            id: 'G-L',
            type: 'EXTENDED_LINKED_SWITCHING',
            label: 'Stairs',
            on: false,
            onTime: 60,
            onLevel: 1,
            dimLevel: 0.5,
            dutyCycle: false,
            lowBat: false,
        };
        await adapter._createObjectsForGroup(group);
        await adapter._updateGroupStates(group);

        assert.deepStrictEqual(adapter.states['groups.G-L.onTime'], { val: 60, ack: true });
        assert.deepStrictEqual(adapter.states['groups.G-L.on'], { val: false, ack: true });
        assert.strictEqual(adapter.objects['groups.G-L.dimLevel'].common.write, false);

        await change(adapter, 'groups.G-L.onTime', 120);
        await change(adapter, 'groups.G-L.on', true);
        assert.deepStrictEqual(adapter.calls, [
            { method: 'groupSwitchingLinkedSetOnTime', args: ['G-L', 120] },
            { method: 'groupSwitchingSetState', args: ['G-L', true] },
        ]);
    });

    it('gives an extended linked notification group the switching states as well', async () => {
        const adapter = createHarness();
        const group = {
            id: 'G-N',
            type: 'EXTENDED_LINKED_NOTIFICATION',
            label: 'Signal',
            on: true,
            onTime: 5,
            opticalSignalBehaviour: 'BLINKING_BOTH_REPEATING',
            onOpticalSignalBehaviour: 'FLASHING_BOTH_REPEATING',
            simpleRGBColorState: 'RED',
            onSimpleRGBColor: 'GREEN',
        };
        await adapter._createObjectsForGroup(group);
        await adapter._updateGroupStates(group);

        assert.deepStrictEqual(adapter.states['groups.G-N.onTime'], { val: 5, ack: true });
        assert.deepStrictEqual(adapter.states['groups.G-N.opticalSignalBehaviour'], {
            val: 'BLINKING_BOTH_REPEATING',
            ack: true,
        });
        assert.deepStrictEqual(adapter.states['groups.G-N.onSimpleRGBColor'], { val: 'GREEN', ack: true });
        assert.deepStrictEqual(adapter.objects['groups.G-N.onTime'].native, {
            id: 'G-N',
            parameter: 'groupLinkedOnTime',
            debounce: 5000,
        });
    });
});

describe('home objects', () => {
    it('publishes the power meter price and lets it be written', async () => {
        const adapter = createHarness();
        await adapter._createObjectsForHome(HOME);
        await adapter._updateHomeStates(HOME);

        assert.deepStrictEqual(adapter.states['homes.HOME.powerMeterUnitPrice'], { val: 0.31, ack: true });
        assert.deepStrictEqual(adapter.states['homes.HOME.powerMeterCurrency'], { val: 'EUR', ack: true });
        assert.strictEqual(adapter.objects['homes.HOME.powerMeterCurrency'].common.write, false);

        await change(adapter, 'homes.HOME.powerMeterUnitPrice', 0.4);
        assert.deepStrictEqual(adapter.calls, [{ method: 'homeSetPowerMeterUnitPrice', args: [0.4] }]);
    });

    // _parseEventdata does not await the handler, so a throw here becomes an unhandled rejection
    // and Node ends the process
    it('survives a home the cloud sent without functional homes', async () => {
        const adapter = createHarness();
        await adapter._createObjectsForHome({ id: 'HOME', weather: {} });

        await assert.doesNotReject(() => adapter._updateHomeStates({ id: 'HOME' }));
        await assert.doesNotReject(() => adapter._eventRaised({ pushEventType: 'HOME_CHANGED', home: { id: 'HOME' } }));
    });

    it('creates its objects for a home that has no security solution', async () => {
        const adapter = createHarness();

        await assert.doesNotReject(() => adapter._createObjectsForHome({ id: 'BARE' }));
        assert.ok(adapter.objects['homes.BARE.functionalHomes.securityAndAlarm.setSecurityZonesActivationNone']);
    });

    it('offers the same four choices for the silent alarm as for arming', async () => {
        const adapter = createHarness();
        await adapter._createObjectsForHome(HOME);
        const base = 'homes.HOME.functionalHomes.securityAndAlarm';

        for (const suffix of ['None', 'Internal', 'External', 'InternalAndExternal']) {
            const object = adapter.objects[`${base}.setZonesSilentAlarm${suffix}`];
            assert.ok(object, `setZonesSilentAlarm${suffix} is missing`);
            assert.strictEqual(object.common.role, 'button');
            await change(adapter, `${base}.setZonesSilentAlarm${suffix}`, true);
        }

        assert.deepStrictEqual(
            adapter.calls.map(call => call.args),
            [
                [false, false],
                [true, false],
                [false, true],
                [true, true],
            ],
        );
    });

    it('reports a silent alarm request that never reached the cloud', async () => {
        const adapter = createHarness({ homeSetZonesSilentAlarm: () => Promise.resolve(undefined) });
        await adapter._createObjectsForHome(HOME);
        await change(adapter, 'homes.HOME.functionalHomes.securityAndAlarm.setZonesSilentAlarmInternal', true);

        assert.match(adapter.logged.error.join(' '), /Could not set the silent alarm/);
    });

    it('sends the vacation temperature the user set', async () => {
        const adapter = createHarness();
        await adapter._createObjectsForHome(HOME);
        const temperature = 'homes.HOME.functionalHomes.indoorClimate.vacationTemperature';
        assert.strictEqual(adapter.objects[temperature].common.write, true, 'nothing else can fill this state');

        await adapter.setStateAsync(temperature, 14, false);
        await change(
            adapter,
            'homes.HOME.functionalHomes.indoorClimate.activateVacationWithEndTime',
            '2026_09_01 08:00',
        );

        assert.deepStrictEqual(adapter.calls, [
            { method: 'homeHeatingActivateVacation', args: [14, '2026_09_01 08:00'] },
        ]);
    });

    it('refuses to activate vacation mode without a temperature', async () => {
        const adapter = createHarness();
        await adapter._createObjectsForHome(HOME);
        await change(
            adapter,
            'homes.HOME.functionalHomes.indoorClimate.activateVacationWithEndTime',
            '2026_09_01 08:00',
        );

        assert.deepStrictEqual(adapter.calls, []);
        assert.match(adapter.logged.warn.join(' '), /vacationTemperature/);
    });
});

describe('security journal', () => {
    const ENTRIES = [
        { eventTimestamp: 200, eventType: 'ACTIVATION_CHANGED', label: 'Zone' },
        { eventTimestamp: 100, eventType: 'SENSOR_EVENT', label: 'Window' },
    ];
    const base = 'homes.HOME.functionalHomes.securityAndAlarm';

    it('publishes the whole journal and splits out its newest entry', async () => {
        const adapter = createHarness({ homeGetSecurityJournal: () => Promise.resolve({ entries: ENTRIES }) });
        await adapter._updateSecurityJournal();

        assert.deepStrictEqual(adapter.states[`${base}.securityJournal`], {
            val: JSON.stringify(ENTRIES),
            ack: true,
        });
        assert.deepStrictEqual(adapter.states[`${base}.securityJournalEventTimestamp`], { val: 200, ack: true });
        assert.deepStrictEqual(adapter.states[`${base}.securityJournalEventType`], {
            val: 'ACTIVATION_CHANGED',
            ack: true,
        });
        assert.deepStrictEqual(adapter.states[`${base}.securityJournalLabel`], { val: 'Zone', ack: true });
    });

    it('reads the journal on the event that announces it', async () => {
        let reads = 0;
        const adapter = createHarness({
            homeGetSecurityJournal: () => {
                reads++;
                return Promise.resolve({ entries: ENTRIES });
            },
        });
        adapter._api.callRestApi = () => assert.fail('an event carrying the home needs no second read');
        await adapter._eventRaised({ pushEventType: 'SECURITY_JOURNAL_CHANGED', home: HOME });

        assert.strictEqual(reads, 1);
        assert.strictEqual(adapter.states[`${base}.securityJournalEventType`].val, 'ACTIVATION_CHANGED');
        assert.deepStrictEqual(adapter.states['homes.HOME.powerMeterCurrency'], { val: 'EUR', ack: true });
    });

    // the home's alarm fields arrive only with a full read, so an event carrying no home still
    // needs one - but that read answers with every device in the home
    it('reads the home when the event carries none', async () => {
        const adapter = createHarness({ homeGetSecurityJournal: () => Promise.resolve({ entries: ENTRIES }) });
        let reads = 0;
        adapter._api.callRestApi = () => {
            reads++;
            return Promise.resolve({ home: HOME });
        };
        await adapter._eventRaised({ pushEventType: 'SECURITY_JOURNAL_CHANGED' });

        assert.strictEqual(reads, 1);
        assert.deepStrictEqual(adapter.states[`${base}.alarmActive`], { val: true, ack: true });
        assert.deepStrictEqual(adapter.states[`${base}.activationInProgress`], { val: false, ack: true });
        assert.strictEqual(adapter.states[`${base}.securityJournalEventType`].val, 'ACTIVATION_CHANGED');
    });

    it('refreshes the cached configuration from the response it read', async () => {
        const adapter = createHarness({ homeGetSecurityJournal: () => Promise.resolve({ entries: ENTRIES }) });
        const snapshot = { home: HOME, groups: { 'G-9': { id: 'G-9' } }, devices: {}, clients: {} };
        let applied = null;
        adapter._api.applyCurrentState = state => (applied = state);
        adapter._api.callRestApi = () => Promise.resolve(snapshot);
        await adapter._eventRaised({ pushEventType: 'SECURITY_JOURNAL_CHANGED' });

        assert.strictEqual(applied, snapshot, 'the states published from the cache would stay stale otherwise');
    });

    // some panels raise this event every few minutes; without the interval each one would pull
    // every device in the home again
    it('reads the home once per interval, however many events arrive', async () => {
        const adapter = createHarness({ homeGetSecurityJournal: () => Promise.resolve({ entries: ENTRIES }) });
        let reads = 0;
        adapter._api.callRestApi = () => {
            reads++;
            return Promise.resolve({ home: HOME });
        };

        await adapter._eventRaised({ pushEventType: 'SECURITY_JOURNAL_CHANGED' });
        await adapter._eventRaised({ pushEventType: 'SECURITY_JOURNAL_CHANGED' });
        await adapter._eventRaised({ pushEventType: 'SECURITY_JOURNAL_CHANGED' });

        adapter._unload(() => {});
        assert.strictEqual(reads, 1, 'the events inside the interval must not read again');
    });

    // _parseEventdata does not await the handler, so a burst arrives as concurrent callers
    it('reads once for a burst that arrives while the read is in flight', async () => {
        const adapter = createHarness({ homeGetSecurityJournal: () => Promise.resolve({ entries: ENTRIES }) });
        adapter._homeReadInterval = 20;
        let reads = 0;
        adapter._api.callRestApi = () => {
            reads++;
            return new Promise(resolve => setTimeout(() => resolve({ home: HOME }), 30));
        };

        await Promise.all([
            adapter._eventRaised({ pushEventType: 'SECURITY_JOURNAL_CHANGED' }),
            adapter._eventRaised({ pushEventType: 'SECURITY_JOURNAL_CHANGED' }),
            adapter._eventRaised({ pushEventType: 'SECURITY_JOURNAL_CHANGED' }),
        ]);

        assert.strictEqual(reads, 1, 'a second read must not start while one is in flight');
        await new Promise(resolve => setTimeout(resolve, 40));
        adapter._unload(() => {});
        assert.strictEqual(reads, 2, 'the events it absorbed are still worth one read afterwards');
    });

    it('retries soon after a read that answered nothing, rather than waiting out the interval', async () => {
        const adapter = createHarness({ homeGetSecurityJournal: () => Promise.resolve({ entries: ENTRIES }) });
        let reads = 0;
        adapter._api.callRestApi = () => {
            reads++;
            return Promise.resolve(reads === 1 ? undefined : { home: HOME });
        };
        await adapter._eventRaised({ pushEventType: 'SECURITY_JOURNAL_CHANGED' });

        assert.strictEqual(reads, 1);
        assert.ok(
            adapter._nextHomeRead < performance.now() + 60000,
            `a failed read must not reserve the whole interval, it reserved ${adapter._nextHomeRead - performance.now()}ms`,
        );
        assert.ok(adapter._homeReadTimeout, 'the read that published nothing has to be retried');
        adapter._unload(() => {});
    });

    // a timer that came due while the loop was busy is still armed when the next event reads
    it('disarms a deferred read the event it was waiting for has already done', async () => {
        const adapter = createHarness({ homeGetSecurityJournal: () => Promise.resolve({ entries: ENTRIES }) });
        adapter._homeReadInterval = 20;
        let reads = 0;
        adapter._api.callRestApi = () => {
            reads++;
            return Promise.resolve({ home: HOME });
        };

        await adapter._eventRaised({ pushEventType: 'SECURITY_JOURNAL_CHANGED' });
        await adapter._eventRaised({ pushEventType: 'SECURITY_JOURNAL_CHANGED' });
        const busyUntil = performance.now() + 40;
        while (performance.now() < busyUntil) {
            // hold the loop, so the deferred read comes due without being able to run
        }
        await adapter._eventRaised({ pushEventType: 'SECURITY_JOURNAL_CHANGED' });
        assert.strictEqual(reads, 2);

        await new Promise(resolve => setTimeout(resolve, 60));
        adapter._unload(() => {});
        assert.strictEqual(reads, 2, 'the stale timer would read again with no event behind it');
    });

    it('republishes the armed zones when a security zone is removed', async () => {
        let armed = { requestBased: true, internal: true, external: true, mode: 'ABSENCE' };
        const adapter = createHarness({ securityZonesArmedState: () => armed });
        await adapter._createObjectsForHome(HOME);
        await adapter._updateHomeStates(HOME);
        assert.strictEqual(adapter.states[`${base}.securityZonesArmedMode`].val, 'ABSENCE');

        armed = { requestBased: true, internal: false, external: false, mode: 'OFF' };
        await adapter._eventRaised({
            pushEventType: 'GROUP_REMOVED',
            group: { id: 'G-1', type: 'SECURITY_ZONE', label: 'ABSENCE' },
        });

        assert.deepStrictEqual(
            adapter.states[`${base}.securityZonesArmedMode`],
            { val: 'OFF', ack: true },
            'the zone that was armed is gone, so the home cannot still report it armed',
        );
    });

    it('keeps the cache a GROUP_REMOVED emptied while the read was in flight', async () => {
        const adapter = createHarness({ homeGetSecurityJournal: () => Promise.resolve({ entries: ENTRIES }) });
        let applied = 0;
        adapter._api.applyCurrentState = () => applied++;
        adapter._api.callRestApi = () => new Promise(resolve => setTimeout(() => resolve({ home: HOME }), 40));

        const reading = adapter._eventRaised({ pushEventType: 'SECURITY_JOURNAL_CHANGED' });
        await adapter._eventRaised({
            pushEventType: 'GROUP_REMOVED',
            group: { id: 'G-1', type: 'SECURITY_ZONE', label: 'ABSENCE' },
        });
        await reading;

        assert.strictEqual(applied, 0, 'an older snapshot would put the removed group back');
    });

    // the cloud composed the response before the push, so the push is the newer truth
    it('discards a read whose answer a push overtook', async () => {
        const adapter = createHarness({ homeGetSecurityJournal: () => Promise.resolve({ entries: ENTRIES }) });
        let applied = 0;
        adapter._api.applyCurrentState = () => applied++;
        adapter._api.callRestApi = () => new Promise(resolve => setTimeout(() => resolve({ home: HOME }), 40));

        const reading = adapter._eventRaised({ pushEventType: 'SECURITY_JOURNAL_CHANGED' });
        await adapter._eventRaised({
            pushEventType: 'HOME_CHANGED',
            home: { ...HOME, powerMeterCurrency: 'CHF' },
        });
        await reading;

        assert.strictEqual(applied, 0, 'the older snapshot must not roll the caches back');
        assert.deepStrictEqual(
            adapter.states['homes.HOME.powerMeterCurrency'],
            { val: 'CHF', ack: true },
            'the older snapshot must not be republished over the push',
        );
    });

    for (const pushEventType of ['GROUP_ADDED', 'GROUP_CHANGED']) {
        it(`keeps the cache a ${pushEventType} refreshed while the read was in flight`, async () => {
            const adapter = createHarness({ homeGetSecurityJournal: () => Promise.resolve({ entries: ENTRIES }) });
            const group = { id: 'G-7', type: 'SECURITY_ZONE', label: 'ABSENCE', active: true };
            await adapter._createObjectsForGroup(group);
            let applied = 0;
            adapter._api.applyCurrentState = () => applied++;
            adapter._api.callRestApi = () => new Promise(resolve => setTimeout(() => resolve({ home: HOME }), 40));

            const reading = adapter._eventRaised({ pushEventType: 'SECURITY_JOURNAL_CHANGED' });
            await adapter._eventRaised({ pushEventType, group });
            await reading;

            assert.strictEqual(applied, 0, 'the group state the event carried would be rolled back');
            assert.deepStrictEqual(
                adapter.states['homes.HOME.powerMeterCurrency'],
                { val: 'EUR', ack: true },
                'the home fields the read was for still have to be published',
            );
        });
    }

    // a push carries the alarm fields the deferred read was for, and the read is expensive
    it('drops a deferred read once a push has carried the alarm fields', async () => {
        const adapter = createHarness({ homeGetSecurityJournal: () => Promise.resolve({ entries: ENTRIES }) });
        adapter._homeReadInterval = 30;
        let reads = 0;
        adapter._api.callRestApi = () => {
            reads++;
            return Promise.resolve({ home: HOME });
        };

        await adapter._eventRaised({ pushEventType: 'SECURITY_JOURNAL_CHANGED' });
        await adapter._eventRaised({ pushEventType: 'SECURITY_JOURNAL_CHANGED' });
        assert.ok(adapter._homeReadTimeout, 'the second event has to defer a read');
        await adapter._eventRaised({ pushEventType: 'HOME_CHANGED', home: HOME });

        await new Promise(resolve => setTimeout(resolve, 60));
        adapter._unload(() => {});
        assert.strictEqual(reads, 1, 'the push published what the deferred read would have fetched');
    });

    it('keeps the deferred read when the push carries no alarm fields', async () => {
        const adapter = createHarness({ homeGetSecurityJournal: () => Promise.resolve({ entries: ENTRIES }) });
        adapter._homeReadInterval = 30;
        let reads = 0;
        adapter._api.callRestApi = () => {
            reads++;
            return Promise.resolve({ home: HOME });
        };

        await adapter._eventRaised({ pushEventType: 'SECURITY_JOURNAL_CHANGED' });
        await adapter._eventRaised({ pushEventType: 'SECURITY_JOURNAL_CHANGED' });
        await adapter._eventRaised({
            pushEventType: 'HOME_CHANGED',
            home: { ...HOME, functionalHomes: { INDOOR_CLIMATE: {} } },
        });

        await new Promise(resolve => setTimeout(resolve, 60));
        adapter._unload(() => {});
        assert.strictEqual(reads, 2, 'a push without the alarm fields answers nothing');
    });

    it('waits only what is left of the interval before the deferred read', async () => {
        const adapter = createHarness({ homeGetSecurityJournal: () => Promise.resolve({ entries: ENTRIES }) });
        adapter._homeReadInterval = 200;
        let reads = 0;
        adapter._api.callRestApi = () => {
            reads++;
            return Promise.resolve({ home: HOME });
        };

        await adapter._eventRaised({ pushEventType: 'SECURITY_JOURNAL_CHANGED' });
        await new Promise(resolve => setTimeout(resolve, 150));
        await adapter._eventRaised({ pushEventType: 'SECURITY_JOURNAL_CHANGED' });
        assert.strictEqual(reads, 1);

        await new Promise(resolve => setTimeout(resolve, 100));
        adapter._unload(() => {});
        assert.strictEqual(reads, 2, 'the deferred read has to land at the end of the interval, not one later');
    });

    it('defers the read of an event inside the interval instead of dropping it', async () => {
        const adapter = createHarness({ homeGetSecurityJournal: () => Promise.resolve({ entries: ENTRIES }) });
        adapter._homeReadInterval = 20;
        let reads = 0;
        adapter._api.callRestApi = () => {
            reads++;
            return Promise.resolve({ home: HOME });
        };

        await adapter._eventRaised({ pushEventType: 'SECURITY_JOURNAL_CHANGED' });
        await adapter._eventRaised({ pushEventType: 'SECURITY_JOURNAL_CHANGED' });
        assert.strictEqual(reads, 1);

        await new Promise(resolve => setTimeout(resolve, 60));
        assert.strictEqual(reads, 2, 'the deferred read has to happen once the interval is over');
    });

    it('leaves no deferred read behind when the adapter unloads', async () => {
        const adapter = createHarness({ homeGetSecurityJournal: () => Promise.resolve({ entries: ENTRIES }) });
        adapter._homeReadInterval = 20;
        let reads = 0;
        adapter._api.callRestApi = () => {
            reads++;
            return Promise.resolve({ home: HOME });
        };

        await adapter._eventRaised({ pushEventType: 'SECURITY_JOURNAL_CHANGED' });
        await adapter._eventRaised({ pushEventType: 'SECURITY_JOURNAL_CHANGED' });
        await adapter._eventRaised({ pushEventType: 'SECURITY_JOURNAL_CHANGED' });
        await adapter._eventRaised({ pushEventType: 'SECURITY_JOURNAL_CHANGED' });
        adapter._unload(() => {});

        await new Promise(resolve => setTimeout(resolve, 60));
        assert.strictEqual(reads, 1, 'a timer that outlives the adapter would read against a disposed api');
    });

    // _parseEventdata does not await the handler, so a burst arrives as concurrent callers
    it('collapses a burst of journal events into two reads, not one per event', async () => {
        let reads = 0;
        let release;
        const gate = new Promise(resolve => (release = resolve));
        const adapter = createHarness({
            homeGetSecurityJournal: () => {
                reads++;
                return reads === 1 ? gate.then(() => ({ entries: ENTRIES })) : Promise.resolve({ entries: ENTRIES });
            },
        });

        const inFlight = [
            adapter._updateSecurityJournal(),
            adapter._updateSecurityJournal(),
            adapter._updateSecurityJournal(),
            adapter._updateSecurityJournal(),
        ];
        release();
        await Promise.all(inFlight);

        assert.strictEqual(reads, 2, 'the read in flight absorbs the rest and repeats once');
    });

    it('picks the newest entry by timestamp, whatever order the cloud used', async () => {
        const oldestFirst = [...ENTRIES].reverse();
        const adapter = createHarness({ homeGetSecurityJournal: () => Promise.resolve({ entries: oldestFirst }) });
        await adapter._updateSecurityJournal();

        assert.deepStrictEqual(adapter.states[`${base}.securityJournalEventTimestamp`], { val: 200, ack: true });
        assert.strictEqual(adapter.states[`${base}.securityJournalEventType`].val, 'ACTIVATION_CHANGED');
    });

    it('writes nothing once the adapter is unloading', async () => {
        const adapter = createHarness({
            homeGetSecurityJournal: () => {
                adapter._unloaded = true;
                return Promise.resolve({ entries: ENTRIES });
            },
        });
        await adapter._updateSecurityJournal();

        assert.deepStrictEqual(adapter.states, {});
    });

    it('keeps the last journal when a read fails or comes back empty', async () => {
        const adapter = createHarness({ homeGetSecurityJournal: () => Promise.resolve({ entries: ENTRIES }) });
        await adapter._updateSecurityJournal();
        adapter._api.homeGetSecurityJournal = () => Promise.resolve(undefined);
        await adapter._updateSecurityJournal();

        assert.strictEqual(adapter.states[`${base}.securityJournalEventType`].val, 'ACTIVATION_CHANGED');
    });

    it('reports an empty journal as such rather than as a stale entry', async () => {
        const adapter = createHarness({ homeGetSecurityJournal: () => Promise.resolve({ entries: [] }) });
        await adapter._updateSecurityJournal();

        assert.deepStrictEqual(adapter.states[`${base}.securityJournal`], { val: '[]', ack: true });
        assert.deepStrictEqual(adapter.states[`${base}.securityJournalEventType`], { val: null, ack: true });
    });

    it('does nothing before a home is known', async () => {
        const adapter = createHarness();
        adapter._api.home = undefined;
        adapter._api.homeGetSecurityJournal = () => assert.fail('there is no home to publish a journal for');
        await adapter._updateSecurityJournal();

        assert.deepStrictEqual(adapter.states, {});
    });
});

describe('adapter housekeeping', () => {
    it('keys a value it caches once, whether or not the id came namespaced', async () => {
        const adapter = createHarness();
        await adapter.secureSetStateAsync('groups.G.on', true, true);
        await adapter.secureSetStateAsync(`${adapter.namespace}.groups.G.off`, false, true);

        assert.deepStrictEqual(Object.keys(adapter.currentValues).sort(), [
            'hmip.0.groups.G.off',
            'hmip.0.groups.G.on',
        ]);
    });

    it('does not let a debounced write outlive the adapter', () => {
        const adapter = createHarness();
        let cleared = false;
        adapter.delayTimeouts = { 'hmip.0.groups.G.onTime': { timeout: setTimeout(() => (cleared = 'fired'), 50) } };
        adapter._unload(() => {});

        assert.deepStrictEqual(adapter.delayTimeouts, {});
        assert.strictEqual(cleared, false);
    });
});

describe('cleanups that prevent a silent failure', () => {
    // an older version of the adapter shipped these datapoints writable, and extendObject merges,
    // so the stored native still dispatches unless the table clears it
    it('clears the parameter an older version left on a datapoint that is now read-only', () => {
        const { CHANNEL_STATES, channelStateObjects } = require('../lib/channelStates');
        const [built] = channelStateObjects(
            { dim2WarmActive: CHANNEL_STATES.UNIVERSAL_LIGHT_CHANNEL.states.dim2WarmActive },
            'DEV',
            1,
            {},
        );
        assert.strictEqual(built.common.write, false);
        assert.strictEqual(built.native.parameter, null, 'a merged native must not keep dispatching');
    });

    it('sends an empty pin rather than crashing when the pin state is null', async () => {
        const adapter = createHarness();
        adapter._api.deviceControlSetLockState = (...args) => {
            adapter.calls.push({ method: 'deviceControlSetLockState', args });
            return Promise.resolve('');
        };
        await adapter.setStateAsync('devices.DEV.channels.1.pin', null, false);
        adapter.objects.lock = {
            type: 'state',
            common: {},
            native: { id: 'DEV', channel: 1, parameter: 'setLockState' },
        };
        await adapter._doStateChange(`${adapter.namespace}.lock`, adapter.objects.lock, { val: 2, ack: false });

        assert.deepStrictEqual(adapter.calls, [
            { method: 'deviceControlSetLockState', args: ['DEV', 'LOCKED', null, 1] },
        ]);
    });

    it('says so when a group command has no group to act on', async () => {
        const adapter = createHarness();
        adapter._api.groupHeatingSetPointTemperature = (...args) => {
            adapter.calls.push({ method: 'groupHeatingSetPointTemperature', args });
            return Promise.resolve('');
        };
        adapter.objects.sp = { type: 'state', common: {}, native: { id: [], parameter: 'setPointTemperature' } };
        await adapter._doStateChange(`${adapter.namespace}.sp`, adapter.objects.sp, { val: 21, ack: false });

        assert.deepStrictEqual(adapter.calls, [], 'there is nothing to send the command to');
        assert.match(adapter.logged.warn.join(' '), /no group to act on/);
    });

    it('does not throw when a group command finds no list at all', async () => {
        const adapter = createHarness();
        adapter.objects.sp = { type: 'state', common: {}, native: { parameter: 'setPointTemperature' } };

        await adapter._doStateChange(`${adapter.namespace}.sp`, adapter.objects.sp, { val: 21, ack: false });
        assert.match(adapter.logged.warn.join(' '), /no group to act on/);
    });

    it('leaves the whole-home cooling switch readable, so it reads as a switch', async () => {
        const adapter = createHarness();
        await adapter._createObjectsForHome(HOME);
        const cooling = adapter.objects['homes.HOME.functionalHomes.indoorClimate.setCooling'];

        assert.strictEqual(cooling.common.role, 'switch');
        assert.strictEqual(cooling.common.read, true);
        assert.strictEqual(cooling.common.write, true);
    });
});

describe('reporting an alarm activation', () => {
    function alarmHarness(outcome) {
        const adapter = createHarness();
        adapter._api.homeSetZonesActivation = () => Promise.resolve(outcome);
        return adapter;
    }

    const BASE = {
        requestBased: true,
        classicZonesPresent: false,
        requestFailed: false,
        confirmed: true,
        problems: {},
        lowBatteryDevices: [],
        lowBatteryLookupIncomplete: false,
    };

    it('says the activation is unconfirmed when the panel reported no detail', async () => {
        const adapter = alarmHarness({ ...BASE, confirmed: false });
        await adapter._setSecurityZonesActivation(true, true);

        assert.match(adapter.logged.info.join(' '), /not confirmed/);
    });

    it('says nothing about confirmation when the panel did describe the activation', async () => {
        const adapter = alarmHarness({ ...BASE });
        await adapter._setSecurityZonesActivation(true, true);

        assert.doesNotMatch(adapter.logged.info.join(' '), /not confirmed/);
    });

    it('reports a request that never reached the cloud as an error, not as unconfirmed', async () => {
        const adapter = alarmHarness({ ...BASE, requestFailed: true, problems: null });
        await adapter._setSecurityZonesActivation(true, true);

        assert.match(adapter.logged.error.join(' '), /it is unchanged/);
        assert.doesNotMatch(adapter.logged.info.join(' '), /not confirmed/);
    });

    it('names what blocked the activation', async () => {
        const adapter = alarmHarness({ ...BASE, problems: { 'Front door': ['WINDOW_OPEN'] } });
        await adapter._setSecurityZonesActivation(true, true);

        assert.match(adapter.logged.warn.join(' '), /blocked by Front door: WINDOW_OPEN/);
    });
});

describe('the security zones on the home', () => {
    const BASE = 'homes.HOME.functionalHomes.securityAndAlarm';

    it('publishes the armed zones where a user looks for them, not only on the zone group', async () => {
        const adapter = createHarness({
            securityZonesArmedState: () => ({ requestBased: true, internal: true, external: true, mode: 'ABSENCE' }),
        });
        await adapter._createObjectsForHome(HOME);
        await adapter._updateHomeStates(HOME);

        assert.deepStrictEqual(adapter.states[`${BASE}.securityZonesArmedMode`], { val: 'ABSENCE', ack: true });
        assert.deepStrictEqual(adapter.states[`${BASE}.internalZoneArmed`], { val: true, ack: true });
        assert.deepStrictEqual(adapter.states[`${BASE}.externalZoneArmed`], { val: true, ack: true });
    });

    it('refreshes them from a zone group event, which is what a panel sends when it arms', async () => {
        const adapter = createHarness({
            securityZonesArmedState: () => ({ requestBased: true, internal: false, external: true, mode: 'PRESENCE' }),
        });
        const group = { id: 'G-1', type: 'SECURITY_ZONE', label: 'PRESENCE', active: true };
        await adapter._createObjectsForGroup(group);
        await adapter._updateGroupStates(group);

        assert.deepStrictEqual(adapter.states[`${BASE}.securityZonesArmedMode`], { val: 'PRESENCE', ack: true });
        assert.deepStrictEqual(adapter.states[`${BASE}.externalZoneArmed`], { val: true, ack: true });
    });

    const ALL_MODES = ['OFF', 'PRESENCE', 'ABSENCE', 'INTERNAL', 'EXTERNAL', 'INTERNAL_AND_EXTERNAL'];

    it('offers every mode it can dispatch, and nothing else', async () => {
        const adapter = createHarness();
        await adapter._createObjectsForHome(HOME);

        const control = adapter.objects[`${BASE}.activateSecurityZones`];
        assert.deepStrictEqual(Object.keys(control.common.states), ALL_MODES);
        assert.strictEqual(control.common.write, true);
        assert.strictEqual(control.common.read, false, 'the armed mode is read on securityZonesArmedMode');
    });

    // extendObject merges, so a mode list narrowed for the panel of the day could never lose the
    // keys of the wider one again - a home migrated to the request-based dashboard would keep
    // offering INTERNAL for good
    it('offers the same modes whichever dashboard the home has today', async () => {
        const adapter = createHarness({ hasRequestBasedSecurityZones: () => false });
        await adapter._createObjectsForHome(HOME);
        adapter._api.hasRequestBasedSecurityZones = () => true;
        await adapter._createObjectsForHome(HOME);

        assert.deepStrictEqual(Object.keys(adapter.objects[`${BASE}.activateSecurityZones`].common.states), ALL_MODES);
        assert.deepStrictEqual(Object.keys(adapter.objects[`${BASE}.securityZonesArmedMode`].common.states), ALL_MODES);
    });

    for (const [mode, args] of [
        ['OFF', [false, false]],
        ['PRESENCE', [false, true]],
        ['ABSENCE', [true, true]],
        ['INTERNAL', [true, false]],
        ['EXTERNAL', [false, true]],
        ['INTERNAL_AND_EXTERNAL', [true, true]],
    ]) {
        it(`arms ${mode} as internal=${args[0]}, external=${args[1]}`, async () => {
            const adapter = createHarness();
            await adapter._createObjectsForHome(HOME);
            await change(adapter, `${BASE}.activateSecurityZones`, mode);

            assert.deepStrictEqual(adapter.calls, [{ method: 'homeSetZonesActivation', args }]);
        });
    }

    it('sends nothing for a mode the panel does not have', async () => {
        const adapter = createHarness();
        await adapter._createObjectsForHome(HOME);
        await change(adapter, `${BASE}.activateSecurityZones`, 'ARMED');

        assert.deepStrictEqual(adapter.calls, []);
        assert.match(adapter.logged.info.join(' '), /Ignore invalid value for activateSecurityZones/);
    });

    it('takes a mode a script wrote in lower case', async () => {
        const adapter = createHarness();
        await adapter._createObjectsForHome(HOME);
        await change(adapter, `${BASE}.activateSecurityZones`, ' absence ');

        assert.deepStrictEqual(adapter.calls, [{ method: 'homeSetZonesActivation', args: [true, true] }]);
    });

    it('publishes nothing for a zone group while no home is known', async () => {
        const adapter = createHarness({
            securityZonesArmedState: () => ({ requestBased: true, internal: true, external: true, mode: 'ABSENCE' }),
        });
        const group = { id: 'G-1', type: 'SECURITY_ZONE', label: 'ABSENCE', active: true };
        await adapter._createObjectsForGroup(group);
        adapter._api.home = undefined;
        await adapter._updateGroupStates(group);

        assert.strictEqual(adapter.states[`${BASE}.securityZonesArmedMode`], undefined);
        assert.deepStrictEqual(adapter.states['groups.G-1.active'], { val: true, ack: true });
    });

    it('sends nothing for a value that only inherits from Object.prototype', async () => {
        const adapter = createHarness();
        await adapter._createObjectsForHome(HOME);
        await change(adapter, `${BASE}.activateSecurityZones`, 'constructor');

        assert.deepStrictEqual(adapter.calls, []);
    });
});

describe('the device that raised an alarm', () => {
    // the cloud sends only alarmEventDeviceChannel, an object; there is no alarmEventDeviceId
    // beside it, and writing the object to a string state silently produced null
    const HOME_WITH_ALARM = {
        id: 'HOME',
        weather: {},
        functionalHomes: {
            SECURITY_AND_ALARM: {
                functionalGroups: [],
                securitySwitchingGroups: [],
                alarmActive: true,
                alarmEventTimestamp: 1524504122047,
                alarmEventDeviceChannel: { channelIndex: 1, deviceId: 'DEV-7' },
                alarmSecurityJournalEntryType: 'SENSOR_EVENT',
            },
            INDOOR_CLIMATE: {},
        },
    };
    const base = 'homes.HOME.functionalHomes.securityAndAlarm';

    it('names the device, its channel and its label', async () => {
        const adapter = createHarness();
        adapter._api.devices = { 'DEV-7': { id: 'DEV-7', label: 'Fenster Büro' } };
        await adapter._createObjectsForHome(HOME_WITH_ALARM);
        await adapter._updateHomeStates(HOME_WITH_ALARM);

        assert.deepStrictEqual(adapter.states[`${base}.alarmEventDeviceId`], { val: 'DEV-7', ack: true });
        assert.deepStrictEqual(adapter.states[`${base}.alarmEventDeviceChannel`], { val: 1, ack: true });
        assert.deepStrictEqual(adapter.states[`${base}.alarmEventDeviceLabel`], { val: 'Fenster Büro', ack: true });
    });

    it('declares the channel as the number the cloud sends', async () => {
        const adapter = createHarness();
        await adapter._createObjectsForHome(HOME_WITH_ALARM);

        assert.strictEqual(adapter.objects[`${base}.alarmEventDeviceChannel`].common.type, 'number');
    });

    it('reports no device when the cloud names none', async () => {
        const adapter = createHarness();
        const quiet = {
            ...HOME_WITH_ALARM,
            functionalHomes: { SECURITY_AND_ALARM: { functionalGroups: [], securitySwitchingGroups: [] } },
        };
        await adapter._createObjectsForHome(quiet);
        await adapter._updateHomeStates(quiet);

        assert.deepStrictEqual(adapter.states[`${base}.alarmEventDeviceId`], { val: null, ack: true });
        assert.deepStrictEqual(adapter.states[`${base}.alarmEventDeviceLabel`], { val: null, ack: true });
    });

    it('still names the device when the adapter does not know its label', async () => {
        const adapter = createHarness();
        adapter._api.devices = {};
        await adapter._createObjectsForHome(HOME_WITH_ALARM);
        await adapter._updateHomeStates(HOME_WITH_ALARM);

        assert.deepStrictEqual(adapter.states[`${base}.alarmEventDeviceId`], { val: 'DEV-7', ack: true });
        assert.deepStrictEqual(adapter.states[`${base}.alarmEventDeviceLabel`], { val: null, ack: true });
    });
});

describe('rain counters', () => {
    const { CHANNEL_STATES, channelStateObjects, channelStateValues } = require('../lib/channelStates');

    // the cloud accumulates the counter in floating point and hands the drift over with it
    it('publishes the millimetres the sensor measured, not the accumulated drift', () => {
        const spec = { todayRainCounter: CHANNEL_STATES.WEATHER_SENSOR_PRO_CHANNEL.states.todayRainCounter };
        for (const [raw, expected] of [
            [0.3000000000001819, 0.3],
            [0.6000000000003638, 0.6],
            [12.34, 12.34],
            [0, 0],
        ]) {
            assert.strictEqual(channelStateValues(spec, { todayRainCounter: raw })[0].value, expected);
        }
    });

    it('leaves a counter the sensor has not reported alone', () => {
        const spec = { todayRainCounter: CHANNEL_STATES.WEATHER_SENSOR_PRO_CHANNEL.states.todayRainCounter };
        assert.strictEqual(channelStateValues(spec, {})[0].value, undefined);
        assert.strictEqual(channelStateValues(spec, { todayRainCounter: null })[0].value, null);
    });

    it('rounds and labels every rain counter the table carries', () => {
        let checked = 0;
        for (const [channelType, entry] of Object.entries(CHANNEL_STATES)) {
            for (const [field, spec] of Object.entries(entry.states)) {
                if (!/RainCounter/.test(field)) {
                    continue;
                }
                checked++;
                assert.strictEqual(spec.derive, 'millimetres', `${channelType}.${field} is not rounded`);
                assert.strictEqual(spec.unit, 'mm', `${channelType}.${field} carries no unit`);
                const [built] = channelStateObjects({ [field]: spec }, 'DEV', 1, {});
                assert.strictEqual(built.common.unit, 'mm');
            }
        }
        assert.ok(checked >= 9, `only found ${checked} rain counters`);
    });
});

describe('level scaling', () => {
    // the cloud works in 0..1 and ioBroker in 0..100, and the older channels declare 0..100 while
    // the newer ones declare 0..1, so a written value above 1 can only ever be a percentage
    it('converts a percentage to the fraction the cloud takes', () => {
        const adapter = createHarness();
        assert.strictEqual(adapter._levelFraction(50), 0.5);
        assert.strictEqual(adapter._levelFraction(100), 1);
        assert.strictEqual(adapter._levelFraction(0), 0);
    });

    it('leaves a value that is already a fraction alone', () => {
        const adapter = createHarness();
        assert.strictEqual(adapter._levelFraction(0.5), 0.5);
        assert.strictEqual(adapter._levelFraction(1), 1, '1 is taken as fully on, not as one percent');
    });

    it('passes a missing level through rather than turning it into zero', () => {
        const adapter = createHarness();
        assert.strictEqual(adapter._levelFraction(null), null);
        assert.strictEqual(adapter._levelFraction(undefined), undefined);
    });

    it('publishes a 0..100 channel on the scale it declares', () => {
        const { CHANNEL_STATES, channelStateObjects, channelStateValues } = require('../lib/channelStates');
        for (const [channelType, field] of [
            ['SHUTTER_CHANNEL', 'shutterLevel'],
            ['DIMMER_CHANNEL', 'dimLevel'],
            ['SHADING_CHANNEL', 'primaryShadingLevel'],
        ]) {
            const states = CHANNEL_STATES[channelType].states;
            const [object] = channelStateObjects({ [field]: states[field] }, 'DEV', 1, {});
            const [value] = channelStateValues({ [field]: states[field] }, { [field]: 0.5 });
            assert.strictEqual(object.common.max, 100, `${channelType}.${field} declares a percentage`);
            assert.strictEqual(value.value, 50, `${channelType}.${field} must publish that percentage`);
        }
    });

    it('does not publish a percentage for a channel that has no level yet', () => {
        const { CHANNEL_STATES, channelStateValues } = require('../lib/channelStates');
        const states = CHANNEL_STATES.SHUTTER_CHANNEL.states;
        const spec = { shutterLevel: states.shutterLevel };

        assert.strictEqual(channelStateValues(spec, {})[0].value, undefined);
        assert.strictEqual(channelStateValues(spec, { shutterLevel: null })[0].value, null);
    });
});

describe('level write paths', () => {
    const CHANNEL = { id: 'DEV', channel: 1 };

    /** an object whose native points at the probe channel */
    function writable(parameter) {
        return { type: 'state', common: {}, native: { ...CHANNEL, parameter } };
    }

    async function send(adapter, parameter, value, states = {}) {
        for (const [field, val] of Object.entries(states)) {
            await adapter.setStateAsync(`devices.DEV.channels.1.${field}`, val, true);
        }
        adapter.objects['probe'] = writable(parameter);
        await adapter._doStateChange(`${adapter.namespace}.probe`, adapter.objects['probe'], {
            val: value,
            ack: false,
        });
        return adapter.calls;
    }

    function levelHarness() {
        const adapter = createHarness();
        const record =
            name =>
            (...args) => {
                adapter.calls.push({ method: name, args });
                return Promise.resolve('');
            };
        for (const method of [
            'deviceControlSetShutterLevel',
            'deviceControlSetSlatsLevel',
            'deviceControlSetPrimaryShadingLevel',
            'deviceControlSetSecondaryShadingLevel',
            'deviceConfigurationSetMinimumFloorHeatingValvePosition',
            'deviceControlSetDimLevel',
            'deviceControlSetDimLevelWithTime',
            'deviceControlStartLightScene',
            'deviceControlSetHueSaturationDimLevel',
            'deviceControlSetColorTemperatureDimLevel',
        ]) {
            adapter._api[method] = record(method);
        }
        return adapter;
    }

    it('sends a fraction for every command that carries a level', async () => {
        for (const [parameter, expected, states] of [
            ['shutterlevel', ['DEV', 0.5, 1], {}],
            ['setPrimaryShadingLevel', ['DEV', 0.5, 1], {}],
            ['setMinimumFloorHeatingValvePosition', ['DEV', 0.5, 1], {}],
            ['setDimLevel', ['DEV', 0.5, 1], {}],
        ]) {
            const adapter = levelHarness();
            const calls = await send(adapter, parameter, 50, states);
            assert.strictEqual(calls.length, 1, `${parameter} sent nothing`);
            assert.deepStrictEqual(calls[0].args, expected, `${parameter} sent the wrong level`);
        }
    });

    it('scales the levels a compound command reads back off the channel', async () => {
        const adapter = levelHarness();
        const calls = await send(adapter, 'slatsLevel', 50, { slatsLevel: 25, shutterLevel: 75 });

        assert.deepStrictEqual(calls, [{ method: 'deviceControlSetSlatsLevel', args: ['DEV', 0.25, 0.75, 1] }]);
    });

    it('scales the level the light commands read rather than passing a percentage through', async () => {
        for (const [parameter, method, index] of [
            ['startLightScene', 'deviceControlStartLightScene', 2],
            ['setHueSaturationDimLevel', 'deviceControlSetHueSaturationDimLevel', 3],
            ['setColorTemperatureDimLevel', 'deviceControlSetColorTemperatureDimLevel', 2],
        ]) {
            const adapter = levelHarness();
            const calls = await send(adapter, parameter, true, { dimLevel: 40 });
            assert.strictEqual(calls.length, 1, `${parameter} sent nothing`);
            assert.strictEqual(calls[0].method, method);
            assert.strictEqual(calls[0].args[index], 0.4, `${parameter} must send a fraction`);
        }
    });

    // the guard compares against what was published, which is now the percentage
    it('suppresses a write of the value the channel already reports', async () => {
        const adapter = levelHarness();
        adapter.currentValues[`${adapter.namespace}.probe`] = 50;
        const calls = await send(adapter, 'shutterlevel', 50);

        assert.deepStrictEqual(calls, [], 'an unchanged percentage must not reach the cloud');
    });

    // setting a control time and re-writing the level the lamp already has is how "on for 30s"
    // is expressed, so the unchanged guard must not swallow it
    it('still sends a timed command when the level is unchanged', async () => {
        const adapter = levelHarness();
        adapter.currentValues[`${adapter.namespace}.probe`] = 50;
        const calls = await send(adapter, 'setDimLevel', 50, { controlOnTime: 30, controlRampTime: 0 });

        assert.deepStrictEqual(calls, [{ method: 'deviceControlSetDimLevelWithTime', args: ['DEV', 0.5, 30, 0, 1] }]);
    });
});

describe('channel and code state events', () => {
    const { CHANNEL_EVENTS, CODE_STATES } = require('../lib/channelStates');

    function buttonDevice() {
        return {
            id: 'DEV',
            label: 'Button',
            type: 'PUSH_BUTTON',
            functionalChannels: {
                0: { functionalChannelType: 'DEVICE_BASE' },
                1: { functionalChannelType: 'SINGLE_KEY_CHANNEL' },
            },
        };
    }

    it('creates a datapoint per event a button can raise, before the first press', async () => {
        const adapter = createHarness();
        await adapter._createObjectsForDevice(buttonDevice());

        for (const event of CHANNEL_EVENTS) {
            const object = adapter.objects[`devices.DEV.channels.1.events.${event}`];
            assert.ok(object, `${event} has no datapoint`);
            assert.strictEqual(object.common.role, 'indicator');
            assert.strictEqual(object.common.write, false);
        }
        assert.strictEqual(
            adapter.objects['devices.DEV.channels.0.events.KEY_PRESS_SHORT'],
            undefined,
            'a channel that raises no event needs no datapoint',
        );
    });

    it('creates the code state datapoints on a device that takes a code', async () => {
        const adapter = createHarness();
        await adapter._createObjectsForDevice({
            id: 'WKP',
            label: 'Keypad',
            type: 'WALL_MOUNTED_PIN_PAD',
            functionalChannels: { 0: { functionalChannelType: 'DEVICE_BLOCKING_WITH_TEACHABLE_CODE' } },
        });

        for (const codeState of CODE_STATES) {
            assert.ok(adapter.objects[`devices.WKP.events.${codeState}`], `${codeState} has no datapoint`);
        }
    });

    it('raises the event the cloud reports', async () => {
        const adapter = createHarness();
        await adapter._createObjectsForDevice(buttonDevice());
        await adapter._eventRaised({
            pushEventType: 'DEVICE_CHANNEL_EVENT',
            deviceId: 'DEV',
            channelIndex: 1,
            channelEventType: 'KEY_PRESS_SHORT',
        });

        assert.deepStrictEqual(adapter.states['devices.DEV.channels.1.events.KEY_PRESS_SHORT'], {
            val: true,
            ack: true,
        });
    });

    // the datapoint is never reset, so a second press has to be a second write for a script to
    // see it at all
    it('writes again on a repeated event rather than resetting in between', async () => {
        const adapter = createHarness();
        await adapter._createObjectsForDevice(buttonDevice());
        const writes = [];
        const inner = adapter.setStateAsync.bind(adapter);
        adapter.setStateAsync = (id, val, ack) => {
            writes.push({ id, val });
            return inner(id, val, ack);
        };

        const press = {
            pushEventType: 'DEVICE_CHANNEL_EVENT',
            deviceId: 'DEV',
            channelIndex: 1,
            channelEventType: 'DOOR_BELL_SENSOR_EVENT',
        };
        await adapter._eventRaised(press);
        await adapter._eventRaised(press);

        assert.deepStrictEqual(writes, [
            { id: 'devices.DEV.channels.1.events.DOOR_BELL_SENSOR_EVENT', val: true },
            { id: 'devices.DEV.channels.1.events.DOOR_BELL_SENSOR_EVENT', val: true },
        ]);
    });

    // the cloud raises a channel event on any functional channel, so an event for a channel type
    // that was not expected to raise one still has to arrive somewhere
    it('creates a datapoint for an event on a channel it did not expect one from', async () => {
        const adapter = createHarness();
        await adapter._eventRaised({
            pushEventType: 'DEVICE_CHANNEL_EVENT',
            deviceId: 'OTHER',
            channelIndex: 4,
            channelEventType: 'KEY_PRESS_LONG_START',
        });

        assert.ok(adapter.objects['devices.OTHER.channels.4.events.KEY_PRESS_LONG_START']);
        assert.deepStrictEqual(adapter.states['devices.OTHER.channels.4.events.KEY_PRESS_LONG_START'], {
            val: true,
            ack: true,
        });
    });

    it('falls back to functionalChannelIndex when the event names no channelIndex', async () => {
        const adapter = createHarness();
        await adapter._eventRaised({
            pushEventType: 'DEVICE_CHANNEL_EVENT',
            deviceId: 'DEV',
            functionalChannelIndex: 2,
            channelEventType: 'KEY_PRESS_SHORT',
        });

        assert.ok(adapter.states['devices.DEV.channels.2.events.KEY_PRESS_SHORT']);
    });

    it('publishes the code index before the code state that a script reacts to', async () => {
        const adapter = createHarness();
        const order = [];
        const inner = adapter.setStateAsync.bind(adapter);
        adapter.setStateAsync = (id, val, ack) => {
            order.push(id);
            return inner(id, val, ack);
        };
        await adapter._eventRaised({
            pushEventType: 'DEVICE_CODE_STATE_EVENT',
            deviceId: 'WKP',
            codeIndex: 3,
            codeState: 'KNOWN_CODE_ID_RECEIVED',
        });

        assert.deepStrictEqual(order, ['devices.WKP.events.codeIndex', 'devices.WKP.events.KNOWN_CODE_ID_RECEIVED']);
        assert.deepStrictEqual(adapter.states['devices.WKP.events.codeIndex'], { val: 3, ack: true });
        assert.deepStrictEqual(adapter.states['devices.WKP.events.KNOWN_CODE_ID_RECEIVED'], { val: true, ack: true });
    });

    it('publishes a code state that arrives without an index', async () => {
        const adapter = createHarness();
        await adapter._eventRaised({
            pushEventType: 'DEVICE_CODE_STATE_EVENT',
            deviceId: 'WKP',
            codeState: 'UNKNOWN_CODE_DETECTED',
        });

        assert.deepStrictEqual(adapter.states['devices.WKP.events.UNKNOWN_CODE_DETECTED'], { val: true, ack: true });
        assert.strictEqual(adapter.states['devices.WKP.events.codeIndex'], undefined);
    });

    // an event name reaches an object id, so anything that is not one of the cloud's own
    // identifiers must not create one
    it('refuses an event whose name could not be a cloud identifier', async () => {
        const adapter = createHarness();
        for (const channelEventType of ['../../escape', 'lower_case', '', null, undefined, 42, 'A B']) {
            await adapter._eventRaised({
                pushEventType: 'DEVICE_CHANNEL_EVENT',
                deviceId: 'DEV',
                channelIndex: 1,
                channelEventType,
            });
        }
        for (const codeState of ['../../escape', 'lower', '', null, 7]) {
            await adapter._eventRaised({ pushEventType: 'DEVICE_CODE_STATE_EVENT', deviceId: 'DEV', codeState });
        }

        assert.deepStrictEqual(adapter.objects, {});
        assert.deepStrictEqual(adapter.states, {});
        assert.strictEqual(adapter.logged.warn.length, 12);
    });

    it('refuses a channel event that names no device or channel', async () => {
        const adapter = createHarness();
        await adapter._eventRaised({ pushEventType: 'DEVICE_CHANNEL_EVENT', channelIndex: 1, channelEventType: 'X' });
        await adapter._eventRaised({
            pushEventType: 'DEVICE_CHANNEL_EVENT',
            deviceId: 'DEV',
            channelEventType: 'KEY_PRESS_SHORT',
        });

        assert.deepStrictEqual(adapter.states, {});
        assert.strictEqual(adapter.logged.warn.length, 2);
    });

    it('no longer warns about an event it now understands', async () => {
        const adapter = createHarness();
        await adapter._eventRaised({
            pushEventType: 'DEVICE_CODE_STATE_EVENT',
            deviceId: 'WKP',
            codeIndex: 1,
            codeState: 'KNOWN_CODE_ID_RECEIVED',
        });

        assert.deepStrictEqual(adapter.logged.warn, [], 'a keypad must not fill the log with unhandled events');
    });
});
