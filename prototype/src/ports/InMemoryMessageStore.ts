import { compareIds, type MessageId } from '../ids.js';
import type { ConversationId, Message, UserId } from '../protocol.js';
import type { MessageRef, MessageStore, ReadPartitionOptions } from './MessageStore.js';

export interface InMemoryMessageStoreOptions {
  now?: () => number;
  dedupTtlMs?: number;
}

const DAY_MS = 24 * 3600 * 1000;

/** Partition `(conversation_id, bucket)` → rows kept sorted by message_id DESC, like the Cassandra clustering order. */
export class InMemoryMessageStore implements MessageStore {
  private readonly partitions = new Map<string, Message[]>();
  private readonly dedup = new Map<string, { message_id: MessageId; expires_at: number }>();
  private readonly now: () => number;
  private readonly dedupTtlMs: number;
  /** Instrumentation for tests: how many partition reads happened (design §2.3 bucket walk). */
  public partitionReads = 0;

  constructor(opts: InMemoryMessageStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.dedupTtlMs = opts.dedupTtlMs ?? DAY_MS;
  }

  private key(conversation_id: ConversationId, bucket: number): string {
    return `${conversation_id}:${bucket}`;
  }

  async insert(message: Message): Promise<void> {
    const key = this.key(message.conversation_id, message.bucket);
    let rows = this.partitions.get(key);
    if (!rows) {
      rows = [];
      this.partitions.set(key, rows);
    }
    const existing = rows.findIndex((r) => r.message_id === message.message_id);
    if (existing >= 0) rows[existing] = message;
    else {
      rows.push(message);
      rows.sort((a, b) => compareIds(b.message_id, a.message_id));
    }
    this.dedup.set(`${message.sender_id}|${message.client_msg_id}`, {
      message_id: message.message_id,
      expires_at: this.now() + this.dedupTtlMs,
    });
  }

  async get(conversation_id: ConversationId, message_id: MessageId): Promise<Message | undefined> {
    for (const [key, rows] of this.partitions) {
      if (!key.startsWith(`${conversation_id}:`)) continue;
      const hit = rows.find((r) => r.message_id === message_id);
      if (hit) return hit;
    }
    return undefined;
  }

  async getMany(refs: MessageRef[]): Promise<Message[]> {
    const out: Message[] = [];
    for (const ref of refs) {
      const m = await this.get(ref.conversation_id, ref.message_id);
      if (m) out.push(m);
    }
    return out;
  }

  async readPartition(conversation_id: ConversationId, bucket: number, opts: ReadPartitionOptions): Promise<Message[]> {
    this.partitionReads += 1;
    const rows = this.partitions.get(this.key(conversation_id, bucket)) ?? [];
    let filtered = rows.filter(
      (r) =>
        (opts.before === undefined || compareIds(r.message_id, opts.before) < 0) &&
        (opts.after === undefined || compareIds(r.message_id, opts.after) > 0),
    );
    if (opts.order === 'asc') filtered = filtered.slice().reverse();
    return filtered.slice(0, opts.limit);
  }

  async findByClientMsgId(sender_id: UserId, client_msg_id: string): Promise<MessageId | undefined> {
    const hit = this.dedup.get(`${sender_id}|${client_msg_id}`);
    if (!hit) return undefined;
    if (hit.expires_at < this.now()) {
      this.dedup.delete(`${sender_id}|${client_msg_id}`);
      return undefined;
    }
    return hit.message_id;
  }

  async countAfter(conversation_id: ConversationId, bucket: number, after: MessageId, cap: number): Promise<number> {
    this.partitionReads += 1;
    const rows = this.partitions.get(this.key(conversation_id, bucket)) ?? [];
    let n = 0;
    for (const r of rows) {
      if (compareIds(r.message_id, after) > 0) n += 1;
      if (n >= cap) return cap;
    }
    return n;
  }
}
