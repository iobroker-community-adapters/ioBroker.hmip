'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
    CHANNEL_STATES,
    STATELESS_CHANNELS,
    DERIVERS,
    channelStateObjects,
    channelStateValues,
} = require('../lib/channelStates');

const VALID_TYPES = ['boolean', 'number', 'string'];
const SPEC_KEYS = [
    'type',
    'role',
    'unit',
    'min',
    'max',
    'states',
    'name',
    'read',
    'write',
    'parameter',
    'step',
    'debounce',
    'targetGroups',
    'def',
    'from',
    'derive',
    'constant',
    'writeOnly',
];

// Writable without a parameter on purpose: these hold a value that a handler reads back rather
// than dispatching one of their own. `pin` is read by setLockState and pullLatch, the two control
// times pick the cloud's ...WithTime endpoint variants.
const NO_DISPATCH = ['pin', 'controlOnTime', 'controlRampTime'];

function eachState(callback) {
    for (const [channelType, entry] of Object.entries(CHANNEL_STATES)) {
        for (const [field, spec] of Object.entries(entry.states)) {
            callback(channelType, field, spec);
        }
    }
}

/** the states of a channel type including everything it inherits */
function allStates(channelType) {
    const entry = CHANNEL_STATES[channelType];
    return entry.extends ? { ...allStates(entry.extends), ...entry.states } : { ...entry.states };
}

describe('lib/channelStates table', () => {
    it('covers every channel type the adapter claims to handle', () => {
        assert.ok(Object.keys(CHANNEL_STATES).length > 100, 'the table lost channel types');
        let states = 0;
        eachState(() => states++);
        assert.ok(states > 700, `only ${states} states in the table`);
    });

    it('declares a usable spec for every state', () => {
        eachState((channelType, field, spec) => {
            const where = `${channelType}.${field}`;
            assert.ok(VALID_TYPES.includes(spec.type), `${where}: unexpected type ${spec.type}`);
            assert.strictEqual(typeof spec.role, 'string', `${where}: missing role`);
            assert.ok(spec.role.length, `${where}: empty role`);
            assert.deepStrictEqual(
                Object.keys(spec).filter(key => !SPEC_KEYS.includes(key)),
                [],
                `${where}: unexpected key in the spec`,
            );
            if (spec.unit !== undefined) {
                assert.strictEqual(spec.type, 'number', `${where}: a unit only makes sense on a number`);
            }
            if (spec.role === 'json') {
                assert.strictEqual(spec.type, 'string', `${where}: a json role needs a string state`);
            }
            assert.match(field, /^[A-Za-z][A-Za-z0-9]*$/, `${where}: not a plain identifier`);
        });
    });

    it('gives every writable state a way to dispatch, and nothing else one', () => {
        eachState((channelType, field, spec) => {
            const where = `${channelType}.${field}`;
            if (spec.write && !NO_DISPATCH.includes(field)) {
                assert.ok(spec.parameter, `${where} is writable but has no parameter to dispatch on`);
            }
            if (spec.parameter) {
                assert.strictEqual(spec.write, true, `${where} has a parameter but is not writable`);
            }
            if (spec.step !== undefined || spec.debounce !== undefined || spec.targetGroups) {
                assert.ok(spec.parameter, `${where} carries write settings without a parameter`);
            }
        });
    });

    it('only derives through a function that exists', () => {
        eachState((channelType, field, spec) => {
            if (spec.derive !== undefined) {
                assert.strictEqual(
                    typeof DERIVERS[spec.derive],
                    'function',
                    `${channelType}.${field}: no deriver named ${spec.derive}`,
                );
            }
        });
    });

    it('extends only channel types that are in the table, without cycles', () => {
        for (const [channelType, entry] of Object.entries(CHANNEL_STATES)) {
            const seen = new Set([channelType]);
            let base = entry.extends;
            while (base !== undefined) {
                assert.ok(CHANNEL_STATES[base], `${channelType} extends ${base}, which is not in the table`);
                assert.ok(!seen.has(base), `${channelType} has a cycle through ${base}`);
                seen.add(base);
                base = CHANNEL_STATES[base].extends;
            }
        }
    });

    it('never re-declares a state it already inherits', () => {
        for (const [channelType, entry] of Object.entries(CHANNEL_STATES)) {
            if (!entry.extends) {
                continue;
            }
            const inherited = allStates(entry.extends);
            for (const field of Object.keys(entry.states)) {
                assert.ok(!inherited[field], `${channelType}.${field} is already inherited from ${entry.extends}`);
            }
        }
    });

    it('keeps the stateless list disjoint from the table', () => {
        for (const channelType of STATELESS_CHANNELS) {
            assert.ok(!CHANNEL_STATES[channelType], `${channelType} is both stateless and in the table`);
        }
        assert.strictEqual(
            new Set(STATELESS_CHANNELS).size,
            STATELESS_CHANNELS.length,
            'STATELESS_CHANNELS has a duplicate',
        );
    });
});

