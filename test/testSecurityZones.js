'use strict';

const assert = require('node:assert');
const HmCloudAPI = require('../api/hmCloudAPI');

const CLASSIC_GROUPS = {
    g1: { id: 'g1', type: 'SECURITY_ZONE', label: 'INTERNAL', channels: [{ deviceId: 'DEV-1', channelIndex: 0 }] },
    g2: { id: 'g2', type: 'SECURITY_ZONE', label: 'EXTERNAL', channels: [] },
    g3: { id: 'g3', type: 'SWITCHING', label: 'ABSENCE' },
};

const REQUEST_BASED_GROUPS = {
    g4: { id: 'g4', type: 'SECURITY_ZONE', label: 'ABSENCE', channels: [{ deviceId: 'DEV-1', channelIndex: 0 }] },
    g5: { id: 'g5', type: 'SECURITY_ZONE', label: 'PRESENCE', channels: [{ deviceId: 'DEV-2', channelIndex: 0 }] },
};

function createApi(groups, restResponse, devices) {
    const api = new HmCloudAPI();
    api.groups = groups;
    api.devices = devices || {
        'DEV-1': { id: 'DEV-1', label: 'Front door', functionalChannels: { 0: { lowBat: false } } },
        'DEV-2': { id: 'DEV-2', label: 'Terrace door', functionalChannels: { 0: { lowBat: false } } },
    };
    api.calls = [];
    api.callRestApi = (path, data) => {
        api.calls.push({ path, data });
        return Promise.resolve(restResponse);
    };
    return api;
}

describe('hmCloudAPI security zone detection', () => {
    it('reports the classic panel for INTERNAL/EXTERNAL zones', () => {
        const api = createApi(CLASSIC_GROUPS);
        assert.strictEqual(api.hasRequestBasedSecurityZones(), false);
        assert.strictEqual(api.hasClassicSecurityZones(), true);
    });

    it('reports the request-based panel once a zone is labelled ABSENCE or PRESENCE', () => {
        assert.strictEqual(createApi(REQUEST_BASED_GROUPS).hasRequestBasedSecurityZones(), true);
        assert.strictEqual(
            createApi({ g4: { id: 'g4', type: 'SECURITY_ZONE', label: 'PRESENCE' } }).hasRequestBasedSecurityZones(),
            true,
        );
    });

    it('recognises a home carrying both zone families', () => {
        const api = createApi({ ...CLASSIC_GROUPS, ...REQUEST_BASED_GROUPS });
        assert.strictEqual(api.hasRequestBasedSecurityZones(), true);
        assert.strictEqual(api.hasClassicSecurityZones(), true);
    });

    it('ignores the label on groups that are not security zones', () => {
        assert.strictEqual(
            createApi({ g3: CLASSIC_GROUPS.g3 }).hasRequestBasedSecurityZones(),
            false,
            'a SWITCHING group named ABSENCE must not switch the panel semantics',
        );
    });

    it('survives an absent group cache and null entries in it', () => {
        assert.strictEqual(createApi(undefined).hasRequestBasedSecurityZones(), false);
        assert.strictEqual(createApi({ g1: null }).hasRequestBasedSecurityZones(), false);
    });
});

describe('refreshGroups', () => {
    function api(groups) {
        const instance = new HmCloudAPI();
        instance.groups = groups;
        return instance;
    }

    it('takes the groups of the response', () => {
        const instance = api({ g1: { id: 'g1', active: false } });
        instance.refreshGroups({ g1: { id: 'g1', active: true }, g2: { id: 'g2' } }, new Set());

        assert.deepStrictEqual(instance.groups, { g1: { id: 'g1', active: true }, g2: { id: 'g2' } });
    });

    it('drops a group the response no longer has', () => {
        const instance = api({ g1: { id: 'g1' }, gone: { id: 'gone' } });
        instance.refreshGroups({ g1: { id: 'g1' } }, new Set());

        assert.deepStrictEqual(Object.keys(instance.groups), ['g1']);
    });

    it('keeps a group a push changed while the response was in flight', () => {
        const instance = api({ g1: { id: 'g1', active: true } });
        instance.refreshGroups({ g1: { id: 'g1', active: false } }, new Set(['g1']));

        assert.strictEqual(instance.groups.g1.active, true, 'the push is newer than the response');
    });

    it('keeps a group a push added while the response was in flight', () => {
        const instance = api({ fresh: { id: 'fresh' } });
        instance.refreshGroups({}, new Set(['fresh']));

        assert.deepStrictEqual(Object.keys(instance.groups), ['fresh']);
    });

    it('leaves the cache alone when the response carries no groups', () => {
        const instance = api({ g1: { id: 'g1' } });
        instance.refreshGroups(undefined, new Set());

        assert.deepStrictEqual(Object.keys(instance.groups), ['g1']);
    });
});

