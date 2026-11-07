/**
 * The key layer's helper process (run by ./providers.js with `spawnSync`): the work that is asynchronous by nature,
 * done here so the stores that read secret files stay synchronous.
 *
 *  - `kms`    the task arrives as JSON on stdin; the reply is one JSON line on stdout.
 *  - `prompt` asks for the storage passphrase on the terminal (stdin is the terminal, the prompt goes to stderr); the
 *             reply carries it back on stdout, a pipe to the parent only.
 *
 * Nothing is written anywhere else, and an error reply carries a message, never key material.
 */
import { readSecretFromStream, promptSecret } from "../../utils/secret-input.js";
import { runKmsTask } from "./kms.js";

const reply = (value) => process.stdout.write(JSON.stringify(value) + "\n");

async function main(op) {
    if (op === "kms") {
        const task = JSON.parse(await readSecretFromStream(process.stdin));
        return { ok: true, data: await runKmsTask(task, testDeps(task)) };
    }
    if (op === "prompt") {
        const task = JSON.parse(process.env.ZALO_KEYSTORE_TASK || "{}");
        const first = await promptSecret("Storage passphrase: ");
        if (task.confirm) {
            const again = await promptSecret("Repeat the passphrase: ");
            if (again !== first) return { ok: false, error: "passphrase: the two entries differ", code: "CONFIG" };
        }
        return { ok: true, passphrase: first };
    }
    return { ok: false, error: `unknown key worker task "${op}"`, code: "CONFIG" };
}

/**
 * The offline test sandbox's stand-in backend (`kms.backend: "test"`), so the child-process bridge is tested end to end
 * without a cloud account. Refused outside the sandbox, like the `test` provider.
 */
function testDeps(task) {
    if (task.options?.backend !== "test") return {};
    return { backends: { test: testBackend() } };
}

function testBackend() {
    return {
        async wrap(plain, ctx) {
            const { inTestSandbox } = await import("./providers.js");
            if (!inTestSandbox()) throw new Error("the test kms backend exists only in the offline test sandbox");
            const { wrapKey } = await import("./container.js");
            return wrapKey(await testKey(), plain, `kms-test|${ctx.ref}`);
        },
        async unwrap(blob, ctx) {
            const { inTestSandbox } = await import("./providers.js");
            if (!inTestSandbox()) throw new Error("the test kms backend exists only in the offline test sandbox");
            const { unwrapKey } = await import("./container.js");
            return unwrapKey(await testKey(), blob, `kms-test|${ctx.ref}`);
        },
    };
}

async function testKey() {
    const { createHash } = await import("node:crypto");
    return createHash("sha256")
        .update(`kms-test|${process.env.ZALO_KMS_TEST_SEED ?? ""}`)
        .digest();
}

main(process.argv[2])
    .then(reply)
    .catch((e) => {
        reply({
            ok: false,
            error: String(e?.message ?? e).slice(0, 300),
            // A refused decrypt (wrong key, edited blob) is WRONG_KEY; anything else (no SDK, no network, no
            // permission) says the service is out of reach.
            code:
                e?.code === "AUTH_FAILED" || /InvalidCiphertext|decrypt/i.test(e?.name ?? "")
                    ? "WRONG_KEY"
                    : "UNAVAILABLE",
        });
    });
