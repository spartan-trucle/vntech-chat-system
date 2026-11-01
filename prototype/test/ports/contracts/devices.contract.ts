import { beforeEach, describe, expect, test } from 'vitest';
import type { Devices } from '../../../src/ports/Devices.js';

export function describeDevicesContract(name: string, make: () => Devices): void {
  describe(`${name} satisfies the Devices contract`, () => {
    let d: Devices;
    beforeEach(() => {
      d = make();
    });

    test('register is idempotent and devicesOf lists every device the user ever connected', async () => {
      await d.register({ user_id: 'truc', device_id: 'A1', kind: 'phone' });
      await d.register({ user_id: 'truc', device_id: 'A2', kind: 'laptop' });
      await d.register({ user_id: 'truc', device_id: 'A1', kind: 'phone' });
      expect((await d.devicesOf('truc')).map((x) => x.device_id)).toEqual(['A1', 'A2']);
      expect(await d.devicesOf('khanh')).toEqual([]);
      expect(await d.get('A2')).toEqual({ user_id: 'truc', device_id: 'A2', kind: 'laptop' });
    });
  });
}
