import { beforeEach, describe, expect, test } from 'vitest';
import type { Summaries, ConversationSummary } from '../../../src/ports/Summaries.js';

export function describeSummariesContract(name: string, make: () => Summaries): void {
  describe(`${name} satisfies the Summaries contract`, () => {
    let s: Summaries;
    beforeEach(() => {
      s = make();
    });
    const row = (id: string, last_at: number): ConversationSummary => ({
      conversation_id: id, last_message_id: `${last_at}`, last_preview: 'p', last_sender: 'truc', last_at,
    });

    test('upsert then get; a second upsert replaces the row', async () => {
      await s.upsert(row('c1', 1));
      expect(await s.get('c1')).toEqual(row('c1', 1));
      await s.upsert(row('c1', 2));
      expect(await s.get('c1')).toEqual(row('c1', 2));
      expect(await s.get('c9')).toBeUndefined();
    });

    test('getMany is one MGET: rows for the ids that exist, in the order asked', async () => {
      await s.upsert(row('c1', 1));
      await s.upsert(row('c2', 2));
      expect(await s.getMany(['c2', 'c9', 'c1'])).toEqual([row('c2', 2), row('c1', 1)]);
    });
  });
}
