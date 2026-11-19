// Правила те же, что в самом umbot (eslint.config.js фреймворка), any запрещён.
const eslint = require('@eslint/js');
const tseslint = require('typescript-eslint');
const globals = require('globals');

module.exports = [
    {
        ignores: ['node_modules/**', 'dist/**', 'coverage/**', 'json/**', 'data/**'],
    },
    {
        files: ['**/*.js'],
        languageOptions: {
            sourceType: 'commonjs',
            globals: { ...globals.node },
        },
        rules: eslint.configs.recommended.rules,
    },
    {
        files: ['**/*.ts'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            parser: tseslint.parser,
            parserOptions: {
                projectService: true,
                tsconfigRootDir: __dirname,
            },
            globals: { ...globals.node, ...globals.es2023 },
        },
        plugins: {
            '@typescript-eslint': tseslint.plugin,
            security: require('eslint-plugin-security'),
        },
        rules: {
            ...eslint.configs.recommended.rules,
            ...tseslint.configs.recommended.rules,
            ...require('eslint-config-prettier').rules,

            'security/detect-unsafe-regex': 'error',

            '@typescript-eslint/explicit-function-return-type': 'warn',
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/ban-ts-comment': 'error',
            '@typescript-eslint/no-misused-promises': [
                'error',
                {
                    checksVoidReturn: {
                        attributes: false,
                        properties: false,
                        returns: false,
                        arguments: false,
                    },
                },
            ],
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/await-thenable': 'error',
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
            ],

            'require-atomic-updates': 'error',
            curly: ['error', 'all'],
            'max-lines-per-function': ['warn', { max: 100 }],
            'no-unused-vars': 'off',
            'no-unused-private-class-members': 'error',
            'no-eval': 'error',
            'no-implied-eval': 'error',
            'no-new-func': 'error',
            'prefer-const': 'error',
            'no-param-reassign': 'warn',
            'no-console': ['warn', { allow: ['warn', 'error'] }],
            complexity: ['warn', { max: 20, variant: 'classic' }],
            'max-depth': ['warn', { max: 4 }],
        },
    },
    {
        files: ['tests/**/*.ts'],
        languageOptions: {
            globals: { ...globals.jest },
        },
        rules: {
            'require-atomic-updates': 'off',
            'max-lines-per-function': 'off',
        },
    },
];
