// Manual smoke test, run by hand after `npm run build-backend`.
// node --inspect-brk tools/<this file>

if (!process.argv || !process.argv[2]) {
    console.log('run like this "node test_getAuthToken.js ACCESSPOINTGTIN [PIN]"');
}

const apiClass = require('../build/lib/hmCloudAPI').HmCloudAPI;
const api = new apiClass(process.argv[2], process.argv[3]);

console.log('------ test start --------');

(async () => {
    try {
        console.log('getHomematicHosts:');
        await api.getHomematicHosts();
        console.log('1st:');
        await api.auth1connectionRequest();
        console.log('2nd:');
        while (!(await api.auth2isRequestAcknowledged())) {
            console.log('press blue button...');
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        console.log('3rd:');
        await api.auth3requestAuthToken();

        console.log('config :');
        console.log(api.getSaveData());
    } catch (e) {
        console.error(e);
    }
})();
