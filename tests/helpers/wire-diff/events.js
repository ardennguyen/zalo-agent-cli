/**
 * Record what a listener emits, as plain data two listeners can be compared on.
 *
 * Every event name the engine subscribes to (agent/docs/zca-replace/spec-listener.md 1.3) plus `old_reactions`.
 * Subscribing to `error` also keeps an unhandled `error` from throwing; the error is recorded instead.
 */
import { normalizeValue } from "./normalize.js";

/** The listener's event names, in the order of spec-listener 1.3. */
export const LISTENER_EVENTS = Object.freeze([
    "connected",
    "cipher_key",
    "disconnected",
    "closed",
    "error",
    "message",
    "undo",
    "reaction",
    "old_reactions",
    "old_messages",
    "group_event",
    "friend_event",
    "typing",
    "upload_attachment",
    "delivered_messages",
    "seen_messages",
]);

/**
 * Subscribe to every listener event and record `{name, args}` with the args normalized (class instances to their
 * fields, big numbers to digits, `undefined` dropped).
 *
 * @param {import("node:events").EventEmitter} listener
 * @returns {{events: Array<{name: string, args: unknown[]}>, count: () => number, stop: () => void}}
 */
export function recordEvents(listener) {
    const events = [];
    const handlers = LISTENER_EVENTS.map((name) => {
        const fn = (...args) => events.push({ name, args: normalizeValue(args) });
        listener.on(name, fn);
        return [name, fn];
    });
    return {
        events,
        count: () => events.length,
        stop: () => {
            for (const [name, fn] of handlers) listener.removeListener(name, fn);
        },
    };
}
