import { beforeEach, describe, expect, test } from 'vitest';
import type { PresenceBus, PresenceEvent } from '../../../src/presence/PresenceBus.js';

/**
 * Contract of the `pres:{user}` pub/sub channel of design §5.3, reusable by B9 against
 * Redis: a server subscribes when its first watcher of a user appears, unsubscribes when
 * the last leaves, and a publish reaches every current subscriber of that user only.
 */
export function describePresenceBusContract(name: string, make: () => PresenceBus): void {
  describe(`${name} satisfies the PresenceBus contract`, () => {
    let bus: PresenceBus;
    beforeEach(() => {
      bus = make();
    });

    test('a publish reaches a subscriber of that user with the event as published', async () => {
      const got: PresenceEvent[] = [];
      bus.subscribe('truc', (e) => { got.push(e); });
      await bus.publish('truc', { user_id: 'truc', state: 'offline', last_seen: 1234 });
      expect(got).toEqual([{ user_id: 'truc', state: 'offline', last_seen: 1234 }]);
    });

    test('a subscriber of another user hears nothing', async () => {
      const got: PresenceEvent[] = [];
      bus.subscribe('khanh', (e) => { got.push(e); });
      await bus.publish('truc', { user_id: 'truc', state: 'online' });
      expect(got).toEqual([]);
    });

    test('every subscriber of the user gets the event once', async () => {
      const a: PresenceEvent[] = [];
      const b: PresenceEvent[] = [];
      bus.subscribe('truc', (e) => { a.push(e); });
      bus.subscribe('truc', (e) => { b.push(e); });
      await bus.publish('truc', { user_id: 'truc', state: 'online' });
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
    });

    test('after unsubscribe nothing more arrives, and other subscribers are untouched', async () => {
      const a: PresenceEvent[] = [];
      const b: PresenceEvent[] = [];
      const offA = bus.subscribe('truc', (e) => { a.push(e); });
      bus.subscribe('truc', (e) => { b.push(e); });
      offA();
      await bus.publish('truc', { user_id: 'truc', state: 'online' });
      expect(a).toEqual([]);
      expect(b).toHaveLength(1);
    });

    test('publishing with nobody listening is not an error', async () => {
      await expect(bus.publish('nobody', { user_id: 'nobody', state: 'offline' })).resolves.toBeUndefined();
    });
  });
}
