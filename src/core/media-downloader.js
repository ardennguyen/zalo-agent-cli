import fs from "fs";
import { join } from "path";
import { CONFIG_DIR } from "./credentials.js";
import { getActive } from "./accounts.js";
import { getApi } from "./zalo-client.js";

/**
 * Download an attachment from a given URL to the account's media directory.
 */
export async function downloadMedia(url, msgId, filename) {
    const activeAcc = getActive();
    if (!activeAcc) return null;

    const mediaDir = join(CONFIG_DIR, "accounts", activeAcc.ownId, "media");
    if (!fs.existsSync(mediaDir)) {
        fs.mkdirSync(mediaDir, { recursive: true });
    }

    const safeFilename = filename.replace(/[^a-zA-Z0-9.\-_]/g, "_");
    const destPath = join(mediaDir, `${msgId}_${safeFilename}`);

    if (fs.existsSync(destPath)) {
        return destPath; // already downloaded
    }

    try {
        const api = getApi();
        // zca-js doesn't natively expose fetch to us, but we can use global fetch
        // and attach the cookies if needed, though Zalo media URLs usually don't need auth
        // if they are public. If they need auth, we might need to use `request` from zca-js.
        // Actually, many Zalo image/file hrefs are fully authenticated via URL params.
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const buffer = await res.arrayBuffer();
        fs.writeFileSync(destPath, Buffer.from(buffer));
        return destPath;
    } catch (e) {
        // Silent fail to avoid disrupting message flow
        return null;
    }
}

/**
 * Parse message content and download any media attachments.
 * Mutates the message object by adding a `localPath` field.
 */
export async function processMessageMedia(message) {
    if (!message || !message.raw_data) return message;

    try {
        const raw = JSON.parse(message.raw_data);
        const content = typeof raw === "string" ? raw : raw.data?.content || raw.content;
        const msgType = Number(message.type || raw.data?.msgType || raw.msgType);

        if (typeof content === "object" && content !== null) {
            let url = content.href || content.normalUrl || content.url || content.voiceUrl || content.videoUrl;
            let filename = content.title || content.fileName || content.name;

            // Extract from params if nested
            if (!url && content.params) {
                url = content.params.href || content.params.voiceUrl || content.params.videoUrl;
            }

            if (url) {
                if (!filename) {
                    const ext = url.split("?")[0].split(".").pop() || "bin";
                    filename = `attachment.${ext.length <= 4 ? ext : "bin"}`;
                }

                // Append .png if it's an image without extension
                if (msgType === 2 && !filename.includes(".")) filename += ".jpg";
                if (msgType === 3 && !filename.includes(".")) filename += ".mp3";
                if (msgType === 5 && !filename.includes(".")) filename += ".mp4";

                const localPath = await downloadMedia(url, message.msgId, filename);
                if (localPath) {
                    message.localPath = localPath;
                }
            }
        }
    } catch (e) {
        // ignore JSON parse errors
    }

    return message;
}
