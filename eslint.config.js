// The Node globals this code uses. `no-undef` is on, so an identifier that is
// neither imported nor listed here fails lint: a missing import in a rarely
// run branch used to pass lint and tests alike (a `warning` call in `oa
// login`'s timeout crashed with a ReferenceError from May until 2026-09-30,
// and another in `group settings` was caught only by review).
const NODE_GLOBALS = {
    console: "readonly",
    process: "readonly",
    Buffer: "readonly",
    URL: "readonly",
    URLSearchParams: "readonly",
    setTimeout: "readonly",
    clearTimeout: "readonly",
    setInterval: "readonly",
    clearInterval: "readonly",
    setImmediate: "readonly",
    clearImmediate: "readonly",
    queueMicrotask: "readonly",
    structuredClone: "readonly",
    fetch: "readonly",
    Request: "readonly",
    Response: "readonly",
    Headers: "readonly",
    AbortController: "readonly",
    AbortSignal: "readonly",
    TextDecoder: "readonly",
    TextEncoder: "readonly",
};

export default [
    {
        files: ["src/**/*.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "module",
            globals: NODE_GLOBALS,
        },
        rules: {
            "no-undef": "error",
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
        // Tests run under node:test and drive the CLI as a subprocess.
        files: ["tests/**/*.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "module",
            globals: NODE_GLOBALS,
        },
        rules: {
            "no-undef": "error",
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
