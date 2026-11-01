import { beforeEach, describe, expect, test } from 'vitest';
import type { RouteTable } from '../../../src/ports/RouteTable.js';

export function describeRouteTableContract(name: string, make: () => RouteTable): void {
  describe(`${name} satisfies the RouteTable contract`, () => {
    let r: RouteTable;
    beforeEach(() => {
      r = make();
    });

    test('set then get returns the server, delete removes it', async () => {
      await r.set('truc', 'A1', 'srv-1');
      expect(await r.get('truc', 'A1')).toBe('srv-1');
      expect(await r.delete('truc', 'A1')).toBe(true);
      expect(await r.get('truc', 'A1')).toBeUndefined();
      expect(await r.delete('truc', 'A1')).toBe(false);
    });

    test('devicesOf lists the user devices with a route (SCARD → 0 means last device gone)', async () => {
      await r.set('truc', 'A1', 'srv-1');
      await r.set('truc', 'A2', 'srv-1');
      await r.set('khanh', 'B1', 'srv-1');
      expect((await r.devicesOf('truc')).sort()).toEqual(['A1', 'A2']);
      await r.delete('truc', 'A1');
      await r.delete('truc', 'A2');
      expect(await r.devicesOf('truc')).toEqual([]);
    });
  });
}
