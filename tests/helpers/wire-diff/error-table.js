/**
 * The error answers every wire method is run against, and the table test that runs them.
 *
 * Every endpoint method goes through the kernel's reply decoder, so each must surface the same four failures with
 * Zalo's code and message intact: an outer error, an inner (session-encrypted) error, an HTTP 500 and a reply that
 * does not decrypt. A method that swallows, rewraps or drops the code of one of them is the regression this
 * catches. One test per area runs every method against every answer and lists every mismatch at once.
 */
import assert from "node:assert/strict";
import { checkTable } from "../table.js";

/**
 * The four error answers and what each must throw, as `{label, error, expected}`.
 *
 * @param {{outer?: string, inner?: string}} [messages] - the messages Zalo's error carries
 * @returns {{label: string, error: object, expected: {message: string, code: number|null}}[]}
 */
export function errorAnswers({ outer = "outer failure", inner = "inner failure" } = {}) {
    return [
        {
            label: "an outer error",
            error: { outer: { error_code: 102, error_message: outer } },
            expected: { message: outer, code: 102 },
        },
        {
            label: "an inner error",
            error: { inner: { error_code: 114, error_message: inner } },
            expected: { message: inner, code: 114 },
        },
        { label: "HTTP 500", error: { status: 500 }, expected: { message: "HTTP 500", code: null } },
        {
            label: "an undecryptable data",
            error: { undecryptable: true },
            expected: { message: "Failed to parse response data", code: null },
        },
    ];
}

/** The default answers: {@link errorAnswers} with its default messages. */
export const ERROR_ANSWERS = errorAnswers();

/**
 * Run every `[method, args]` call against every answer and fail once, listing each method and answer whose error
 * is not the expected `{message, code}`.
 *
 * @param {{run: Function}} wire - an open wire harness (./index.js `openWire`)
 * @param {Array<[string, unknown[]|Function, string?]>} calls - `[method, args, label?]` (`args` as `wire.run` takes
 *   them: a function gets a fresh array per run); the label names the call in the
 *   failure message (default: the method)
 * @param {ReturnType<typeof errorAnswers>} [answers]
 * @returns {Promise<void>}
 */
export async function checkErrorTable(wire, calls, answers = ERROR_ANSWERS) {
    assert.ok(calls.length > 0, "no method to run");
    const rows = calls.flatMap(([method, args, label = method]) =>
        answers.map((answer) => ({ method, args, label, answer })),
    );
    await checkTable(
        rows,
        (r) => `${r.label}, ${r.answer.label}`,
        async ({ method, args, answer }) => {
            const rec = await wire.run(method, args, { error: answer.error });
            assert.deepEqual(rec.own.error, answer.expected);
        },
    );
}
