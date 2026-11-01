import { beforeEach, describe, expect, test } from 'vitest';
import type { PushGateway, PushHint } from '../../src/receipts/PushGateway.js';

/**
 * Contract of the push-notification port (design §3.6). Reusable against a real APNs/FCM
 * adapter (B9): `recorded()` is the test hook, so a real adapter under test records what
 * it would have sent.
 */
export function describePushGatewayContract(name: string, make: () => PushGateway & { recorded(): Array<{ device_id: string; hint: PushHint }> }): void {
  describe(`${name} satisfies the PushGateway contract`, () => {
    let g: ReturnType<typeof make>;
    beforeEach(() => {
      g = make();
    });

    test('a hint is recorded per device, in order, with exactly the three fields of §3.6', async () => {
      await g.push('B1', { conversation_id: 'c1', message_id: '100', sender_display_name: 'Truc' });
      await g.push('A2', { conversation_id: 'c1', message_id: '100', sender_display_name: 'Truc' });
      await g.push('B1', { conversation_id: 'c2', message_id: '101', sender_display_name: 'Linh' });
      expect(g.recorded()).toEqual([
        { device_id: 'B1', hint: { conversation_id: 'c1', message_id: '100', sender_display_name: 'Truc' } },
        { device_id: 'A2', hint: { conversation_id: 'c1', message_id: '100', sender_display_name: 'Truc' } },
        { device_id: 'B1', hint: { conversation_id: 'c2', message_id: '101', sender_display_name: 'Linh' } },
      ]);
      for (const row of g.recorded()) expect(Object.keys(row.hint).sort()).toEqual(['conversation_id', 'message_id', 'sender_display_name']);
    });

    test('the recorded hint is a copy: mutating the caller\'s object afterwards changes nothing', async () => {
      const hint: PushHint = { conversation_id: 'c1', message_id: '100', sender_display_name: 'Truc' };
      await g.push('B1', hint);
      hint.message_id = '999';
      expect(g.recorded()[0]?.hint.message_id).toBe('100');
    });

    test('nothing recorded before the first push', () => {
      expect(g.recorded()).toEqual([]);
    });
  });
}
