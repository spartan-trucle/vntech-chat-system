import type { MessageId } from '../ids.js';
import type { ConversationId, Message, UserId } from '../protocol.js';

export interface MessageRef {
  conversation_id: ConversationId;
  message_id: MessageId;
}

export interface ReadPartitionOptions {
  /** Return rows with message_id strictly below this id. */
  before?: MessageId;
  /** Return rows with message_id strictly above this id. */
  after?: MessageId;
  limit: number;
  /** `desc` (default) is the table's clustering order, newest first. */
  order?: 'asc' | 'desc';
}

/**
 * The `messages` table of design §2.2 plus the dedup index of §1.4 / §2.2.
 *
 * `readPartition` is one partition read `(conversation_id, bucket)`; the month-bucket walk
 * of §2.3 is the caller's loop over buckets, so a test can count partition reads.
 */
export interface MessageStore {
  /** Writes the row and indexes `(sender_id, client_msg_id) → message_id` for 24 h. */
  insert(message: Message): Promise<void>;
  get(conversation_id: ConversationId, message_id: MessageId): Promise<Message | undefined>;
  /** Join bodies for a replay batch: rows in the order asked, missing ones skipped. */
  getMany(refs: MessageRef[]): Promise<Message[]>;
  readPartition(conversation_id: ConversationId, bucket: number, opts: ReadPartitionOptions): Promise<Message[]>;
  /** Dedup lookup; undefined once the 24 h TTL has passed. */
  findByClientMsgId(sender_id: UserId, client_msg_id: string): Promise<MessageId | undefined>;
  /** Bounded range count on one bucket (unread count, design §3.5); never exceeds `cap`. */
  countAfter(conversation_id: ConversationId, bucket: number, after: MessageId, cap: number): Promise<number>;
}
