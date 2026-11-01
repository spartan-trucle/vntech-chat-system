import type { ConversationId, UserId } from '../protocol.js';
import type { Conversation, Conversations } from './Conversations.js';

export class InMemoryConversations implements Conversations {
  private readonly rows = new Map<ConversationId, Conversation>();

  async create(conversation: Conversation): Promise<void> {
    this.rows.set(conversation.conversation_id, { ...conversation, members: [...conversation.members] });
  }

  async get(conversation_id: ConversationId): Promise<Conversation | undefined> {
    const row = this.rows.get(conversation_id);
    return row ? { ...row, members: [...row.members] } : undefined;
  }

  async membersOf(conversation_id: ConversationId): Promise<UserId[]> {
    return [...(this.rows.get(conversation_id)?.members ?? [])];
  }

  async isMember(conversation_id: ConversationId, user_id: UserId): Promise<boolean> {
    return this.rows.get(conversation_id)?.members.includes(user_id) ?? false;
  }

  async conversationsOf(user_id: UserId): Promise<Conversation[]> {
    const out: Conversation[] = [];
    for (const row of this.rows.values()) {
      if (row.members.includes(user_id)) out.push({ ...row, members: [...row.members] });
    }
    return out;
  }
}