describe('lib/channelStates builders', () => {
    const states = {
        flag: { type: 'boolean', role: 'indicator' },
        reading: { type: 'number', role: 'value', unit: 'hPa' },
        layout: { type: 'string', role: 'json' },
        level: { type: 'number', role: 'level.blind', min: 0, max: 100, write: true, parameter: 'shutterlevel' },
        setPoint: {
            type: 'number',
            role: 'level.temperature',
            write: true,
            parameter: 'setPointTemperature',
            step: 0.5,
            debounce: 5000,
            targetGroups: true,
        },
        trigger: {
            type: 'boolean',
            role: 'button',
            name: 'on',
            read: false,
            write: true,
            parameter: 'stop',
            writeOnly: true,
        },
        open: { type: 'boolean', role: 'indicator', derive: 'windowOpen' },
        scaled: { type: 'number', role: 'value', from: 'valvePosition', derive: 'percent' },
        fixed: { type: 'boolean', role: 'button', constant: false },
    };
    const channel = { windowState: 'OPEN', valvePosition: 0.25, groups: ['GRP-A'], layout: [{ tile: 1 }] };

    it('builds the ioBroker object for a plain read-only state', () => {
        const [flag] = channelStateObjects({ flag: states.flag }, 'DEV', 1, channel);
        assert.deepStrictEqual(flag, {
            field: 'flag',
            common: { name: 'flag', type: 'boolean', role: 'indicator', read: true, write: false },
            native: { parameter: null },
        });
    });

    it('carries unit, min, max and a name override into common', () => {
        const built = Object.fromEntries(
            channelStateObjects(states, 'DEV', 1, channel).map(entry => [entry.field, entry.common]),
        );
        assert.strictEqual(built.reading.unit, 'hPa');
        assert.strictEqual(built.level.min, 0);
        assert.strictEqual(built.level.max, 100);
        assert.strictEqual(built.trigger.name, 'on', 'an explicit name must win over the field id');
        assert.strictEqual(built.trigger.read, false);
    });

    it('points a writable state at the device channel', () => {
        const built = Object.fromEntries(
            channelStateObjects(states, 'DEV', 1, channel).map(entry => [entry.field, entry.native]),
        );
        assert.deepStrictEqual(built.level, { id: 'DEV', channel: 1, parameter: 'shutterlevel' });
        // extendObject merges, so a state that once dispatched must have its parameter cleared
        assert.deepStrictEqual(built.flag, { parameter: null }, 'a read-only state must clear any parameter');
    });

    it('gives a group-targeted state an empty list when the channel is in no group', () => {
        const built = Object.fromEntries(
            channelStateObjects(states, 'DEV', 1, {}).map(entry => [entry.field, entry.native]),
        );
        assert.deepStrictEqual(built.setPoint.id, [], 'the dispatcher iterates this, so it must be a list');
    });

    it('never leaves a writable state without a way to be dispatched', () => {
        for (const [channelType, entry] of Object.entries(CHANNEL_STATES)) {
            for (const { field, common, native } of channelStateObjects(entry.states, 'DEV', 1, {})) {
                if (common.write && !NO_DISPATCH.includes(field)) {
                    assert.ok(native.parameter, `${channelType}.${field} is writable with no parameter`);
                } else if (!NO_DISPATCH.includes(field)) {
                    assert.strictEqual(
                        native.parameter,
                        null,
                        `${channelType}.${field} is not writable but still carries a parameter`,
                    );
                }
            }
        }
    });

    it('declares every state as readable, writable or both', () => {
        eachState((channelType, field, spec) => {
            const read = spec.read ?? true;
            const write = spec.write ?? false;
            assert.ok(read || write, `${channelType}.${field} can be neither read nor written`);
        });
    });

    it('never gives an unwritable state a role that promises control', () => {
        eachState((channelType, field, spec) => {
            if ((spec.read ?? true) === false) {
                return;
            }
            if (/^(switch|button|level)/.test(spec.role)) {
                assert.strictEqual(spec.write, true, `${channelType}.${field} looks controllable but is not writable`);
            }
        });
    });

    it('points a setpoint at the heating groups the channel belongs to', () => {
        const built = Object.fromEntries(
            channelStateObjects(states, 'DEV', 1, channel).map(entry => [entry.field, entry.native]),
        );
        assert.deepStrictEqual(built.setPoint, {
            id: ['GRP-A'],
            parameter: 'setPointTemperature',
            step: 0.5,
            debounce: 5000,
        });
    });

    it('reads values from the channel, deriving and stringifying where told to', () => {
        const built = Object.fromEntries(channelStateValues(states, channel).map(entry => [entry.field, entry.value]));
        assert.strictEqual(built.open, true, 'windowState OPEN must derive windowOpen');
        assert.strictEqual(built.scaled, 25, 'a percent derive reads its from field and scales it');
        assert.strictEqual(built.fixed, false, 'a constant is written as given');
        assert.strictEqual(built.layout, '[{"tile":1}]', 'a json state must reach ioBroker as a string');
        assert.strictEqual(built.flag, undefined, 'a field the channel does not carry stays undefined');
    });

    it('gives every ...WithTime capable channel a pair of control times the cloud cannot overwrite', () => {
        const withTime = [
            'setDimLevel',
            'setRgbDimLevel',
            'setHueSaturationDimLevel',
            'setColorTemperatureDimLevel',
            'setOpticalSignalBehaviour',
            'setWateringSwitchState',
        ];
        let checked = 0;
        for (const [channelType, entry] of Object.entries(CHANNEL_STATES)) {
            const canRamp = Object.values(entry.states).some(spec => withTime.includes(spec.parameter));
            if (!canRamp) {
                continue;
            }
            checked++;
            for (const field of ['controlOnTime', 'controlRampTime']) {
                const spec = entry.states[field];
                assert.ok(spec, `${channelType} can ramp but has no ${field}`);
                assert.strictEqual(spec.def, 0, `${channelType}.${field} must default to 0`);
                assert.strictEqual(spec.write, true, `${channelType}.${field} must be writable`);
                assert.strictEqual(spec.writeOnly, true, `${channelType}.${field} must never be written back`);
                assert.strictEqual(spec.parameter, undefined, `${channelType}.${field} must not dispatch`);
            }
        }
        assert.ok(checked > 8, `only found ${checked} channels that can ramp`);
    });

    it('never writes a value for a write-only state', () => {
        const fields = channelStateValues(states, channel).map(entry => entry.field);
        assert.ok(!fields.includes('trigger'), 'a write-only state must not be written back');
    });

    it('survives a channel that is not there at all', () => {
        assert.doesNotThrow(() => channelStateValues(states, undefined));
        assert.doesNotThrow(() => channelStateObjects(states, 'DEV', 1, undefined));
    });
});

