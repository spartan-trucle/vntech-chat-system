import type { UserId } from '../protocol.js';
import type { PresenceRecord, PresenceStore } from './PresenceStore.js';

export class InMemoryPresenceStore implements PresenceStore {
  private readonly rows = new Map<UserId, { record: PresenceRecord; expires_at: number }>();
  private readonly now: () => number;
  /** Instrumentation: design §1.5 says the heartbeat path never writes here; a test counts. */
  public writes = 0;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  async set(user_id: UserId, record: PresenceRecord, ttlMs: number): Promise<void> {
    this.writes += 1;
    this.rows.set(user_id, { record: { ...record }, expires_at: this.now() + ttlMs });
  }

  async get(user_id: UserId): Promise<PresenceRecord | undefined> {
    const row = this.rows.get(user_id);
    if (!row) return undefined;
    if (row.expires_at < this.now()) {
      this.rows.delete(user_id);
      return undefined;
    }
    return { ...row.record };
  }
}
