/**
 * The request id every command carries, from one counter.
 *
 * Zalo Web numbers all of its socket requests (queue pulls, sync requests and releases, the activity ping) from a
 * single counter, `req_<n>`, and the server echoes the id in its answer. zca-js numbers its own frames separately
 * and under another key (`req_id`). Everything this client sends in the Web shape takes its id from here, so ids
 * never repeat inside a process and an answer can be matched to exactly one request.
 */

let counter = 0;

/**
 * The next request id.
 *
 * @returns {string} `req_1`, `req_2`, ...
 */
export function nextReqId() {
    return `req_${++counter}`;
}

/** Start the counter over. For tests: nothing in the product has a reason to. */
export function resetReqIdsForTests() {
    counter = 0;
}
