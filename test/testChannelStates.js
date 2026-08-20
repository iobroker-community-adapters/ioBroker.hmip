'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
    DEVICE_BASE_STATES,
    CHANNEL_STATES,
    STATELESS_CHANNELS,
    channelStateObjects,
    channelStateValues,
} = require('../lib/channelStates');

const VALID_TYPES = ['boolean', 'number', 'string'];
const VALID_EXTENDS = ['DEVICE_BASE', 'DEVICE_OPERATIONLOCK'];

// what the hand-written DEVICE_BASE / DEVICE_OPERATIONLOCK handlers already write
const BASE_FIELDS = [
    'configPending',
    'dutyCycle',
    'lowBat',
    'routerModuleEnabled',
    'routerModuleSupported',
    'rssiDeviceValue',
    'rssiPeerValue',
    'unreach',
];
const OPERATION_LOCK_FIELDS = [...BASE_FIELDS, 'operationLockActive'];

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

/**
 * The two channel dispatch switches in main.js, as source text.
 *
 * Both end markers occur more than once in the file, so each has to be searched for from the
 * start of its own method - a plain indexOf finds the earlier copy and slice() then silently
 * yields an empty string.
 */
function channelDispatchRanges() {
    const updateStart = main.indexOf('_updateDeviceStates(device) {');
    const createStart = main.indexOf('_createObjectsForDevice(device) {');
    return {
        update: main.slice(updateStart, main.indexOf('_reinitializeData(id) {', updateStart)),
        create: main.slice(createStart, main.indexOf('/* Start Channel Types */', createStart)),
    };
}

function caseLabels(range) {
    return new Set([...range.matchAll(/case '([A-Z_0-9]+)':/g)].map(match => match[1]));
}

function eachState(callback) {
    for (const [field, spec] of Object.entries(DEVICE_BASE_STATES)) {
        callback('DEVICE_BASE_STATES', field, spec);
    }
    for (const [channelType, entry] of Object.entries(CHANNEL_STATES)) {
        for (const [field, spec] of Object.entries(entry.states)) {
            callback(channelType, field, spec);
        }
    }
}

describe('lib/channelStates table', () => {
    it('declares a usable spec for every state', () => {
        eachState((owner, field, spec) => {
            const where = `${owner}.${field}`;
            assert.ok(VALID_TYPES.includes(spec.type), `${where}: unexpected type ${spec.type}`);
            assert.strictEqual(typeof spec.role, 'string', `${where}: missing role`);
            assert.ok(spec.role.length, `${where}: empty role`);
            if (spec.unit !== undefined) {
                assert.strictEqual(spec.type, 'number', `${where}: a unit only makes sense on a number`);
            }
            assert.deepStrictEqual(
                Object.keys(spec).filter(key => !['type', 'role', 'unit'].includes(key)),
                [],
                `${where}: unexpected key in the spec`,
            );
        });
    });

    it('stores structured values as JSON strings', () => {
        eachState((owner, field, spec) => {
            if (spec.role === 'json') {
                assert.strictEqual(spec.type, 'string', `${owner}.${field}: a json role needs a string state`);
            }
        });
    });

    it('uses field names that are usable as ioBroker state ids', () => {
        eachState((owner, field) => {
            assert.match(field, /^[A-Za-z][A-Za-z0-9]*$/, `${owner}.${field}: not a plain identifier`);
        });
    });

    it('only extends a base channel main.js actually provides', () => {
        for (const [channelType, entry] of Object.entries(CHANNEL_STATES)) {
            if (entry.extends === undefined) {
                continue;
            }
            assert.ok(VALID_EXTENDS.includes(entry.extends), `${channelType}: unknown base ${entry.extends}`);
            for (const method of [
                `_update${entry.extends === 'DEVICE_BASE' ? 'DeviceBase' : 'DeviceOperationLock'}ChannelStates(device, channel) {`,
                `_create${entry.extends === 'DEVICE_BASE' ? 'DeviceBaseChannel' : 'DeviceOperationLockChannel'}(device, channel) {`,
            ]) {
                assert.ok(main.includes(method), `${channelType}: main.js has no ${method}`);
            }
        }
    });

    it('never re-declares a state its base channel already writes', () => {
        for (const [channelType, entry] of Object.entries(CHANNEL_STATES)) {
            const inherited = entry.extends === 'DEVICE_OPERATIONLOCK' ? OPERATION_LOCK_FIELDS : BASE_FIELDS;
            const base = entry.extends ? [...inherited, ...Object.keys(DEVICE_BASE_STATES)] : [];
            for (const field of Object.keys(entry.states)) {
                assert.ok(!base.includes(field), `${channelType}.${field} is already written by ${entry.extends}`);
            }
        }
    });

    it('does not add DEVICE_BASE states the hand-written handler already writes', () => {
        for (const field of Object.keys(DEVICE_BASE_STATES)) {
            assert.ok(!BASE_FIELDS.includes(field), `DEVICE_BASE_STATES.${field} is written twice`);
        }
    });

    it('keeps the stateless list disjoint from the state table', () => {
        for (const channelType of STATELESS_CHANNELS) {
            assert.ok(!CHANNEL_STATES[channelType], `${channelType} is both stateless and in the state table`);
        }
        assert.strictEqual(
            new Set(STATELESS_CHANNELS).size,
            STATELESS_CHANNELS.length,
            'STATELESS_CHANNELS has a duplicate',
        );
    });

    it('reads both channel dispatch switches out of main.js', () => {
        const ranges = channelDispatchRanges();
        for (const [name, range] of Object.entries(ranges)) {
            const labels = caseLabels(range);
            assert.ok(range.length > 0, `the ${name} dispatch range came out empty`);
            assert.ok(labels.size > 50, `only found ${labels.size} case labels in the ${name} switch`);
        }
    });

    it('never shadows a channel type main.js dispatches explicitly', () => {
        const ranges = channelDispatchRanges();
        for (const [name, range] of Object.entries(ranges)) {
            const explicit = caseLabels(range);
            for (const channelType of [...Object.keys(CHANNEL_STATES), ...STATELESS_CHANNELS]) {
                assert.ok(
                    !explicit.has(channelType),
                    `${channelType} has an explicit case in the ${name} switch, so its table entry is dead`,
                );
            }
        }
    });
});