describe('lib/channelStates against the recorded snapshot', () => {
    // Every object definition and value the table produces for a fixed probe channel. The
    // snapshot started as a capture of the hand-written handlers it replaced, and is updated
    // deliberately when behaviour is meant to change - so an unexplained diff here is a
    // regression, and the git diff on the fixture is the review.
    const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'expectedChannels.json'), 'utf8'));

    it('still covers every channel type the hand-written handlers used to serve', () => {
        assert.ok(Object.keys(snapshot).length > 60, 'the snapshot lost channel types');
    });

    for (const [channelType, expected] of Object.entries(snapshot)) {
        it(`produces the recorded objects and values for ${channelType}`, () => {
            assert.ok(CHANNEL_STATES[channelType], `${channelType} is no longer in the table`);
            const states = allStates(channelType);

            const objects = {};
            for (const { field, common, native } of channelStateObjects(states, 'DEV', 1, expected.channel)) {
                objects[field] = { common, native };
            }
            const values = {};
            for (const { field, value } of channelStateValues(states, expected.channel)) {
                values[field] = value;
            }

            assert.deepStrictEqual(JSON.parse(JSON.stringify(objects)), expected.objects);
            assert.deepStrictEqual(JSON.parse(JSON.stringify(values)), expected.values);
        });
    }
});
