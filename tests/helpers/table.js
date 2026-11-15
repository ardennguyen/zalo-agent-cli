/**
 * Table-driven checks: one test, every row checked, every failing row reported.
 *
 * A loop of plain `assert` calls stops at the first failing row and hides the rest; one `it()` per row turns a
 * table of inputs into hundreds of test cases. {@link checkTable} runs the check on every row, collects each
 * failure under the row's label, and fails once with all of them listed.
 */
import assert from "node:assert/strict";

/**
 * A failure's message, indented under its row: the assertion's own message, or, when it wrote none, what it
 * compared.
 */
function describeFailure(label, e) {
    let text = String(e?.message ?? e).trim();
    if (e?.generatedMessage && "actual" in e) {
        const show = (v) => (JSON.stringify(v) ?? String(v)).slice(0, 300);
        text = `${e.operator}: got ${show(e.actual)}, want ${show(e.expected)}`;
    }
    return `- ${label}: ${text.replace(/\n/g, "\n    ")}`;
}

/**
 * Run `check` on every row and fail with every row that threw.
 *
 * @template R
 * @param {Iterable<R>} rows
 * @param {(row: R) => string} labelOf - names the row in the failure message
 * @param {(row: R) => unknown | Promise<unknown>} check - throws (an assert) when the row is wrong
 * @returns {Promise<void>}
 */
export async function checkTable(rows, labelOf, check) {
    const list = [...rows];
    const failures = [];
    for (const row of list) {
        try {
            await check(row);
        } catch (e) {
            failures.push(describeFailure(labelOf(row), e));
        }
    }
    assert.ok(list.length > 0, "the table has no rows");
    assert.equal(failures.length, 0, `${failures.length} of ${list.length} row(s) failed:\n${failures.join("\n")}`);
}

/**
 * {@link checkTable} for synchronous checks, usable in a synchronous test.
 *
 * @template R
 * @param {Iterable<R>} rows
 * @param {(row: R) => string} labelOf
 * @param {(row: R) => unknown} check
 */
export function checkTableSync(rows, labelOf, check) {
    const list = [...rows];
    const failures = [];
    for (const row of list) {
        try {
            check(row);
        } catch (e) {
            failures.push(describeFailure(labelOf(row), e));
        }
    }
    assert.ok(list.length > 0, "the table has no rows");
    assert.equal(failures.length, 0, `${failures.length} of ${list.length} row(s) failed:\n${failures.join("\n")}`);
}
