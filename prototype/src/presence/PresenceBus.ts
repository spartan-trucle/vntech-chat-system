/**
 * The cross-server fan-out channel of design §5.3: one pub/sub channel `pres:{user}` per
 * watched user, joined by a chat server while it has at least one watcher of that user
 * and left when the last watcher goes. The server that observes a transition publishes
 * once; every subscribed server pushes to its own watching connections.
 *
 * One-server prototype: the in-memory implementation below, where the server is both the
 * publisher and the only subscriber. B9 replaces it with Redis pub/sub behind the same
 * contract (test/presence/contracts/presenceBus.contract.ts).
 */

import type { PresenceState, UserId } from '../protocol.js';

export interface PresenceEvent {
  user_id: UserId;
  state: PresenceState;
  /** Present on `offline`: the drop time, from the publishing server's clock. */
  last_seen?: number;
}

export type PresenceHandler = (event: PresenceEvent) => void;

export interface PresenceBus {
  publish(user_id: UserId, event: PresenceEvent): Promise<void>;
  /** Returns the unsubscribe function. */
  subscribe(user_id: UserId, handler: PresenceHandler): () => void;
}

export class InMemoryPresenceBus implements PresenceBus {
  private readonly channels = new Map<UserId, Set<PresenceHandler>>();

  async publish(user_id: UserId, event: PresenceEvent): Promise<void> {
    const handlers = this.channels.get(user_id);
    if (!handlers) return;
    for (const handler of [...handlers]) handler({ ...event });
  }

  subscribe(user_id: UserId, handler: PresenceHandler): () => void {
    let handlers = this.channels.get(user_id);
    if (!handlers) {
      handlers = new Set();
      this.channels.set(user_id, handlers);
    }
    handlers.add(handler);
    return () => {
      const set = this.channels.get(user_id);
      if (!set) return;
      set.delete(handler);
      if (set.size === 0) this.channels.delete(user_id);
    };
  }

  /** Instrumentation: open subscriptions of one channel, so a test can see subscribe/unsubscribe. */
  subscribers(user_id: UserId): number {
    return this.channels.get(user_id)?.size ?? 0;
  }
}
