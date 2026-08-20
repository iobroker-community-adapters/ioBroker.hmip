'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const HmCloudAPI = require('../api/hmCloudAPI');
const { CHANNEL_STATES } = require('../lib/channelStates');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

/** the body of _doStateChange, which is the adapter's only command dispatcher */
function dispatcherBody() {
    const start = mainSource.indexOf('async _doStateChange(id, o, state) {');
    assert.notStrictEqual(start, -1, 'main.js no longer has a _doStateChange');
    const end = mainSource.indexOf('\n    async _stateChange(', start);
    assert.notStrictEqual(end, -1, 'could not find the end of _doStateChange');
    // a commented-out call is not a call, and would otherwise pass for one
    return mainSource
        .slice(start, end)
        .split('\n')
        .filter(line => !line.trim().startsWith('//'))
        .join('\n');
}

const DISPATCHER = dispatcherBody();
const HANDLED = new Set([...DISPATCHER.matchAll(/case '([A-Za-z0-9]+)':/g)].map(match => match[1]));

/** every parameter the object tree can carry, wherever it is declared */
function declaredParameters() {
    const parameters = new Map();
    for (const [channelType, entry] of Object.entries(CHANNEL_STATES)) {
        for (const [field, spec] of Object.entries(entry.states)) {
            if (spec.parameter) {
                parameters.set(spec.parameter, `${channelType}.${field}`);
            }
        }
    }
    // groups, homes and rules are still hand-written object trees, and a parameter there can sit
    // behind a ternary that clears it, so every name on a parameter line counts
    const handWritten = mainSource.slice(mainSource.indexOf('\n    async _stateChange('));
    for (const line of handWritten.split('\n')) {
        const declaration = line.split('parameter:')[1];
        if (declaration === undefined) {
            continue;
        }
        for (const match of declaration.matchAll(/'([A-Za-z0-9]+)'/g)) {
            parameters.set(match[1], 'main.js');
        }
    }
    return parameters;
}

describe('command dispatch', () => {
    const parameters = declaredParameters();

    it('has a parameter for every command the adapter can send', () => {
        assert.ok(parameters.size > 60, `only ${parameters.size} parameters declared`);
        assert.ok(HANDLED.size > 60, `only ${HANDLED.size} cases in _doStateChange`);
    });

    it('handles every declared parameter in _doStateChange', () => {
        for (const [parameter, where] of parameters) {
            assert.ok(HANDLED.has(parameter), `${where} dispatches on ${parameter}, which has no case`);
        }
    });

    it('never dispatches on a parameter nothing declares', () => {
        for (const parameter of HANDLED) {
            assert.ok(parameters.has(parameter), `_doStateChange handles ${parameter}, which nothing declares`);
        }
    });

    it('only calls api methods that exist', () => {
        const called = new Set([...DISPATCHER.matchAll(/this\._api\.([A-Za-z0-9_]+)\(/g)].map(match => match[1]));
        assert.ok(called.size > 40, `only ${called.size} api calls found in _doStateChange`);
        for (const method of called) {
            assert.strictEqual(
                typeof HmCloudAPI.prototype[method],
                'function',
                `_doStateChange calls ${method}, which the api does not implement`,
            );
        }
    });

    it('only calls adapter helpers that exist', () => {
        const helpers = new Set([...DISPATCHER.matchAll(/await this\.(_[A-Za-z0-9_]+)\(/g)].map(match => match[1]));
        for (const helper of helpers) {
            assert.ok(
                mainSource.includes(`\n    ${helper}(`) || mainSource.includes(`\n    async ${helper}(`),
                `_doStateChange calls ${helper}, which main.js does not define`,
            );
        }
    });
});
