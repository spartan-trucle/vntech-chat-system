import { beforeEach, describe, expect, test } from 'vitest';
import type { PresenceStore } from '../../../src/ports/PresenceStore.js';

export interface PresenceStoreFixture {
  store: PresenceStore;
  advance(ms: number): void;
}

export function describePresenceStoreContract(name: string, make: () => PresenceStoreFixture): void {
  describe(`${name} satisfies the PresenceStore contract`, () => {
    let f: PresenceStoreFixture;
    beforeEach(() => {
      f = make();
    });

    test('a lease is readable until its TTL passes', async () => {
      await f.store.set('truc', { state: 'online' }, 5 * 60_000);
      expect(await f.store.get('truc')).toEqual({ state: 'online' });
      f.advance(5 * 60_000 - 1);
      expect(await f.store.get('truc')).toEqual({ state: 'online' });
      f.advance(2);
      expect(await f.store.get('truc')).toBeUndefined();
    });

    test('renewing extends the lease', async () => {
      await f.store.set('truc', { state: 'online' }, 1000);
      f.advance(800);
      await f.store.set('truc', { state: 'online' }, 1000);
      f.advance(800);
      expect(await f.store.get('truc')).toEqual({ state: 'online' });
    });

    test('offline carries last_seen', async () => {
      await f.store.set('truc', { state: 'offline', last_seen: 1234 }, 60_000);
      expect(await f.store.get('truc')).toEqual({ state: 'offline', last_seen: 1234 });
      expect(await f.store.get('nobody')).toBeUndefined();
    });
  });
}
