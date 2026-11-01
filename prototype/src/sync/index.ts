/**
 * Module slot for B3 · sync queue and replay (design §4.2, §4.4, §4.7).
 *
 * Owned by that epic: everything under src/sync/. Register frame handlers with
 * `ctx.onFrame`, hooks with `ctx.events.on`, HTTP routes with `ctx.http.route`.
 * Return a function to run on shutdown (clear intervals), or nothing.
 */

import type { ServerContext } from '../server.js';

export function registerSync(_ctx: ServerContext): void | (() => void | Promise<void>) {
  // Empty until the epic lands.
}