describe('securityZonesArmedState', () => {
    function zones(groups) {
        const api = new HmCloudAPI();
        api.groups = groups;
        return api.securityZonesArmedState();
    }

    it('reads the classic zones as the pair they are', () => {
        assert.deepStrictEqual(
            zones({
                g1: { type: 'SECURITY_ZONE', label: 'INTERNAL', active: true },
                g2: { type: 'SECURITY_ZONE', label: 'EXTERNAL', active: true },
            }),
            { requestBased: false, internal: true, external: true, mode: 'INTERNAL_AND_EXTERNAL' },
        );
        assert.deepStrictEqual(
            zones({
                g1: { type: 'SECURITY_ZONE', label: 'INTERNAL', active: false },
                g2: { type: 'SECURITY_ZONE', label: 'EXTERNAL', active: true },
            }),
            { requestBased: false, internal: false, external: true, mode: 'EXTERNAL' },
        );
        assert.deepStrictEqual(
            zones({
                g1: { type: 'SECURITY_ZONE', label: 'INTERNAL', active: true },
                g2: { type: 'SECURITY_ZONE', label: 'EXTERNAL', active: false },
            }),
            { requestBased: false, internal: true, external: false, mode: 'INTERNAL' },
        );
        assert.deepStrictEqual(zones(CLASSIC_GROUPS), {
            requestBased: false,
            internal: false,
            external: false,
            mode: 'OFF',
        });
    });

    it('maps an armed ABSENCE zone onto armed away', () => {
        assert.deepStrictEqual(
            zones({
                g4: { type: 'SECURITY_ZONE', label: 'ABSENCE', active: true },
                g5: { type: 'SECURITY_ZONE', label: 'PRESENCE' },
            }),
            { requestBased: true, internal: true, external: true, mode: 'ABSENCE' },
        );
    });

    it('maps an armed PRESENCE zone onto armed at home', () => {
        assert.deepStrictEqual(
            zones({
                g4: { type: 'SECURITY_ZONE', label: 'ABSENCE' },
                g5: { type: 'SECURITY_ZONE', label: 'PRESENCE', active: true },
            }),
            { requestBased: true, internal: false, external: true, mode: 'PRESENCE' },
        );
    });

    it('prefers ABSENCE when a panel reports both zones armed', () => {
        assert.strictEqual(
            zones({
                g4: { type: 'SECURITY_ZONE', label: 'ABSENCE', active: true },
                g5: { type: 'SECURITY_ZONE', label: 'PRESENCE', active: true },
            }).mode,
            'ABSENCE',
        );
    });

    it('reads a request-based panel with no armed zone as off', () => {
        assert.deepStrictEqual(zones(REQUEST_BASED_GROUPS), {
            requestBased: true,
            internal: false,
            external: false,
            mode: 'OFF',
        });
    });

    it("reports the armed family of a mixed home, in that family's own words", () => {
        const mixed = active => ({
            g1: { type: 'SECURITY_ZONE', label: 'INTERNAL', active: active.INTERNAL === true },
            g2: { type: 'SECURITY_ZONE', label: 'EXTERNAL', active: active.EXTERNAL === true },
            g4: { type: 'SECURITY_ZONE', label: 'ABSENCE', active: active.ABSENCE === true },
            g5: { type: 'SECURITY_ZONE', label: 'PRESENCE', active: active.PRESENCE === true },
        });

        assert.deepStrictEqual(
            zones(mixed({ INTERNAL: true, EXTERNAL: true })),
            { requestBased: true, internal: true, external: true, mode: 'INTERNAL_AND_EXTERNAL' },
            'the classic zones of a mixed home must not read as disarmed',
        );
        assert.deepStrictEqual(
            zones(mixed({ INTERNAL: true })),
            { requestBased: true, internal: true, external: false, mode: 'INTERNAL' },
            'ABSENCE means both zones, so it must not name a state where only one is armed',
        );
        assert.deepStrictEqual(zones(mixed({ ABSENCE: true })), {
            requestBased: true,
            internal: true,
            external: true,
            mode: 'ABSENCE',
        });
        assert.deepStrictEqual(
            zones(mixed({ INTERNAL: true, PRESENCE: true })),
            { requestBased: true, internal: true, external: true, mode: 'INTERNAL_AND_EXTERNAL' },
            'an armed zone of either family is an armed zone, so neither may be dropped',
        );
    });

    it('only reads a zone the cloud calls active as armed', () => {
        assert.strictEqual(zones({ g1: { type: 'SECURITY_ZONE', label: 'EXTERNAL', active: 1 } }).external, false);
        assert.strictEqual(zones({ g1: { type: 'SECURITY_ZONE', label: 'EXTERNAL', active: 'true' } }).external, false);
    });

    // characterization: the labels come from the cloud, and the accumulator is prototype-less
    it('does not read a zone labelled __proto__ as armed', () => {
        assert.deepStrictEqual(zones({ g1: { type: 'SECURITY_ZONE', label: '__proto__', active: true } }), {
            requestBased: false,
            internal: false,
            external: false,
            mode: 'OFF',
        });
    });

    it('survives an absent group cache', () => {
        assert.deepStrictEqual(zones(undefined), {
            requestBased: false,
            internal: false,
            external: false,
            mode: 'OFF',
        });
    });
});

