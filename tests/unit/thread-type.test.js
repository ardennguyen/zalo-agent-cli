/**
 * `src/utils/thread-type.js` — filling in `--type` from the cache.
 *
 * Twenty-two commands take `-t, --type <n>` and all of them default it to 0.
 * For a group that default is wrong, and wrong silently: Zalo delivers the
 * message anyway, so the command succeeds, but the server echoes the sender's
 * own copy back on the channel matching the declared type. A group send left
 * at the default came back down the 1-1 channel and the listener retyped the
 * conversation as a DM. Two threads in a real cache were already mislabelled.
 *
 * These cover the two things that decide whether the fix fires at all: that an
 * explicit `-t` is never second-guessed, and that the threadId is found by
 * NAME rather than by position — `msg send <threadId> <message>` puts it
 * first, `msg react <msgId> <threadId> <reaction>` second.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { applyCachedThreadType } from "../../src/utils/thread-type.js";

/** A command shaped like the real ones, parsed but not run. */
function cmd(signature, argv) {
    const c = new Command(signature.split(" ")[0])
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .exitOverride()
        .action(() => {});
    for (const tok of signature.split(" ").slice(1)) c.argument(tok);
    c.parse(argv, { from: "user" });
    return c;
}

const group = () => "group";
const dm = () => "dm";
const unknown = () => null;

describe("applyCachedThreadType", () => {
    it("promotes a group send that did not say so", () => {
        const c = cmd("send <threadId> <message>", ["g1", "hi"]);
        applyCachedThreadType(c, group);
        assert.equal(c.opts().type, "1");
    });

    it("leaves a 1-1 alone", () => {
        const c = cmd("send <threadId> <message>", ["u1", "hi"]);
        applyCachedThreadType(c, dm);
        assert.equal(c.opts().type, "0");
    });

    it("leaves an uncached thread at the default rather than guessing", () => {
        const c = cmd("send <threadId> <message>", ["x1", "hi"]);
        applyCachedThreadType(c, unknown);
        assert.equal(c.opts().type, "0");
    });

    it("never overrides an explicit -t, even when the cache disagrees", () => {
        // Passing 0 by hand is a decision. Only commander's own default is
        // treated as "the caller did not say".
        const c = cmd("send <threadId> <message>", ["g1", "hi", "-t", "0"]);
        applyCachedThreadType(c, group);
        assert.equal(c.opts().type, "0");
    });

    it("finds the threadId when it is not the first argument", () => {
        // `msg react <msgId> <threadId> <reaction>` — a positional assumption
        // would read the msgId here and resolve nothing.
        const c = cmd("react <msgId> <threadId> <reaction>", ["m1", "g1", "/-heart"]);
        applyCachedThreadType(c, (id) => (id === "g1" ? "group" : "dm"));
        assert.equal(c.opts().type, "1");
    });

    it("does nothing for a command with no threadId argument", () => {
        const c = cmd("list", []);
        applyCachedThreadType(c, group);
        assert.equal(c.opts().type, "0");
    });

    it("swallows a failing lookup instead of breaking the command", () => {
        // It runs in front of EVERY command, so a missing account or an
        // unreadable cache must not turn into a failed send.
        const c = cmd("send <threadId> <message>", ["g1", "hi"]);
        applyCachedThreadType(c, () => {
            throw new Error("no cache");
        });
        assert.equal(c.opts().type, "0");
    });

    it("ignores a command that has no --type option at all", () => {
        const c = new Command("sync-boards").exitOverride().action(() => {});
        c.parse([], { from: "user" });
        assert.doesNotThrow(() => applyCachedThreadType(c, group));
    });
});
