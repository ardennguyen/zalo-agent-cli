/**
 * Let a long run be stopped with Ctrl+C without leaving work half-done.
 *
 * The first Ctrl+C asks the run to stop (it aborts the signal the run was given, and the run puts its own
 * house in order: a restore releases the sessions it opened on the phone). A second Ctrl+C is the way out when
 * that is stuck, and exits at once with the conventional 130.
 */

/**
 * Run `run(signal)` with a SIGINT handler installed for exactly as long as it takes.
 *
 * @template T
 * @param {(signal: AbortSignal) => Promise<T>} run
 * @param {object} [opts]
 * @param {() => void} [opts.onStop] called on the first Ctrl+C (say what is happening)
 * @param {{on: Function, off: Function, exit: (code: number) => void}} [opts.proc] the process, replaceable in a test
 * @returns {Promise<T>} what `run` resolved to
 */
export async function whileInterruptible(run, { onStop = () => {}, proc = process } = {}) {
    const controller = new AbortController();
    let presses = 0;
    const onSigint = () => {
        presses++;
        if (presses === 1) {
            onStop();
            controller.abort();
        } else {
            proc.exit(130);
        }
    };
    proc.on("SIGINT", onSigint);
    try {
        return await run(controller.signal);
    } finally {
        proc.off("SIGINT", onSigint);
    }
}
