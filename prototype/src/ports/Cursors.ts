import type { MessageId } from '../ids.js';
import type { ConversationId, DeviceId, UserId } from '../protocol.js';

/**
 * `read_cursors (conversation, user)` and `delivery_cursors (conversation, device)` of
 * design §3.3. Writes are `max(old, new)`: idempotent and commutative, so a late or
 * duplicate receipt is harmless. Status (read / delivered / sent) is derived by the
 * caller from these, never stored.
 */
export interface Cursors {
  /** Returns the cursor after the write. */
  advanceRead(conversation_id: ConversationId, user_id: UserId, last_read_id: MessageId): Promise<MessageId>;
  readCursor(conversation_id: ConversationId, user_id: UserId): Promise<MessageId | undefined>;
  /** One partition read: every member's read cursor. */
  readCursors(conversation_id: ConversationId): Promise<Map<UserId, MessageId>>;
  advanceDelivery(conversation_id: ConversationId, device_id: DeviceId, last_delivered_id: MessageId): Promise<MessageId>;
  deliveryCursors(conversation_id: ConversationId): Promise<Map<DeviceId, MessageId>>;
}
