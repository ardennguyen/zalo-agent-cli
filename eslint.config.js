export default [
    {
        files: ["src/**/*.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "module",
            globals: {
                console: "readonly",
                process: "readonly",
                Buffer: "readonly",
                URL: "readonly",
                URLSearchParams: "readonly",
            },
        },
        rules: {
            "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
            "no-console": "off",
            "no-constant-condition": "warn",
            "no-debugger": "error",
            "no-duplicate-imports": "error",
            "no-var": "error",
            "prefer-const": "warn",
            eqeqeq: ["warn", "always"],
        },
    },
    {
        // Tests run under node:test and drive the CLI as a subprocess, so
        // they need the same globals plus the timer functions.
        files: ["tests/**/*.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "module",
            globals: {
                console: "readonly",
                process: "readonly",
                Buffer: "readonly",
                URL: "readonly",
                URLSearchParams: "readonly",
                setTimeout: "readonly",
                clearTimeout: "readonly",
                fetch: "readonly",
            },
        },
        rules: {
            "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
            "no-console": "off",
            "no-debugger": "error",
            "no-duplicate-imports": "error",
            "no-var": "error",
            "prefer-const": "warn",
            eqeqeq: ["warn", "always"],
        },
    },
    {
        ignores: ["node_modules/", "plans/", "*.config.js"],
    },
];
