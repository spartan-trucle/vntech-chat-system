import { compareIds, type MessageId } from '../ids.js';
import type { ConversationId, DeviceId, UserId } from '../protocol.js';
import type { Cursors } from './Cursors.js';

function advance(partition: Map<string, MessageId>, key: string, id: MessageId): MessageId {
  const old = partition.get(key);
  if (old !== undefined && compareIds(old, id) >= 0) return old;
  partition.set(key, id);
  return id;
}

export class InMemoryCursors implements Cursors {
  private readonly read = new Map<ConversationId, Map<UserId, MessageId>>();
  private readonly delivery = new Map<ConversationId, Map<DeviceId, MessageId>>();

  private partition(table: Map<ConversationId, Map<string, MessageId>>, conversation_id: ConversationId): Map<string, MessageId> {
    let p = table.get(conversation_id);
    if (!p) {
      p = new Map();
      table.set(conversation_id, p);
    }
    return p;
  }

  async advanceRead(conversation_id: ConversationId, user_id: UserId, last_read_id: MessageId): Promise<MessageId> {
    return advance(this.partition(this.read, conversation_id), user_id, last_read_id);
  }

  async readCursor(conversation_id: ConversationId, user_id: UserId): Promise<MessageId | undefined> {
    return this.read.get(conversation_id)?.get(user_id);
  }

  async readCursors(conversation_id: ConversationId): Promise<Map<UserId, MessageId>> {
    return new Map(this.read.get(conversation_id) ?? []);
  }

  async advanceDelivery(conversation_id: ConversationId, device_id: DeviceId, last_delivered_id: MessageId): Promise<MessageId> {
    return advance(this.partition(this.delivery, conversation_id), device_id, last_delivered_id);
  }

  async deliveryCursors(conversation_id: ConversationId): Promise<Map<DeviceId, MessageId>> {
    return new Map(this.delivery.get(conversation_id) ?? []);
  }
}
