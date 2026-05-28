/**
 * Download Zalo media (images, audio, video) to local filesystem, organized by thread name.
 * Folder structure: {downloadDir}/{threadName}/{date}_{time}_{sender}_{msgId}.{ext}
 * Cross-platform: opens media with system viewer (open/xdg-open/start).
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { platform } from "os";
import { execFile } from "child_process";
import { CONFIG_DIR } from "../core/credentials.js";

/** Default download directory when not configured */
const DEFAULT_DIR = join(CONFIG_DIR, "media");

/** Characters unsafe for filesystem paths — stripped from folder/file names */
const UNSAFE_CHARS = /[/\\:*?"<>|]/g;

/** Message types that have downloadable attachments */
const DOWNLOADABLE_TYPES = new Set(["image", "video", "audio", "voice", "gif", "file"]);

/** Extension lookup by content-type prefix */
const CONTENT_TYPE_MAP = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
};

/** Fallback extension by message type when URL and content-type give no clue */
const TYPE_DEFAULT_EXT = {
    image: "jpg",
    audio: "mp3",
    voice: "mp3",
    video: "mp4",
    gif: "gif",
    file: "bin",
};

/**
 * Sanitize a string for use as a filesystem name.
 * @param {string} name
 * @returns {string}
 */
function sanitize(name) {
    return (name || "unknown").replace(UNSAFE_CHARS, "_").trim() || "unknown";
}

/**
 * Guess file extension from URL, content-type, or message type.
 * @param {string} url
 * @param {string} [contentType]
 * @param {string} [msgType] - Normalized message type (image, audio, video, etc.)
 * @returns {string}
 */
function guessExtension(url, contentType, msgType) {
    // Try content-type first
    if (contentType) {
        const ct = contentType.split(";")[0].trim().toLowerCase();
        if (CONTENT_TYPE_MAP[ct]) return CONTENT_TYPE_MAP[ct];
    }
    // Try URL path extension
    const urlMatch = url.match(/\.(jpeg|jpg|png|gif|webp|bmp|mp3|m4a|aac|ogg|wav|mp4|webm|mov)(\?|$)/i);
    if (urlMatch) return urlMatch[1] === "jpeg" ? "jpg" : urlMatch[1].toLowerCase();
    // Fallback by message type
    return TYPE_DEFAULT_EXT[msgType] || "bin";
}

/**
 * Check if a message type is downloadable media.
 * @param {string} type - Normalized message type
 * @returns {boolean}
 */
export function isDownloadableMedia(type) {
    return DOWNLOADABLE_TYPES.has(type);
}

/**
 * Build the folder name for a thread.
 * Groups: thread display name. DMs: "DM_{senderName}".
 * @param {object} message - Normalized message
 * @param {string} [threadName] - Resolved thread name from cache
 * @returns {string}
 */
function buildFolderName(message, threadName) {
    if (message.threadType === "group") {
        return sanitize(threadName || message.threadId);
    }
    return sanitize(`DM_${threadName || message.senderName || message.senderId}`);
}

/**
 * Build a descriptive filename from message metadata.
 * Format: {YYYY-MM-DD}_{HH-mm}_{sender}_{msgId}.{ext}
 * @param {object} message
 * @param {string} ext - File extension
 * @returns {string}
 */
function buildFileName(message, ext) {
    const d = new Date(message.timestamp);
    const date = d.toISOString().slice(0, 10); // YYYY-MM-DD
    const time = `${String(d.getHours()).padStart(2, "0")}-${String(d.getMinutes()).padStart(2, "0")}`;
    const sender = sanitize(message.senderName || message.senderId);
    const msgId = (message.id || "noId").slice(-8); // last 8 chars for brevity
    return `${date}_${time}_${sender}_${msgId}.${ext}`;
}

/**
 * Open a file with the system's default viewer (cross-platform).
 * Exported for use by MCP tools.
 * @param {string} filePath
 */
export function openFile(filePath) {
    const isWin = platform() === "win32";
    const cmds = { darwin: "open", win32: "start", linux: "xdg-open" };
    const cmd = cmds[platform()] || "xdg-open";
    // Windows "start" is a cmd.exe builtin — needs shell: true
    execFile(cmd, isWin ? ["", filePath] : [filePath], { shell: isWin }, (err) => {
        if (err) console.error(`[media-dl] Failed to open viewer: ${err.message}`);
    });
}

/**
 * Auto-download media in background when a message arrives.
 * Non-blocking — fires and forgets. Mutates message.attachment.localPath on success.
 * @param {object} message - Normalized message (will be mutated with localPath)
 * @param {object} [options]
 * @param {string} [options.downloadDir] - Base download directory
 * @param {string} [options.threadName] - Thread display name from cache
 */
export function autoDownloadMedia(message, options = {}) {
    if (!message.attachment?.url) return;
    downloadMedia(message, { ...options, autoOpen: false }).then(
        (result) => {
            message.attachment.localPath = result.path;
            console.error(`[media-dl] Saved: ${result.path}`);
        },
        (err) => {
            console.error(`[media-dl] Auto-download failed: ${err.message}`);
        },
    );
}

/**
 * Download media from URL and save to organized local folder.
 * @param {object} message - Normalized message with attachment.url
 * @param {object} [options]
 * @param {string} [options.downloadDir] - Base download directory
 * @param {boolean} [options.autoOpen] - Open media with system viewer after download
 * @param {string} [options.threadName] - Thread display name from cache
 * @returns {Promise<{ success: boolean, path: string, folder: string, fileName: string, mediaType: string }>}
 */
export async function downloadMedia(message, options = {}) {
    const url = message.attachment?.url;
    if (!url) throw new Error("Message has no attachment URL");

    const baseDir = options.downloadDir || DEFAULT_DIR;
    const folder = buildFolderName(message, options.threadName);
    const folderPath = join(baseDir, folder);
    mkdirSync(folderPath, { recursive: true });

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);

    const contentType = response.headers.get("content-type") || "";
    const msgType = message.type || "file";
    const ext = guessExtension(url, contentType, msgType);
    const fileName = buildFileName(message, ext);
    const filePath = join(folderPath, fileName);

    const buffer = Buffer.from(await response.arrayBuffer());
    writeFileSync(filePath, buffer);

    if (options.autoOpen) {
        openFile(filePath);
    }

    return { success: true, path: filePath, folder, fileName, mediaType: msgType };
}
