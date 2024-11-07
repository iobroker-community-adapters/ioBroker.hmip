const engineHelper = require('@iobroker/legacy-testing/engineHelper');
const guiHelper = require('@iobroker/legacy-testing/guiHelper');
const adapterName = require('../package.json').name.replace('iobroker.', '');
let gPage;
const rootDir = `${__dirname}/../`;

describe('test-admin-gui', () => {
    before(async function () {
        this.timeout(240_000);

        // install js-controller, web and vis-2-beta
        await engineHelper.startIoBrokerAdapters({ adapters: ['admin', adapterName] });
        await engineHelper;
        const { page } = await guiHelper.startBrowser(
            adapterName,
            rootDir,
            process.env.CI === 'true',
            `/#tab-instances/config/system.adapter.${adapterName}.0`,
        );
        gPage = page;
    });

    it('Check admin server', async function () {
        this.timeout(240_000);
        return new Promise(resolve =>
            setTimeout(async () => {
                try {
                    await gPage.waitForSelector('.slow-connection-cancel', { timeout: 55_000 });
                    await gPage.click('.slow-connection-cancel');
                } catch {
                    // ignore
                }


                await gPage.waitForSelector('.hmip-admin-component', { timeout: 55_000 });
                await guiHelper.screenshot(rootDir, null, '01_started');
                resolve();
            }, 1000),
        );
    });

    after(async function () {
        this.timeout(5000);
        await guiHelper.stopBrowser();
        console.log('BROWSER stopped');
        await engineHelper.stopIoBrokerAdapters();
        console.log('ioBroker stopped');
    });
});
