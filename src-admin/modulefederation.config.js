const { shared } = require('@iobroker/adapter-react-v5/modulefederation.admin.config');

module.exports = {
    name: 'ConfigCustomHmipSet',
    filename: 'customComponents.js',
    exposes: {
        './Components': './src/Components.jsx',
    },
    shared,
};