describe('lib/channelStates helpers', () => {
    const states = {
        flag: { type: 'boolean', role: 'indicator' },
        reading: { type: 'number', role: 'value', unit: 'hPa' },
        layout: { type: 'string', role: 'json' },
    };

    it('builds read-only object definitions carrying the declared metadata', () => {
        assert.deepStrictEqual(channelStateObjects(states), [
            { field: 'flag', common: { name: 'flag', read: true, write: false, type: 'boolean', role: 'indicator' } },
            {
                field: 'reading',
                common: { name: 'reading', read: true, write: false, type: 'number', role: 'value', unit: 'hPa' },
            },
            { field: 'layout', common: { name: 'layout', read: true, write: false, type: 'string', role: 'json' } },
        ]);
    });

    it('stringifies a structured value so the state writer cannot mistake it for a state wrapper', () => {
        const channel = { flag: true, reading: 1013.2, layout: [{ val: 'trap', tile: 1 }] };
        assert.deepStrictEqual(channelStateValues(states, channel), [
            { field: 'flag', value: true },
            { field: 'reading', value: 1013.2 },
            { field: 'layout', value: '[{"val":"trap","tile":1}]' },
        ]);
    });

    it('passes null and a missing field through untouched', () => {
        assert.deepStrictEqual(channelStateValues(states, { flag: null }), [
            { field: 'flag', value: null },
            { field: 'reading', value: undefined },
            { field: 'layout', value: undefined },
        ]);
    });

    it('survives a channel that is not there at all', () => {
        assert.deepStrictEqual(
            channelStateValues(states, undefined).map(entry => entry.value),
            [undefined, undefined, undefined],
        );
    });

    it('does not stringify a plain string that happens to sit in a json state', () => {
        assert.deepStrictEqual(channelStateValues({ layout: states.layout }, { layout: 'DEFAULT' }), [
            { field: 'layout', value: '"DEFAULT"' },
        ]);
    });

    it('reads every real json state in the table as a string', () => {
        const jsonFields = Object.entries(CHANNEL_STATES).flatMap(([channelType, entry]) =>
            Object.entries(entry.states)
                .filter(([, spec]) => spec.role === 'json')
                .map(([field]) => [channelType, field]),
        );
        assert.ok(jsonFields.length, 'the table should still contain json states');
        for (const [channelType, field] of jsonFields) {
            const [entry] = channelStateValues(
                { [field]: CHANNEL_STATES[channelType].states[field] },
                {
                    [field]: { a: 1 },
                },
            );
            assert.strictEqual(typeof entry.value, 'string', `${channelType}.${field} must reach ioBroker as a string`);
        }
    });
});
