import { beforeEach, describe, expect, test } from 'vitest';
import type { Cursors } from '../../../src/ports/Cursors.js';

export function describeCursorsContract(name: string, make: () => Cursors): void {
  describe(`${name} satisfies the Cursors contract`, () => {
    let c: Cursors;
    beforeEach(() => {
      c = make();
    });

    test('read cursor only ever increases (late or duplicate receipt is a no-op)', async () => {
      expect(await c.advanceRead('c1', 'truc', '100')).toBe('100');
      expect(await c.advanceRead('c1', 'truc', '90')).toBe('100');
      expect(await c.advanceRead('c1', 'truc', '100')).toBe('100');
      expect(await c.advanceRead('c1', 'truc', '101')).toBe('101');
      expect(await c.readCursor('c1', 'truc')).toBe('101');
      expect(await c.readCursor('c1', 'khanh')).toBeUndefined();
    });

    test('read cursors of a conversation come back as one partition', async () => {
      await c.advanceRead('c1', 'truc', '100');
      await c.advanceRead('c1', 'khanh', '9');
      await c.advanceRead('c2', 'truc', '500');
      expect(await c.readCursors('c1')).toEqual(new Map([['truc', '100'], ['khanh', '9']]));
    });

    test('delivery cursors are per device with the same max semantics', async () => {
      expect(await c.advanceDelivery('c1', 'A1', '100')).toBe('100');
      expect(await c.advanceDelivery('c1', 'A1', '99')).toBe('100');
      await c.advanceDelivery('c1', 'B1', '100');
      expect(await c.deliveryCursors('c1')).toEqual(new Map([['A1', '100'], ['B1', '100']]));
    });

    test('cursor comparison is numeric', async () => {
      await c.advanceRead('c1', 'truc', '9');
      expect(await c.advanceRead('c1', 'truc', '10')).toBe('10');
    });
  });
}
