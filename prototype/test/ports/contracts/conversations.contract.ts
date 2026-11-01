import { beforeEach, describe, expect, test } from 'vitest';
import type { Conversations } from '../../../src/ports/Conversations.js';

export function describeConversationsContract(name: string, make: () => Conversations): void {
  describe(`${name} satisfies the Conversations contract`, () => {
    let c: Conversations;
    beforeEach(() => {
      c = make();
    });

    test('create then membership queries', async () => {
      await c.create({ conversation_id: 'c1', type: 'dm', members: ['truc', 'khanh'], created_bucket: 202601 });
      await c.create({ conversation_id: 'c2', type: 'group', name: 'vntech design', members: ['truc', 'khanh', 'linh'], created_bucket: 202603 });
      expect(await c.membersOf('c2')).toEqual(['truc', 'khanh', 'linh']);
      expect(await c.isMember('c1', 'linh')).toBe(false);
      expect(await c.isMember('c2', 'linh')).toBe(true);
      expect((await c.conversationsOf('linh')).map((x) => x.conversation_id)).toEqual(['c2']);
      expect((await c.conversationsOf('truc')).map((x) => x.conversation_id).sort()).toEqual(['c1', 'c2']);
      expect(await c.get('c9')).toBeUndefined();
      expect(await c.membersOf('c9')).toEqual([]);
    });
  });
}
