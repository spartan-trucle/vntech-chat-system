import type { ConversationId, UserId } from '../protocol.js';

/** Membership directory. A 1:1 chat is a conversation with two members (design §2.2). */
export interface Conversation {
  conversation_id: ConversationId;
  type: 'dm' | 'group';
  name?: string;
  members: UserId[];
  /** Oldest bucket the history walk of design §2.3 may descend to. */
  created_bucket: number;
}

export interface Conversations {
  create(conversation: Conversation): Promise<void>;
  get(conversation_id: ConversationId): Promise<Conversation | undefined>;
  membersOf(conversation_id: ConversationId): Promise<UserId[]>;
  isMember(conversation_id: ConversationId, user_id: UserId): Promise<boolean>;
  conversationsOf(user_id: UserId): Promise<Conversation[]>;
}
