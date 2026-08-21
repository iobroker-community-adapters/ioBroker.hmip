'use strict';

const assert = require('node:assert');
const HmCloudAPI = require('../api/hmCloudAPI');

function createApi(restResponse) {
    const api = new HmCloudAPI();
    api.calls = [];
    api.callRestApi = (path, data) => {
        api.calls.push({ path, data });
        return Promise.resolve(restResponse);
    };
    return api;
}

/** the single call an api method made, so a payload typo shows up as a diff */
async function callOf(invoke, restResponse) {
    const api = createApi(restResponse);
    const result = await invoke(api);
    assert.strictEqual(api.calls.length, 1, 'expected exactly one rest call');
    return { ...api.calls[0], result };
}

describe('hmCloudAPI command payloads', () => {
    it('sets the silent alarm per zone family', async () => {
        const call = await callOf(api => api.homeSetZonesSilentAlarm(true, false));
        assert.strictEqual(call.path, 'home/security/setZonesSilentAlarm');
        assert.deepStrictEqual(call.data, { zonesSilentAlarm: { INTERNAL: true, EXTERNAL: false } });
    });

    it('names the vacation end time as the cloud does', async () => {
        const call = await callOf(api => api.homeHeatingActivateVacation(12, '2026_09_01 08:00'));
        assert.strictEqual(call.path, 'home/heating/activateVacation');
        assert.deepStrictEqual(call.data, { temperature: 12, endTime: '2026_09_01 08:00' });
    });

    it('sets a heating group profile mode', async () => {
        const call = await callOf(api => api.groupHeatingSetProfileMode('GRP-A', 'MANUAL'));
        assert.strictEqual(call.path, 'group/heating/setProfileMode');
        assert.deepStrictEqual(call.data, { groupId: 'GRP-A', profileMode: 'MANUAL' });
    });

    it('sets the on time of a linked switching group', async () => {
        const call = await callOf(api => api.groupSwitchingLinkedSetOnTime('GRP-B', 120));
        assert.strictEqual(call.path, 'group/switching/linked/setOnTime');
        assert.deepStrictEqual(call.data, { groupId: 'GRP-B', onTime: 120 });
    });

    it('sets the power meter unit price', async () => {
        const call = await callOf(api => api.homeSetPowerMeterUnitPrice(0.42));
        assert.strictEqual(call.path, 'home/setPowerMeterUnitPrice');
        assert.deepStrictEqual(call.data, { powerMeterUnitPrice: 0.42 });
    });

    it('enables and relabels a rule', async () => {
        const enabled = await callOf(api => api.ruleEnableSimpleRule('RULE-1', true), '');
        assert.strictEqual(enabled.path, 'rule/enableSimpleRule');
        assert.deepStrictEqual(enabled.data, { ruleId: 'RULE-1', enabled: true });

        const labelled = await callOf(api => api.ruleSetRuleLabel('RULE-1', 'Night'), '');
        assert.strictEqual(labelled.path, 'rule/setRuleLabel');
        assert.deepStrictEqual(labelled.data, { ruleId: 'RULE-1', label: 'Night' });
    });

    // callRestApi swallows every failure and answers undefined, so a command that reports whether
    // it landed has to hand that undefined back rather than resolving to nothing of its own
    it('hands back what the cloud answered, so a failed command can be told apart', async () => {
        const accepted = await callOf(api => api.ruleEnableSimpleRule('RULE-1', true), '');
        assert.strictEqual(accepted.result, '');

        for (const invoke of [
            api => api.ruleEnableSimpleRule('RULE-1', true),
            api => api.ruleSetRuleLabel('RULE-1', 'Night'),
            api => api.homeSetZonesSilentAlarm(true, false),
        ]) {
            const failed = await callOf(invoke, undefined);
            assert.strictEqual(failed.result, undefined, `${failed.path} must report a request that never landed`);
        }
    });

    // a pin datapoint the user never filled reads as null, and the command used to stringify it
    it('sends an empty authorization pin when there is none', async () => {
        for (const pin of [null, undefined, '']) {
            const call = await callOf(api => api.deviceControlSetLockState('DEV', 'LOCKED', pin, 1), '');
            assert.strictEqual(call.path, 'device/control/setLockState');
            assert.deepStrictEqual(call.data, {
                deviceId: 'DEV',
                channelIndex: 1,
                authorizationPin: '',
                targetLockState: 'LOCKED',
            });
        }
    });

    it('sends a pin that was set, as a string', async () => {
        const call = await callOf(api => api.deviceControlSetLockState('DEV', 'UNLOCKED', 1234, 1), '');
        assert.strictEqual(call.data.authorizationPin, '1234');
    });

    it('returns the security journal to its caller', async () => {
        const entries = [{ eventTimestamp: 2, eventType: 'ACTIVATION_CHANGED', label: 'Zone' }];
        const call = await callOf(api => api.homeGetSecurityJournal(), { entries });
        assert.strictEqual(call.path, 'home/security/getSecurityJournal');
        assert.deepStrictEqual(call.result, { entries });
    });
});

describe('hmCloudAPI loadCurrentConfig', () => {
    // getCurrentState answers with exactly { clients, devices, groups, home }, and the rules sit
    // inside home - a captured response is in the reference implementation's json_data/home.json
    it('reads the rule metadata out of the home, where the cloud puts it', async () => {
        const api = createApi();
        const rules = { 'RULE-1': { id: 'RULE-1', label: 'Night', active: true, type: 'SIMPLE' } };
        api.callRestApi = () =>
            Promise.resolve({ home: { id: 'HOME', ruleMetaDatas: rules }, groups: {}, clients: {}, devices: {} });
        await api.loadCurrentConfig();
        assert.deepStrictEqual(api.rules, rules);
    });

    it('does not look for the rules beside the home', async () => {
        const api = createApi();
        api.callRestApi = () =>
            Promise.resolve({
                home: { id: 'HOME' },
                groups: {},
                clients: {},
                devices: {},
                ruleMetaDatas: { 'RULE-1': { id: 'RULE-1' } },
            });
        await api.loadCurrentConfig();
        assert.deepStrictEqual(api.rules, {}, 'a top-level ruleMetaDatas is not a shape the cloud sends');
    });

    it('leaves an empty rule cache when the home carries none', async () => {
        const api = createApi();
        api.callRestApi = () => Promise.resolve({ home: { id: 'HOME' }, groups: {}, clients: {}, devices: {} });
        await api.loadCurrentConfig();
        assert.deepStrictEqual(api.rules, {});
    });

    it('throws rather than dropping the whole configuration', async () => {
        const api = createApi();
        api.callRestApi = () => Promise.resolve(undefined);
        await assert.rejects(() => api.loadCurrentConfig(), /No current State received/);
    });
});
