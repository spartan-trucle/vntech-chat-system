import { beforeEach, describe, expect, test } from 'vitest';
import type { MessageStore } from '../../../src/ports/MessageStore.js';
import { msg } from './helpers.js';

export interface MessageStoreFixture {
  store: MessageStore;
  /** Moves the store's clock forward (dedup TTL). */
  advance(ms: number): void;
}

export function describeMessageStoreContract(name: string, make: () => MessageStoreFixture): void {
  describe(`${name} satisfies the MessageStore contract`, () => {
    let f: MessageStoreFixture;
    beforeEach(() => {
      f = make();
    });

    test('insert then get returns the row', async () => {
      const m = msg({ message_id: '100' });
      await f.store.insert(m);
      expect(await f.store.get('c1', '100')).toEqual(m);
      expect(await f.store.get('c1', '101')).toBeUndefined();
    });

    test('readPartition returns newest first within one bucket, bounded by limit', async () => {
      for (const id of ['101', '103', '102']) await f.store.insert(msg({ message_id: id }));
      await f.store.insert(msg({ message_id: '104', bucket: 202610 }));
      await f.store.insert(msg({ message_id: '105', conversation_id: 'c2' }));
      const rows = await f.store.readPartition('c1', 202611, { limit: 2 });
      expect(rows.map((r) => r.message_id)).toEqual(['103', '102']);
    });

    test('readPartition with before excludes the cursor and everything newer', async () => {
      for (const id of ['101', '102', '103', '104']) await f.store.insert(msg({ message_id: id }));
      const rows = await f.store.readPartition('c1', 202611, { before: '103', limit: 10 });
      expect(rows.map((r) => r.message_id)).toEqual(['102', '101']);
    });

    test('readPartition with after and asc order returns the nearest newer rows', async () => {
      for (const id of ['101', '102', '103', '104']) await f.store.insert(msg({ message_id: id }));
      const rows = await f.store.readPartition('c1', 202611, { after: '101', limit: 2, order: 'asc' });
      expect(rows.map((r) => r.message_id)).toEqual(['102', '103']);
    });

    test('readPartition compares ids numerically', async () => {
      for (const id of ['9', '10']) await f.store.insert(msg({ message_id: id }));
      const rows = await f.store.readPartition('c1', 202611, { limit: 10 });
      expect(rows.map((r) => r.message_id)).toEqual(['10', '9']);
    });

    test('getMany returns rows in the order asked and skips missing ones', async () => {
      for (const id of ['101', '102']) await f.store.insert(msg({ message_id: id }));
      const rows = await f.store.getMany([
        { conversation_id: 'c1', message_id: '102' },
        { conversation_id: 'c1', message_id: '999' },
        { conversation_id: 'c1', message_id: '101' },
      ]);
      expect(rows.map((r) => r.message_id)).toEqual(['102', '101']);
    });

    test('findByClientMsgId answers the dedup lookup for 24 h and forgets after', async () => {
      await f.store.insert(msg({ message_id: '100', sender_id: 'truc', client_msg_id: 'u-1' }));
      expect(await f.store.findByClientMsgId('truc', 'u-1')).toBe('100');
      expect(await f.store.findByClientMsgId('khanh', 'u-1')).toBeUndefined();
      f.advance(24 * 3600 * 1000 - 1);
      expect(await f.store.findByClientMsgId('truc', 'u-1')).toBe('100');
      f.advance(2);
      expect(await f.store.findByClientMsgId('truc', 'u-1')).toBeUndefined();
    });

    test('countAfter is a bounded range count on one bucket', async () => {
      for (const id of ['101', '102', '103', '104', '105']) await f.store.insert(msg({ message_id: id }));
      expect(await f.store.countAfter('c1', 202611, '102', 99)).toBe(3);
      expect(await f.store.countAfter('c1', 202611, '102', 2)).toBe(2);
      expect(await f.store.countAfter('c1', 202611, '105', 99)).toBe(0);
    });
  });
}
