import { beforeEach, describe, expect, test } from 'vitest';
import type { PresenceStore } from '../../../src/ports/PresenceStore.js';

/**
 * The lease lengths the cases use. The defaults are the design's numbers on a fake clock;
 * an adapter whose TTL runs on a real clock (B9: Redis) supplies shorter ones and an
 * `advance` that really waits. The assertions are the same: readable `slack` before the
 * TTL, gone `slack` after it; a renewal at 80 % of a lease keeps it alive at 160 %.
 */
export interface PresenceLeases {
  long: number;
  short: number;
  slack: number;
}

export const DEFAULT_PRESENCE_LEASES: PresenceLeases = { long: 5 * 60_000, short: 1000, slack: 1 };

export interface PresenceStoreFixture {
  store: PresenceStore;
  /** Moves the store's clock forward; a real-clock store sleeps here. */
  advance(ms: number): void | Promise<void>;
  leases?: PresenceLeases;
}

export function describePresenceStoreContract(name: string, make: () => PresenceStoreFixture): void {
  describe(`${name} satisfies the PresenceStore contract`, () => {
    let f: PresenceStoreFixture;
    let T: PresenceLeases;
    beforeEach(() => {
      f = make();
      T = f.leases ?? DEFAULT_PRESENCE_LEASES;
    });

    test('a lease is readable until its TTL passes', async () => {
      await f.store.set('truc', { state: 'online' }, T.long);
      expect(await f.store.get('truc')).toEqual({ state: 'online' });
      await f.advance(T.long - T.slack);
      expect(await f.store.get('truc')).toEqual({ state: 'online' });
      await f.advance(2 * T.slack);
      expect(await f.store.get('truc')).toBeUndefined();
    });

    test('renewing extends the lease', async () => {
      await f.store.set('truc', { state: 'online' }, T.short);
      await f.advance(T.short * 0.8);
      await f.store.set('truc', { state: 'online' }, T.short);
      await f.advance(T.short * 0.8);
      expect(await f.store.get('truc')).toEqual({ state: 'online' });
    });

    test('offline carries last_seen', async () => {
      await f.store.set('truc', { state: 'offline', last_seen: 1234 }, 60_000);
      expect(await f.store.get('truc')).toEqual({ state: 'offline', last_seen: 1234 });
      expect(await f.store.get('nobody')).toBeUndefined();
    });
  });
}
