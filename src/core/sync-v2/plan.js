/**
 * Decide what one `zalo-agent sync` run does, before it touches the network.
 *
 * Kept pure -- flags, freshness and lock state in, a stage list out -- so the
 * rules that matter most are checkable offline:
 *
 *   - at most ONE stage wakes the phone (the message restore), so a run never
 *     asks the owner to confirm twice. This holds whichever socket the stage
 *     runs on: handing it to a daemon removes the second WebSocket, not the
 *     confirmation;
 *   - the socket opens at most once. zca-js's stop() resets the listener, and
 *     the socket's own onclose resets it AGAIN, asynchronously, after stop()
 *     has returned -- so a stage that stops the listener and a later stage that
 *     restarts it race, and the late reset nulls the new socket. Every socket
 *     stage therefore shares one window, opened first and closed once;
 *   - REST stages never wait on the socket and run after it closes, so the
 *     account's one web session is held no longer than the socket work needs.
 */

/** Stage order. Socket stages first, in one window; REST after it closes. */
export const STAGES = [
    { name: "messages", transport: "socket", phone: true, label: "message history (cmd 590/591)" },
    { name: "reactions", transport: "socket", phone: false, label: "reaction backlog (cmd 610/611)" },
    { name: "convState", transport: "rest", phone: false, label: "pinned & unread conversations" },
    { name: "boards", transport: "rest", phone: false, label: "notes, pins, polls, reminders" },
    { name: "cloud", transport: "rest", phone: false, label: "zCloud media index" },
    { name: "media", transport: "http", phone: false, label: "attachment downloads" },
];

/**
 * @param {object} args
 * @param {Record<string, boolean>} args.want - which stages were asked for (all true by default)
 * @param {{skip: boolean, reason: string}} args.freshness - SyncManager.checkSyncFreshness()
 * @param {boolean} args.lockOk - whether this process holds daemon.lock
 * @param {boolean} [args.daemonChannel=false] - whether the daemon holding the lock
 *   publishes a usable channel (getDaemonChannel() !== null). When it does, a
 *   socket stage runs ON that daemon instead of being skipped — the daemon
 *   already has the account's one web session open and keeps capturing live
 *   traffic while the stage runs. See src/core/daemon-channel.js.
 * @returns {{openSocket: boolean, viaDaemon: boolean, stages: Array<{name: string,
 *   transport: string, label: string, phone: boolean, run: boolean, via: string, why: string}>}}
 *   `openSocket` is true only when THIS process must open one; a run that goes
 *   through the daemon opens nothing and sets `viaDaemon` instead.
 */
export function planSyncRun({
    want = {},
    freshness = { skip: false, reason: "" },
    lockOk = true,
    daemonChannel = false,
} = {}) {
    const stages = STAGES.map((s) => {
        const wanted = want[s.name] !== false;
        let run = wanted;
        let via = "local";
        let why = wanted ? "" : `--no-${kebab(s.name)}`;

        if (run && s.transport === "socket" && !lockOk) {
            if (daemonChannel) {
                // The daemon owns the one web session AND will run the stage on
                // it. Nothing is stopped and nothing is evicted, so this is the
                // strictly better outcome: the old answer -- stop the daemon,
                // sync, start it again -- opened a fresh coverage gap between
                // the restore's snapshot and the daemon coming back, and that
                // gap has no repair path.
                via = "daemon";
            } else {
                run = false;
                // A running listen/mcp daemon owns the one web session. It is
                // capturing live traffic already; opening a second session here
                // would evict it and lose messages.
                why = "a listen/mcp daemon holds the account's socket";
            }
        }
        if (run && s.name === "messages" && freshness.skip) {
            run = false;
            via = "local";
            why = `synced recently (${freshness.reason}); --force to re-ping the phone`;
        }
        // A running messages stage says why it is not skipped (stale, pending
        // gap, never synced, forced); nothing else depends on freshness.
        return { ...s, run, via, why: run ? (s.name === "messages" ? freshness.reason || "" : "") : why };
    });

    const socketStages = stages.filter((s) => s.run && s.transport === "socket");
    return {
        openSocket: socketStages.some((s) => s.via === "local"),
        viaDaemon: socketStages.some((s) => s.via === "daemon"),
        stages,
    };
}

/** "convState" -> "conv-state", for the matching --no-<stage> flag. */
function kebab(s) {
    return s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}
