/**
 * Module slot for B1 · heartbeat, detection, reconnect (design §1).
 *
 * Owned by that epic: everything under src/connection/. Register frame handlers with
 * `ctx.onFrame`, hooks with `ctx.events.on`, HTTP routes with `ctx.http.route`.
 * Return a function to run on shutdown (clear intervals), or nothing.
 */

import type { ServerContext } from '../server.js';

export function registerConnection(_ctx: ServerContext): void | (() => void | Promise<void>) {
  // Empty until the epic lands.
}
