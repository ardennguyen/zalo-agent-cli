/**
 * A loopback port that is free right now, as the operating system hands one out. A random number in a fixed range is
 * not enough: Windows reserves port ranges (Hyper-V and others), and a listen there fails with EACCES.
 */
import { createServer } from "node:net";

/**
 * @returns {Promise<number>}
 */
export function freePort() {
    return new Promise((resolve, reject) => {
        const srv = createServer();
        srv.once("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}
