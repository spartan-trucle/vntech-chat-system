/**
 * Module slot for B2 · send path: store, IDs, dedup, write order (design §2.2, §1.4).
 *
 * Owned by that epic: everything under src/messaging/. Register frame handlers with
 * `ctx.onFrame`, hooks with `ctx.events.on`, HTTP routes with `ctx.http.route`.
 * Return a function to run on shutdown (clear intervals), or nothing.
 */

import type { ServerContext } from '../server.js';

export function registerMessaging(_ctx: ServerContext): void | (() => void | Promise<void>) {
  // Empty until the epic lands.
}