describe('homeSetZonesActivation on a classic panel', () => {
    it('posts the additive INTERNAL/EXTERNAL zones to setZonesActivation', async () => {
        const api = createApi(CLASSIC_GROUPS, '');
        const outcome = await api.homeSetZonesActivation(false, true);
        assert.deepStrictEqual(api.calls, [
            {
                path: 'home/security/setZonesActivation',
                data: { zonesActivation: { INTERNAL: false, EXTERNAL: true } },
            },
        ]);
        assert.deepStrictEqual(outcome, {
            requestBased: false,
            classicZonesPresent: true,
            requestFailed: false,
            confirmed: true,
            problems: null,
            lowBatteryDevices: [],
            lowBatteryLookupIncomplete: false,
        });
    });

    it('marks a request that never reached the cloud as failed', async () => {
        const api = createApi(CLASSIC_GROUPS, undefined);
        const outcome = await api.homeSetZonesActivation(true, true);
        assert.strictEqual(outcome.requestFailed, true);
        assert.strictEqual(outcome.problems, null);
    });
});

describe('homeSetZonesActivation on a request-based panel', () => {
    const cases = [
        { internal: true, external: true, expected: { PRESENCE: false, ABSENCE: true } },
        { internal: false, external: true, expected: { PRESENCE: true, ABSENCE: false } },
        { internal: true, external: false, expected: { PRESENCE: false, ABSENCE: true } },
        { internal: false, external: false, expected: { PRESENCE: false, ABSENCE: false } },
    ];

    for (const { internal, external, expected } of cases) {
        it(`maps internal=${internal}/external=${external} onto ${JSON.stringify(expected)}`, async () => {
            const api = createApi(REQUEST_BASED_GROUPS, {});
            await api.homeSetZonesActivation(internal, external);
            assert.deepStrictEqual(api.calls, [
                {
                    path: 'home/security/setExtendedZonesActivation',
                    data: { zonesActivation: expected, ignoreLowBat: true },
                },
            ]);
        });
    }

    it('keeps using the request-based call when classic zones are present too, and flags the setup', async () => {
        const api = createApi({ ...CLASSIC_GROUPS, ...REQUEST_BASED_GROUPS }, {});
        const outcome = await api.homeSetZonesActivation(true, true);
        assert.strictEqual(api.calls[0].path, 'home/security/setExtendedZonesActivation');
        assert.deepStrictEqual(api.calls[0].data.zonesActivation, { PRESENCE: false, ABSENCE: true });
        assert.strictEqual(outcome.classicZonesPresent, true);
    });

    it('does not flag a plain request-based home as mixed', async () => {
        const api = createApi(REQUEST_BASED_GROUPS, {});
        assert.strictEqual(await api.homeSetZonesActivation(true, true).then(o => o.classicZonesPresent), false);
    });

    it('reports no problems when the panel armed', async () => {
        const api = createApi(REQUEST_BASED_GROUPS, { activationProblems: [], channelActivationProblems: {} });
        const outcome = await api.homeSetZonesActivation(true, true);
        assert.strictEqual(outcome.requestFailed, false);
        assert.deepStrictEqual({ ...outcome.problems }, {});
    });

    it('treats an empty 200 body as accepted but unconfirmed', async () => {
        const api = createApi(REQUEST_BASED_GROUPS, '');
        const outcome = await api.homeSetZonesActivation(true, true);
        assert.strictEqual(outcome.requestFailed, false, 'axios yields an empty string for a body-less 200');
        assert.strictEqual(outcome.confirmed, false, 'a body-less 200 carries no blocker detail to inspect');
        assert.deepStrictEqual({ ...outcome.problems }, {});
    });

    // an empty problems map means "nothing blocked it" only when there was something to inspect,
    // so nothing downstream may claim the zones armed
    it('does not claim the zones armed when the panel reported no detail', async () => {
        const flatBatteries = {
            'DEV-1': { id: 'DEV-1', label: 'Front door', functionalChannels: { 0: { lowBat: true } } },
            'DEV-2': { id: 'DEV-2', label: 'Terrace door', functionalChannels: { 0: { lowBat: true } } },
        };
        for (const response of ['', 0, 'OK', null]) {
            const api = createApi(REQUEST_BASED_GROUPS, response, flatBatteries);
            const outcome = await api.homeSetZonesActivation(true, true);
            assert.strictEqual(outcome.confirmed, false, `${JSON.stringify(response)} is nothing to inspect`);
            assert.deepStrictEqual(
                outcome.lowBatteryDevices,
                [],
                'naming a low battery would assert the zone armed, which the panel never said',
            );
            assert.strictEqual(outcome.lowBatteryLookupIncomplete, false);
        }
    });

    it('still names low-battery devices once the panel has confirmed the activation', async () => {
        const api = createApi(
            REQUEST_BASED_GROUPS,
            {},
            {
                'DEV-1': { id: 'DEV-1', label: 'Front door', functionalChannels: { 0: { lowBat: true } } },
                'DEV-2': { id: 'DEV-2', label: 'Terrace door', functionalChannels: { 0: { lowBat: true } } },
            },
        );
        const outcome = await api.homeSetZonesActivation(true, true);
        assert.strictEqual(outcome.confirmed, true);
        assert.ok(outcome.lowBatteryDevices.length, 'a confirmed activation still reports a flat battery');
    });

    it('confirms an activation the panel did describe', async () => {
        const api = createApi(REQUEST_BASED_GROUPS, { activationProblems: [], channelActivationProblems: {} });
        const outcome = await api.homeSetZonesActivation(true, true);
        assert.strictEqual(outcome.confirmed, true);
    });

    it('confirms a classic panel, whose 200 is the whole answer', async () => {
        const api = createApi(CLASSIC_GROUPS, '');
        const outcome = await api.homeSetZonesActivation(true, true);
        assert.strictEqual(outcome.confirmed, true, 'a classic panel reports no detail by design');
        assert.strictEqual(outcome.requestFailed, false);
    });

    it('marks a request that never reached the cloud as failed', async () => {
        const api = createApi(REQUEST_BASED_GROUPS, undefined);
        const outcome = await api.homeSetZonesActivation(true, true);
        assert.strictEqual(outcome.requestFailed, true);
        assert.strictEqual(outcome.problems, null, 'a failed request carries no information about blockers');
    });

    it('resolves blocking channels to device labels', async () => {
        const api = createApi(REQUEST_BASED_GROUPS, {
            activationProblems: [],
            channelActivationProblems: { 'DEV-1:1': ['WINDOW_OPEN'] },
        });
        const outcome = await api.homeSetZonesActivation(true, true);
        assert.deepStrictEqual({ ...outcome.problems }, { 'Front door': ['WINDOW_OPEN'] });
    });

    it('keeps the raw key for an unknown device and merges general problems', async () => {
        const api = createApi(REQUEST_BASED_GROUPS, {
            activationProblems: ['SOME_GENERAL_PROBLEM'],
            channelActivationProblems: { 'DEV-UNKNOWN:2': ['SABOTAGE'] },
        });
        assert.deepStrictEqual(await api.homeSetZonesActivation(true, true).then(o => ({ ...o.problems })), {
            '': ['SOME_GENERAL_PROBLEM'],
            'DEV-UNKNOWN:2': ['SABOTAGE'],
        });
    });

    it('merges two channels of the same device into one entry', async () => {
        const api = createApi(REQUEST_BASED_GROUPS, {
            channelActivationProblems: { 'DEV-1:1': ['WINDOW_OPEN'], 'DEV-1:2': ['SABOTAGE'] },
        });
        assert.deepStrictEqual(await api.homeSetZonesActivation(true, true).then(o => ({ ...o.problems })), {
            'Front door': ['WINDOW_OPEN', 'SABOTAGE'],
        });
    });

    it('renders unexpected problem shapes without producing [object Object]', async () => {
        const api = createApi(REQUEST_BASED_GROUPS, {
            activationProblems: 'SINGLE_STRING',
            channelActivationProblems: { 'DEV-1:1': { code: 'WINDOW_OPEN' }, 'DEV-2:1': undefined },
        });
        const problems = await api.homeSetZonesActivation(true, true).then(o => ({ ...o.problems }));
        assert.deepStrictEqual(problems, {
            '': ['SINGLE_STRING'],
            'Front door': ['{"code":"WINDOW_OPEN"}'],
        });
        assert.ok(!('Terrace door' in problems), 'an empty reason list must not be reported as a blocker');
    });

    it('names low-battery devices in the zones it armed', async () => {
        const api = createApi(
            REQUEST_BASED_GROUPS,
            {},
            {
                'DEV-1': { id: 'DEV-1', label: 'Front door', functionalChannels: { 0: { lowBat: true } } },
                'DEV-2': { id: 'DEV-2', label: 'Terrace door', functionalChannels: { 0: { lowBat: true } } },
            },
        );
        const outcome = await api.homeSetZonesActivation(false, true);
        assert.deepStrictEqual(
            outcome.lowBatteryDevices,
            ['Terrace door'],
            'only the PRESENCE zone was armed, so the ABSENCE zone device must not be named',
        );
    });

    it('survives a device or zone named after an Object.prototype member', async () => {
        const api = createApi(
            {
                g4: { id: 'g4', type: 'SECURITY_ZONE', label: 'ABSENCE', channels: [{ deviceId: 'DEV-1' }] },
                g9: { id: 'g9', type: 'SECURITY_ZONE', label: '__proto__', channels: [{ deviceId: 'DEV-2' }] },
            },
            { channelActivationProblems: { 'DEV-1:1': ['WINDOW_OPEN'], 'DEV-3:1': ['SABOTAGE'] } },
            {
                'DEV-1': { id: 'DEV-1', label: 'constructor', functionalChannels: { 0: { lowBat: false } } },
                'DEV-2': { id: 'DEV-2', label: 'Terrace door', functionalChannels: { 0: { lowBat: true } } },
                'DEV-3': { id: 'DEV-3', label: 'toString', functionalChannels: { 0: { lowBat: false } } },
            },
        );
        const outcome = await api.homeSetZonesActivation(true, true);
        assert.deepStrictEqual(Object.keys(outcome.problems).sort(), ['constructor', 'toString']);
        assert.deepStrictEqual(outcome.problems.constructor, ['WINDOW_OPEN']);
        assert.deepStrictEqual(outcome.problems.toString, ['SABOTAGE']);
        assert.deepStrictEqual(
            outcome.lowBatteryDevices,
            [],
            'a zone labelled __proto__ must not read as armed off the prototype chain',
        );
    });

    it('keeps a blocker reported for a device named __proto__', async () => {
        const api = createApi(
            REQUEST_BASED_GROUPS,
            { channelActivationProblems: { 'DEV-9:1': ['WINDOW_OPEN'] } },
            { 'DEV-9': { id: 'DEV-9', label: '__proto__', functionalChannels: { 0: {} } } },
        );
        const problems = await api.homeSetZonesActivation(true, true).then(o => o.problems);
        assert.deepStrictEqual(Object.keys(problems), ['__proto__'], 'a plain object would swallow this key');
        assert.deepStrictEqual(problems['__proto__'], ['WINDOW_OPEN']);
    });

    it('does not read a zone labelled __proto__ as armed', async () => {
        const api = createApi(
            {
                g4: { id: 'g4', type: 'SECURITY_ZONE', label: 'ABSENCE', channels: [] },
                g9: { id: 'g9', type: 'SECURITY_ZONE', label: '__proto__', channels: [{ deviceId: 'DEV-2' }] },
            },
            {},
            { 'DEV-2': { id: 'DEV-2', label: 'Terrace door', functionalChannels: { 0: { lowBat: true } } } },
        );
        const outcome = await api.homeSetZonesActivation(true, true);
        assert.deepStrictEqual(
            outcome.lowBatteryDevices,
            [],
            'zonesActivation.__proto__ is truthy on a plain object, so only an exact true may count as armed',
        );
    });

    it('only treats lowBat === true as a low battery', async () => {
        const nulled = createApi(
            REQUEST_BASED_GROUPS,
            {},
            {
                'DEV-2': { id: 'DEV-2', label: 'Null battery', functionalChannels: { 0: { lowBat: null } } },
            },
        );
        assert.deepStrictEqual(await nulled.homeSetZonesActivation(false, true).then(o => o.lowBatteryDevices), []);

        const stringy = createApi(
            REQUEST_BASED_GROUPS,
            {},
            {
                'DEV-2': { id: 'DEV-2', label: 'Stringy battery', functionalChannels: { 0: { lowBat: 'true' } } },
            },
        );
        assert.deepStrictEqual(
            await stringy.homeSetZonesActivation(false, true).then(o => o.lowBatteryDevices),
            [],
            'a truthy non-boolean must not be reported as a low battery',
        );
    });

    it('flags an incomplete low-battery check when a zone channel resolves to nothing', async () => {
        const api = createApi(REQUEST_BASED_GROUPS, {}, {});
        const outcome = await api.homeSetZonesActivation(false, true);
        assert.deepStrictEqual(outcome.lowBatteryDevices, []);
        assert.strictEqual(outcome.lowBatteryLookupIncomplete, true);
    });

    it('reports a complete low-battery check when every zone channel resolves', async () => {
        const api = createApi(REQUEST_BASED_GROUPS, {});
        const outcome = await api.homeSetZonesActivation(false, true);
        assert.strictEqual(outcome.lowBatteryLookupIncomplete, false);
    });

    it('tolerates a security zone with no channels array', async () => {
        const api = createApi({ g4: { id: 'g4', type: 'SECURITY_ZONE', label: 'ABSENCE' } }, {});
        const outcome = await api.homeSetZonesActivation(true, true);
        assert.deepStrictEqual(outcome.lowBatteryDevices, []);
        assert.strictEqual(outcome.lowBatteryLookupIncomplete, false);
    });

    it('does not name low-battery devices when the activation was blocked anyway', async () => {
        const api = createApi(
            REQUEST_BASED_GROUPS,
            { channelActivationProblems: { 'DEV-2:1': ['WINDOW_OPEN'] } },
            {
                'DEV-2': { id: 'DEV-2', label: 'Terrace door', functionalChannels: { 0: { lowBat: true } } },
            },
        );
        const outcome = await api.homeSetZonesActivation(false, true);
        assert.deepStrictEqual(outcome.lowBatteryDevices, []);
    });
});
