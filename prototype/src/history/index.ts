/**
 * Module slot for B4 · history page API and conversation summary, the slow path (design §2.3, §4.3).
 *
 * Owned by that epic: everything under src/history/. Register frame handlers with
 * `ctx.onFrame`, hooks with `ctx.events.on`, HTTP routes with `ctx.http.route`.
 * Return a function to run on shutdown (clear intervals), or nothing.
 */

import type { ServerContext } from '../server.js';

export function registerHistory(_ctx: ServerContext): void | (() => void | Promise<void>) {
  // Empty until the epic lands.
}
