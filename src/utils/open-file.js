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

    // The Windows branch runs through a SHELL, and the path it is handed is
    // built from a Zalo-supplied filename. cmd.exe treats & ^ % and ` as
    // syntax, and sanitize() in sync-v2/media.js only strips the characters
    // Windows forbids in a filename — not the ones cmd.exe acts on. So an
    // attachment named `holiday&calc.exe.jpg` produced
    //     start "" C:\…\holiday&calc.exe.jpg
    // which cmd.exe splits at the &, running the second half as a command.
    // media.js now strips these too; this is the second line of defence,
    // because openFile() is also reachable from the MCP zalo_view_media tool
    // with a path this module did not build.
    if (isWin && SHELL_METACHARACTERS.test(filePath)) {
        console.error(`[open-file] Refusing to open a path containing shell metacharacters: ${filePath}`);
        return;
    }

    const cmds = { darwin: "open", win32: "start", linux: "xdg-open" };
    const cmd = cmds[platform()] || "xdg-open";
    // Windows "start" is a cmd.exe builtin, so it needs a shell; its first
    // argument is the window title, hence the empty string.
    execFile(cmd, isWin ? ["", filePath] : [filePath], { shell: isWin }, (err) => {
        if (err) console.error(`[open-file] Failed to open viewer: ${err.message}`);
    });
}

/**
 * Characters cmd.exe interprets rather than passes through. Exported so the
 * test can assert the exact set rather than restating it.
 */
export const SHELL_METACHARACTERS = /[&^%`!|<>"]/;
