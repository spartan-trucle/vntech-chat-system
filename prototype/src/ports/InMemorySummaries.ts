import type { ConversationId } from '../protocol.js';
import type { ConversationSummary, Summaries } from './Summaries.js';

export class InMemorySummaries implements Summaries {
  private readonly rows = new Map<ConversationId, ConversationSummary>();

  async upsert(summary: ConversationSummary): Promise<void> {
    this.rows.set(summary.conversation_id, { ...summary });
  }

  async get(conversation_id: ConversationId): Promise<ConversationSummary | undefined> {
    const row = this.rows.get(conversation_id);
    return row ? { ...row } : undefined;
  }

  async getMany(conversation_ids: ConversationId[]): Promise<ConversationSummary[]> {
    const out: ConversationSummary[] = [];
    for (const id of conversation_ids) {
      const row = this.rows.get(id);
      if (row) out.push({ ...row });
    }
    return out;
  }
}
