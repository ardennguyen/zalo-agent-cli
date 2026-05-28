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
        ignores: ["node_modules/", "plans/", "*.config.js"],
    },
];
