import config from '@iobroker/eslint-config';

export default [
    ...config,
    {
        languageOptions: {
            parserOptions: {
                projectService: {
                    allowDefaultProject: ['*.mjs', 'api/*.js', '*.js'],
                },
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
    {
        rules: {
            '@typescript-eslint/no-require-imports': 'off',
            'jsdoc/require-jsdoc': 'off',
            'jsdoc/require-param': 'off',
        },
    },
    {
        ignores: ['node_modules/', 'admin/', 'src-admin/', 'test/'],
    },
];
