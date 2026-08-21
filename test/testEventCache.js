'use strict';

const assert = require('node:assert');
const HmCloudAPI = require('../api/hmCloudAPI');

describe('hmCloudAPI event cache maintenance', () => {
    function createApiWithCaches() {
        const api = new HmCloudAPI();
        api.devices = { d1: { id: 'd1' } };
        api.groups = { g1: { id: 'g1', type: 'SECURITY_ZONE', label: 'ABSENCE' } };
        api.clients = { c1: { id: 'c1' } };
        return api;
    }

    it('drops a removed group from the group cache only', () => {
        const api = createApiWithCaches();
        api._parseEventdata({ events: { 0: { pushEventType: 'GROUP_REMOVED', group: { id: 'g1' } } } });
        assert.deepStrictEqual(Object.keys(api.groups), []);
        assert.deepStrictEqual(Object.keys(api.clients), ['c1']);
    });

    it('drops a removed client from the client cache only', () => {
        const api = createApiWithCaches();
        api._parseEventdata({ events: { 0: { pushEventType: 'CLIENT_REMOVED', client: { id: 'c1' } } } });
        assert.deepStrictEqual(Object.keys(api.clients), []);
        assert.deepStrictEqual(Object.keys(api.groups), ['g1']);
    });
});
