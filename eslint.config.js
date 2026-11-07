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
    WebAssembly: "readonly",
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
        // src/zalo is a library the application uses, never the other way round: nothing in it may import the
        // CLI's code (src/core, src/utils, src/commands, src/mcp, src/index.js). There is no core/utils/commands/mcp
        // folder inside src/zalo, so any number of `../` before those names leaves the layer; `index.js` reached
        // through `../` is the CLI's entry or the layer's own public entry, and neither belongs in an import here.
        // tests/unit/zalo-boundary.test.js checks the same, dynamic imports included.
        files: ["src/zalo/**/*.js"],
        rules: {
            "no-restricted-imports": [
                "error",
                {
                    patterns: [
                        {
                            regex: "^(\\.\\./)+(core|utils|commands|mcp)(/|$)",
                            message: "src/zalo must not import the application; have the caller pass it in.",
                        },
                        {
                            regex: "^(\\.\\./)+index\\.js$",
                            message: "src/zalo must not import src/index.js or its own public entry.",
                        },
                    ],
                },
            ],
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
