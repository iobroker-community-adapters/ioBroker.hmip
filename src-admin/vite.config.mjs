import { defineConfig } from 'vite';
import federation from '@originjs/vite-plugin-federation';
import react from '@vitejs/plugin-react';

function makeShared(pkgs) {
    const result = {};
    pkgs.forEach(packageName => {
        result[packageName] = {
            requiredVersion: '*',
            singleton: true,
        };
    });
    return result;
}

export default defineConfig({
    plugins: [
        react(),
        federation({
            name: 'ConfigCustomHmipSet',
            filename: 'customComponents.js',
            exposes: {
                './Components': './src/Components.jsx',
            },
            shared: makeShared([
                '@iobroker/adapter-react-v5',
                '@iobroker/json-config',
                '@mui/icons-material',
                '@mui/material',
                '@mui/material/styles',
                '@mui/x-date-pickers',
                'prop-types',
                'react',
                'react-dom',
            ]),
        }),
    ],
    build: {
        outDir: 'build',
        modulePreload: false,
        target: 'esnext',
        minify: false,
        cssCodeSplit: false,
    },
    base: './',
    server: {
        port: 3000,
        proxy: {
            '/adapter': {
                target: 'http://localhost:8081',
                changeOrigin: true,
                secure: false,
                configure: (proxy, _options) => {
                    proxy.on('error', (err, _req, _res) => {
                        console.log('proxy error', err);
                    });
                    proxy.on('proxyReq', (proxyReq, req, _res) => {
                        console.log('Sending Request to the Target:', req.method, req.url);
                    });
                    proxy.on('proxyRes', (proxyRes, req, _res) => {
                        console.log('Received Response from the Target:', proxyRes.statusCode, req.url);
                    });
                },
            },
        },
    },
});
