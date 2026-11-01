import type { MessageId } from '../ids.js';
import type { ConversationId, UserId } from '../protocol.js';

/** `conv:{id}:summary` of design §4.3, ~150 bytes, updated on every write. */
export interface ConversationSummary {
  conversation_id: ConversationId;
  last_message_id: MessageId;
  last_preview: string;
  last_sender: UserId;
  last_at: number;
}

export interface Summaries {
  upsert(summary: ConversationSummary): Promise<void>;
  get(conversation_id: ConversationId): Promise<ConversationSummary | undefined>;
  /** One MGET: rows that exist, in the order asked. */
  getMany(conversation_ids: ConversationId[]): Promise<ConversationSummary[]>;
}
