// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';
import globals from 'globals';

export default tseslint.config(
    // Ignore compiled output and dependencies
    {
        ignores: ['dist/**', 'node_modules/**', 'release/**'],
    },

    // Base JS rules for all files
    eslint.configs.recommended,

    // ─── Main process + Preload (Node.js) ─────────────────────────────────────
    {
        files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'src/types/**/*.ts'],
        extends: [...tseslint.configs.recommended],
        languageOptions: {
            globals: {
                ...globals.node,
            },
        },
        rules: {
            // Key rule: catches the as any pattern that hid the RestoreTarget bug
            '@typescript-eslint/no-explicit-any': 'warn',
            // Catches dead variables / unused store properties
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            // require() is unavoidable in some Electron patterns
            '@typescript-eslint/no-require-imports': 'warn',
            'no-console': 'off',
        },
    },

    // ─── Renderer: Vue 3 SFC files ────────────────────────────────────────────
    ...pluginVue.configs['flat/essential'].map(config => ({
        ...config,
        files: ['src/renderer/**/*.vue'],
    })),
    {
        files: ['src/renderer/**/*.vue'],
        languageOptions: {
            globals: {
                ...globals.browser,
                // Electron renderer has access to process (exposed by preload or Node integration)
                process: 'readonly',
            },
            parserOptions: {
                parser: tseslint.parser,
                extraFileExtensions: ['.vue'],
                sourceType: 'module',
            },
        },
        plugins: {
            '@typescript-eslint': tseslint.plugin,
        },
        rules: {
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            '@typescript-eslint/no-explicit-any': 'warn',
            'no-unused-vars': 'off', // delegated to @typescript-eslint/no-unused-vars
            'no-console': 'off',
            // Single-word component names are fine for this project (About, Dashboard, etc.)
            'vue/multi-word-component-names': 'off',
            // Transition wrapper check is too strict for this codebase's animation patterns
            'vue/require-toggle-inside-transition': 'warn',
        },
    },

    // ─── Renderer: TypeScript files (non-Vue) ─────────────────────────────────
    {
        files: ['src/renderer/**/*.ts'],
        extends: [...tseslint.configs.recommended],
        languageOptions: {
            globals: {
                ...globals.browser,
            },
        },
        rules: {
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            // env.d.ts uses {} as intersection type — standard Vue shim pattern, not a real issue
            '@typescript-eslint/no-empty-object-type': 'off',
            'no-console': 'off',
        },
    },

    // ─── Type declaration shims ────────────────────────────────────────────────
    {
        files: ['src/types/**/*.d.ts', 'src/renderer/src/**/*.d.ts'],
        rules: {
            // Shim files legitimately use {} and any for Vue module declarations
            '@typescript-eslint/no-empty-object-type': 'off',
            '@typescript-eslint/no-explicit-any': 'off',
        },
    },
);
