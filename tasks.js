const { deleteFoldersRecursive, copyFiles, npmInstall, buildCraco } = require('@iobroker/build-tools');

const srcAdmin = `${__dirname}/src-admin/`;

function admin0Clean() {
    deleteFoldersRecursive(`${__dirname}/admin/custom`);
    deleteFoldersRecursive(`${__dirname}/src-admin/build`);
}

function copyAllFiles() {
    copyFiles(
        [
            'src-admin/build/static/js/*.js',
            '!src-admin/build/static/js/vendors*.js',
            '!src-admin/build/static/js/src_bootstrap_*.js',
        ],
        'admin/custom/static/js',
    );
    copyFiles(['src-admin/build/static/js/*_emotion_react_dist_*.js'], 'admin/custom/static/js');
    copyFiles(['src-admin/build/static/js/*_material_styles_createTheme_*.js'], 'admin/custom/static/js');
    copyFiles(['src-admin/build/static/js/*_material_styles_ThemeProvider_*.js'], 'admin/custom/static/js');
    copyFiles(
        [
            'src-admin/build/static/js/*.map',
            '!src-admin/build/static/js/vendors*.map',
            '!src-admin/build/static/js/src_bootstrap_*.map',
        ],
        'admin/custom/static/js',
    );
    copyFiles(['src-admin/build/customComponents.js'], 'admin/custom');
    copyFiles(['src-admin/build/customComponents.js.map'], 'admin/custom');
    copyFiles(['src-admin/src/i18n/*.json'], 'admin/custom/i18n');
}

if (process.argv.find(arg => arg.replace(/^--/, '') === '0-clean')) {
    admin0Clean();
} else if (process.argv.find(arg => arg.replace(/^--/, '') === '1-npm')) {
    npmInstall(srcAdmin).catch(e => console.error(`Cannot install: ${e}`));
} else if (process.argv.find(arg => arg.replace(/^--/, '') === '2-compile')) {
    buildCraco(srcAdmin, { rootDir: __dirname }).catch(e => console.error(`Cannot compile: ${e}`));
} else if (process.argv.find(arg => arg.replace(/^--/, '') === '3-copy')) {
    copyAllFiles();
} else {
    admin0Clean();

    npmInstall(srcAdmin).then(async () => {
        await buildCraco(srcAdmin, { rootDir: __dirname });
        copyAllFiles();
    });
}
