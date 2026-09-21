/**
 * Open a file with the operating system's default application.
 *
 * Lives in utils rather than next to a downloader because opening a file has
 * nothing to do with fetching one, and both the MCP server and the CLI want it.
 */

import { platform } from "os";
import { execFile } from "child_process";

/**
 * Open a local file with the system viewer. Fire-and-forget: a missing viewer
 * is reported, never thrown, because failing to preview a file must not fail
 * the command that produced it.
 *
 * @param {string} filePath
 */
export function openFile(filePath) {
    const isWin = platform() === "win32";
    const cmds = { darwin: "open", win32: "start", linux: "xdg-open" };
    const cmd = cmds[platform()] || "xdg-open";
    // Windows "start" is a cmd.exe builtin, so it needs a shell; its first
    // argument is the window title, hence the empty string.
    execFile(cmd, isWin ? ["", filePath] : [filePath], { shell: isWin }, (err) => {
        if (err) console.error(`[open-file] Failed to open viewer: ${err.message}`);
    });
}
