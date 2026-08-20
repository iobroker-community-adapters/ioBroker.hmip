'use strict';

const assert = require('node:assert');
const HmCloudAPI = require('../api/hmCloudAPI');

/** the parts of a ws socket the api touches, with every call recorded */
function createSocket() {
    const socket = { handlers: {}, pings: 0, terminated: 0, closed: 0 };
    socket.on = (event, handler) => (socket.handlers[event] = handler);
    socket.ping = callback => {
        socket.pings++;
        callback && callback();
    };
    socket.terminate = () => socket.terminated++;
    socket.close = () => socket.closed++;
    socket.fire = (event, ...args) => socket.handlers[event] && socket.handlers[event](...args);
    return socket;
}

/**
 * hmCloudAPI captures the ws constructor when it is loaded, so the stub has to be in the module
 * cache before it is required - swapping it afterwards would leave a real socket dialling out.
 */
function loadApiWithStubbedSocket() {
    const wsPath = require.resolve('ws');
    const apiPath = require.resolve('../api/hmCloudAPI');
    const sockets = [];
    const realWs = require.cache[wsPath];
    require.cache[wsPath] = {
        id: wsPath,
        filename: wsPath,
        loaded: true,
        exports: function () {
            const socket = createSocket();
            sockets.push(socket);
            return socket;
        },
    };
    delete require.cache[apiPath];
    const StubbedApi = require('../api/hmCloudAPI');
    if (realWs) {
        require.cache[wsPath] = realWs;
    } else {
        delete require.cache[wsPath];
    }
    delete require.cache[apiPath];
    return { StubbedApi, sockets };
}

/** an api whose next connectWebsocket() hands back a socket the test drives by hand */
function connect() {
    const { StubbedApi, sockets } = loadApiWithStubbedSocket();
    const api = new StubbedApi();
    api._urlWebSocket = 'wss://example.invalid';
    api._authToken = 'A';
    api._clientAuthToken = 'B';
    api._accessPointSgtin = 'C';
    api.connectWebsocket();
    return { api, socket: sockets[0], reconnect: () => (api.connectWebsocket(), sockets[sockets.length - 1]) };
}

/** runs body with setTimeout recorded rather than armed, so no reconnect is actually scheduled */
function withRecordedTimers(body) {
    const scheduled = [];
    const original = global.setTimeout;
    global.setTimeout = (handler, delay) => {
        scheduled.push(delay);
        return original(() => {}, 0);
    };
    try {
        body();
    } finally {
        global.setTimeout = original;
    }
    return scheduled;
}

describe('hmCloudAPI websocket liveness', () => {
    it('pings while the connection is answering', () => {
        const { api, socket } = connect();
        socket.fire('open');

        api._checkConnectionAlive();
        api._checkConnectionAlive();

        assert.strictEqual(socket.pings, 2);
        assert.strictEqual(socket.terminated, 0);
    });

    // a silently dropped connection stays OPEN and fires neither error nor close, so the deadline
    // is the only thing that can notice it
    it('terminates a connection that has stopped answering', () => {
        const { api, socket } = connect();
        socket.fire('open');
        const reported = [];
        api.staleConnection = silentFor => reported.push(silentFor);

        api._lastAlive = Date.now() - 26000;
        api._checkConnectionAlive();

        assert.strictEqual(socket.terminated, 1);
        assert.strictEqual(socket.pings, 0, 'a dead connection must not be pinged, it must be dropped');
        assert.strictEqual(reported.length, 1);
        assert.ok(reported[0] >= 26000);
    });

    for (const [event, payload] of [
        ['pong', undefined],
        ['ping', undefined],
        ['message', Buffer.from('{"events":{}}')],
    ]) {
        it(`counts a ${event} as the connection being alive`, () => {
            const { api, socket } = connect();
            socket.fire('open');

            api._lastAlive = Date.now() - 26000;
            socket.fire(event, payload);
            api._checkConnectionAlive();

            assert.strictEqual(socket.terminated, 0, `a ${event} must reset the deadline`);
            assert.strictEqual(socket.pings, 1);
        });
    }

    it('survives a deadline check after the socket is gone', () => {
        const { api } = connect();
        api._ws = null;

        assert.doesNotThrow(() => api._checkConnectionAlive());
    });
});

describe('hmCloudAPI reconnect after dispose', () => {
    // _reinitializeData disposes and then reconnects, so a dispose must not disable the reconnect
    // for the rest of the process
    it('reconnects again once it has been reconnected', () => {
        const { api, socket, reconnect } = connect();
        socket.fire('open');
        api.dispose();
        assert.strictEqual(api.isClosed, true);

        const second = reconnect();
        assert.strictEqual(api.isClosed, false, 'a reconnect must not stay disabled for the process');

        const scheduled = withRecordedTimers(() => second.fire('close', 1006, Buffer.from('')));
        api.dispose();

        assert.deepStrictEqual(scheduled, [10000], 'a close after a reconnect must schedule another one');
    });

    it('does not reconnect after a dispose that was not followed by one', () => {
        const { api, socket } = connect();
        socket.fire('open');
        api.dispose();

        const scheduled = withRecordedTimers(() => socket.fire('close', 1006, Buffer.from('')));

        assert.deepStrictEqual(scheduled, [], 'an unloaded adapter must stay disconnected');
    });

    it('leaves no ping interval behind after a dispose', () => {
        const { api, socket } = connect();
        socket.fire('open');
        assert.ok(api._pingInterval, 'an open connection is supervised');

        api.dispose();
        assert.strictEqual(api._pingInterval, null);
        assert.ok(!api._connectTimeout, 'no reconnect may stay armed');
    });
});
