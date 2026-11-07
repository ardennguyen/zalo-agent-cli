/**
 * A secret a person hands a command at run time: read from standard input, or typed at a prompt that does not echo.
 *
 * Used for the account's zCloud key (`cloud get --key-stdin` / `--key-prompt`). The value is returned to the caller
 * and nothing else: it is never written to a file, a log, the shell history (it is never a flag's value) or the
 * output, and the caller drops it when its call ends.
 */

/**
 * Read all of a stream as text, trimmed.
 *
 * @param {NodeJS.ReadableStream} [stream]
 * @returns {Promise<string>}
 */
export async function readSecretFromStream(stream = process.stdin) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return Buffer.concat(chunks).toString("utf8").trim();
}

/**
 * Ask for a secret on the terminal without echoing it: the prompt goes to stderr (so `--json` stdout stays clean), the
 * keys typed are not shown, Enter ends it, Ctrl+C aborts.
 *
 * @param {string} prompt
 * @param {{input?: NodeJS.ReadStream, output?: NodeJS.WritableStream}} [io]
 * @returns {Promise<string>}
 * @throws {Error} when the input is not a terminal (use the stdin form), or on Ctrl+C
 */
export function promptSecret(prompt, { input = process.stdin, output = process.stderr } = {}) {
    if (!input.isTTY || typeof input.setRawMode !== "function") {
        return Promise.reject(new Error("no terminal to prompt on: pipe the secret to standard input instead"));
    }
    return new Promise((resolve, reject) => {
        let value = "";
        const done = (err) => {
            input.setRawMode(false);
            input.pause();
            input.removeListener("data", onData);
            output.write("\n");
            if (err) reject(err);
            else resolve(value.trim());
        };
        const onData = (buf) => {
            for (const ch of buf.toString("utf8")) {
                if (ch === "\r" || ch === "\n") return done();
                if (ch === "\u0003") return done(new Error("cancelled"));
                if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
                else value += ch;
            }
        };
        output.write(prompt);
        input.setRawMode(true);
        input.resume();
        input.on("data", onData);
    });
}
