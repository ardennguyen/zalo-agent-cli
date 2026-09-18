import fs from "fs";
import { resolve } from "path";
import crypto from "crypto";
import { CONFIG_DIR } from "./credentials.js";
import { insertMessage } from "./db.js";

function resolveAccountDir(accountName) {
    return resolve(CONFIG_DIR, "accounts", accountName);
}

export class SyncManager {
    constructor(api, accountName) {
        this.api = api;
        this.accountName = accountName;
        this.accountDir = resolveAccountDir(accountName);
        this.syncSessionDir = resolve(this.accountDir, "sync");
        if (!fs.existsSync(this.syncSessionDir)) {
            fs.mkdirSync(this.syncSessionDir, { recursive: true });
        }
        this.keys = this._loadOrGenerateKeys();
    }

    _loadOrGenerateKeys() {
        const keyFile = resolve(this.syncSessionDir, "rsa_keys.json");
        if (fs.existsSync(keyFile)) {
            return JSON.parse(fs.readFileSync(keyFile, "utf8"));
        }
        const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
            modulusLength: 2048,
            publicKeyEncoding: { type: "spki", format: "pem" },
            privateKeyEncoding: { type: "pkcs8", format: "pem" },
        });
        const pubKeyRaw = publicKey
            .replace(/-----BEGIN PUBLIC KEY-----/g, "")
            .replace(/-----END PUBLIC KEY-----/g, "")
            .replace(/\n/g, "");
        const keys = { publicKey: pubKeyRaw, privateKey };
        fs.writeFileSync(keyFile, JSON.stringify(keys), "utf8");
        return keys;
    }

    async pollSync() {
        try {
            console.log(`[Sync] Polling pullMobileMsg...`);
            let fromSeqId = 0;
            const res = await this.api.pullMobileMsg(this.keys.publicKey, fromSeqId, 0, "");
            if (res && res.data) {
                console.log(`[Sync] Received sync data!`);
                await this.processSyncData(res.data);
                // Also acknowledge deletion
                await this.api.deleteSnapshotMobileMsg(this.keys.publicKey);
            }
        } catch (e) {
            console.error(`[Sync] Poll error:`, e.message);
        }
    }

    async processSyncData(encryptedDataStr) {
        // Zalo sync data is encrypted with the RSA public key we sent.
        // Wait, is it encrypted with RSA or AES?
        // Zalo uses the RSA public key to send an AES key, and then encrypts the payload with that AES key.
        // Since we don't know the exact crypto struct yet without reversing it, we'll log it first!
        const dumpFile = resolve(this.syncSessionDir, `sync_dump_${Date.now()}.json`);
        fs.writeFileSync(dumpFile, JSON.stringify(encryptedDataStr), "utf8");
        console.log(`[Sync] Dumped sync data to ${dumpFile}`);
    }
}
