/**
 * The `kms` provider's backends: the keyring's master key is wrapped by a key that never leaves a cloud key service,
 * reached with the machine's own identity (an instance role, a workload identity, a managed identity, a Vault token
 * from the agent). One backend per service:
 *
 *  - `aws`   AWS KMS `Encrypt`/`Decrypt` (`@aws-sdk/client-kms`), the keyring ref as encryption context.
 *  - `gcp`   Google Cloud KMS `encrypt`/`decrypt` (`@google-cloud/kms`), the ref as additional authenticated data.
 *  - `azure` Azure Key Vault `wrapKey`/`unwrapKey` RSA-OAEP-256 (`@azure/keyvault-keys` + `@azure/identity`).
 *  - `vault` HashiCorp Vault transit `encrypt`/`decrypt` over its HTTP API (no SDK; `VAULT_ADDR`, `VAULT_TOKEN`).
 *
 * The SDKs are optional peer dependencies, imported only when their backend is used: install the one you need next to
 * the CLI (`npm i -g @aws-sdk/client-kms`). These run inside ./worker.js, so their asynchronous calls never reach the
 * synchronous stores. Unverified against the live services in this release: the calls follow each SDK's documented
 * shape and are tested with fakes.
 */
import { readFileSync } from "node:fs";

const APP = "zalo-agent-cli";

/** @param {string} name */
async function load(name) {
    try {
        return await import(name);
    } catch (e) {
        const err = new Error(
            `the kms backend needs ${name}, which is not installed: install it next to zalo-agent-cli (npm i -g ${name})`,
        );
        err.code = e?.code === "ERR_MODULE_NOT_FOUND" ? "UNAVAILABLE" : "UNAVAILABLE";
        throw err;
    }
}

/**
 * The backends, each `{wrap(plain: Buffer, ctx), unwrap(blob: string, ctx)}` returning a string / a Buffer.
 *
 * @param {object} [deps] - for tests: `importer` (name -> module), `fetchImpl`, `env`
 * @returns {Record<string, {wrap: Function, unwrap: Function}>}
 */
export function createKmsBackends({ importer = load, fetchImpl = fetch, env = process.env } = {}) {
    return {
        aws: {
            async wrap(plain, { options, ref }) {
                const { KMSClient, EncryptCommand } = await importer("@aws-sdk/client-kms");
                const client = new KMSClient(options.region ? { region: options.region } : {});
                const out = await client.send(
                    new EncryptCommand({
                        KeyId: options.key,
                        Plaintext: plain,
                        EncryptionContext: { app: APP, keyring: ref },
                    }),
                );
                return Buffer.from(out.CiphertextBlob).toString("base64");
            },
            async unwrap(blob, { options, ref }) {
                const { KMSClient, DecryptCommand } = await importer("@aws-sdk/client-kms");
                const client = new KMSClient(options.region ? { region: options.region } : {});
                const out = await client.send(
                    new DecryptCommand({
                        KeyId: options.key,
                        CiphertextBlob: Buffer.from(blob, "base64"),
                        EncryptionContext: { app: APP, keyring: ref },
                    }),
                );
                return Buffer.from(out.Plaintext);
            },
        },
        gcp: {
            async wrap(plain, { options, ref }) {
                const { KeyManagementServiceClient } = await importer("@google-cloud/kms");
                const client = new KeyManagementServiceClient();
                const [out] = await client.encrypt({
                    name: options.key,
                    plaintext: plain,
                    additionalAuthenticatedData: Buffer.from(`${APP}:${ref}`),
                });
                return Buffer.from(out.ciphertext).toString("base64");
            },
            async unwrap(blob, { options, ref }) {
                const { KeyManagementServiceClient } = await importer("@google-cloud/kms");
                const client = new KeyManagementServiceClient();
                const [out] = await client.decrypt({
                    name: options.key,
                    ciphertext: Buffer.from(blob, "base64"),
                    additionalAuthenticatedData: Buffer.from(`${APP}:${ref}`),
                });
                return Buffer.from(out.plaintext);
            },
        },
        azure: {
            async wrap(plain, { options }) {
                const client = await azureClient(options);
                const out = await client.wrapKey("RSA-OAEP-256", plain);
                return Buffer.from(out.result).toString("base64");
            },
            async unwrap(blob, { options }) {
                const client = await azureClient(options);
                const out = await client.unwrapKey("RSA-OAEP-256", Buffer.from(blob, "base64"));
                return Buffer.from(out.result);
            },
        },
        vault: {
            async wrap(plain, ctx) {
                const data = await vaultCall(ctx, "encrypt", { plaintext: plain.toString("base64") });
                if (typeof data?.ciphertext !== "string") throw new Error("vault: the answer carried no ciphertext");
                return data.ciphertext;
            },
            async unwrap(blob, ctx) {
                const data = await vaultCall(ctx, "decrypt", { ciphertext: blob });
                if (typeof data?.plaintext !== "string") throw new Error("vault: the answer carried no plaintext");
                return Buffer.from(data.plaintext, "base64");
            },
        },
    };

    async function azureClient(options) {
        const { DefaultAzureCredential } = await importer("@azure/identity");
        const { CryptographyClient } = await importer("@azure/keyvault-keys");
        return new CryptographyClient(options.key, new DefaultAzureCredential());
    }

    async function vaultCall({ options, ref }, op, body) {
        const addr = String(options.address ?? env.VAULT_ADDR ?? "").replace(/\/+$/, "");
        if (!addr) throw new Error("vault: no address (storage.json kms.address or VAULT_ADDR)");
        const token = options.tokenFile ? readFileSync(options.tokenFile, "utf8").trim() : env.VAULT_TOKEN;
        if (!token) throw new Error("vault: no token (VAULT_TOKEN or storage.json kms.tokenFile)");
        const mount = options.mount ?? "transit";
        const headers = { "X-Vault-Token": token, "Content-Type": "application/json" };
        if (options.namespace ?? env.VAULT_NAMESPACE)
            headers["X-Vault-Namespace"] = options.namespace ?? env.VAULT_NAMESPACE;
        if (options.derived) body.context = Buffer.from(`${APP}:${ref}`).toString("base64");
        const res = await fetchImpl(`${addr}/v1/${mount}/${op}/${encodeURIComponent(options.key)}`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`vault: ${op} answered HTTP ${res.status}`);
        return (await res.json())?.data;
    }
}

/**
 * Wrap or unwrap with the configured backend.
 *
 * @param {{action: "wrap"|"unwrap", options: object, ref: string, data: string}} task - `data` is base64 for a wrap,
 *   the stored blob for an unwrap
 * @param {object} [deps] - passed to {@link createKmsBackends}, plus `backends`
 * @returns {Promise<string>} the blob (wrap) or the key as base64 (unwrap)
 */
export async function runKmsTask(task, deps = {}) {
    const backends = deps.backends ?? createKmsBackends(deps);
    const backend = backends[task.options?.backend];
    if (!backend) throw new Error(`kms: unknown backend "${task.options?.backend}" (aws, gcp, azure or vault)`);
    if (!task.options?.key) throw new Error("kms: no key configured (storage.json kms.key)");
    if (task.action === "wrap") return backend.wrap(Buffer.from(task.data, "base64"), task);
    const plain = await backend.unwrap(task.data, task);
    return Buffer.from(plain).toString("base64");
}
