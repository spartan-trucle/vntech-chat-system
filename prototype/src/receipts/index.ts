/**
 * Module slot for B5 · receipts, unread, multi-device read state (design §3).
 *
 * Owned by that epic: everything under src/receipts/. Register frame handlers with
 * `ctx.onFrame`, hooks with `ctx.events.on`, HTTP routes with `ctx.http.route`.
 * Return a function to run on shutdown (clear intervals), or nothing.
 */

import type { ServerContext } from '../server.js';

export function registerReceipts(_ctx: ServerContext): void | (() => void | Promise<void>) {
  // Empty until the epic lands.
}
