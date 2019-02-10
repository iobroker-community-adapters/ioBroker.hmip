// node --inspect-brk testterminal.js

const delay = require('delay');

const apiClass = require('./hm-cloud-api.js');
const api = new apiClass({
    authToken: 'xxxxxxxxxx',
    clientAuthToken: 'xxxxxxxxxxxxxxxxxxxxxxxx',
    clientId: 'xxxxxxxxxxxxxxxxxxx',
    accessPointSgtin: 'xxxxxxxxxxxxx',
    pin: undefined
});

console.log("------ test start --------");

(async () => {
    try {
        console.log("getHomematicHosts");
        await api.getHomematicHosts();

        await api.loadCurrentConfig();
        console.log("devices");
        console.log(api.devices);

        console.log("connect WS");
        await api.connectWebsocket();

        await delay(3000);
        console.log("switch on for 2sec");
        await api.deviceControlSetSwitchState('3014F711A00001D3C99C97A8', true);
        await delay(2000);
        console.log("switch off");
        await api.deviceControlSetSwitchState('3014F711A00001D3C99C97A8', false);    

        await delay(20000);
    } catch (e) {
        console.error(e);
    }
})();

