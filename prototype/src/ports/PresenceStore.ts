import type { PresenceState, UserId } from '../protocol.js';

export interface PresenceRecord {
  state: PresenceState;
  last_seen?: number;
}

/** `presence:{user_id}` lease of design §1.5 / §5.3: a value with a TTL, nothing else. */
export interface PresenceStore {
  set(user_id: UserId, record: PresenceRecord, ttlMs: number): Promise<void>;
  /** Undefined once the TTL has passed. */
  get(user_id: UserId): Promise<PresenceRecord | undefined>;
}
