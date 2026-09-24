import { deleteFoldersRecursive, copyFiles, npmInstall, buildReact } from '@iobroker/build-tools';

const srcAdmin = `${__dirname}/src-admin/`;

function adminClean(): void {
    deleteFoldersRecursive(`${__dirname}/admin/custom`);
    deleteFoldersRecursive(`${__dirname}/src-admin/build`);
}

function copyAllFiles(): void {
    copyFiles(['src-admin/build/customComponents.js'], 'admin/custom/');
    copyFiles(['src-admin/build/assets/**/*'], 'admin/custom/assets/');
    copyFiles(['src-admin/src/i18n/*.json'], 'admin/custom/i18n');
}

function fail(what: string): (e: unknown) => never {
    return (e: unknown) => {
        console.error(`Cannot ${what}: ${e as string}`);
        process.exit(1);
    };
}

if (process.argv.includes('--0-clean')) {
    adminClean();
} else if (process.argv.includes('--1-npm')) {
    npmInstall(srcAdmin).catch(fail('install npm'));
} else if (process.argv.includes('--2-compile')) {
    buildReact(srcAdmin, { rootDir: __dirname, vite: true }).catch(fail('compile react'));
} else if (process.argv.includes('--3-copy')) {
    copyAllFiles();
} else {
    adminClean();
    npmInstall(srcAdmin)
        .then(() => buildReact(srcAdmin, { rootDir: __dirname, vite: true }))
        .then(() => copyAllFiles())
        .catch(fail('build'));
}
