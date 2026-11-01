/**
 * Module slot for B6 · presence by subscription (design §5).
 *
 * Owned by that epic: everything under src/presence/. Register frame handlers with
 * `ctx.onFrame`, hooks with `ctx.events.on`, HTTP routes with `ctx.http.route`.
 * Return a function to run on shutdown (clear intervals), or nothing.
 */

import type { ServerContext } from '../server.js';

export function registerPresence(_ctx: ServerContext): void | (() => void | Promise<void>) {
  // Empty until the epic lands.
}
