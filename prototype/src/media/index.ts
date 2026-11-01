/**
 * Module slot for B7 · media stub (design §6.2).
 *
 * Owned by that epic: everything under src/media/. Register frame handlers with
 * `ctx.onFrame`, hooks with `ctx.events.on`, HTTP routes with `ctx.http.route`.
 * Return a function to run on shutdown (clear intervals), or nothing.
 */

import type { ServerContext } from '../server.js';

export function registerMedia(_ctx: ServerContext): void | (() => void | Promise<void>) {
  // Empty until the epic lands.
}
