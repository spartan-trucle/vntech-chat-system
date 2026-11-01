/**
 * The month-bucket walk of design §2.3. `readPartition` is one partition read
 * `(conversation_id, bucket)`; these loops visit buckets one at a time and stop as soon as
 * `limit` rows are in hand or the conversation's first month (backward) / the current month
 * (forward) is passed. The reads are the cost: a conversation idle for n months costs n empty
 * partition reads once, which is why the caller counts `buckets`.
 */

import { compareIds, type MessageId } from '../ids.js';
import type { MessageStore } from '../ports/index.js';
import type { ConversationId, Message } from '../protocol.js';

/** `year*100+month` → the month before; January rolls back a year. */
export function prevBucket(bucket: number): number {
  return bucket % 100 === 1 ? bucket - 100 + 11 : bucket - 1;
}

/** `year*100+month` → the month after; December rolls forward a year. */
export function nextBucket(bucket: number): number {
  return bucket % 100 === 12 ? bucket + 100 - 11 : bucket + 1;
}

export interface WalkResult {
  messages: Message[];
  /** Buckets visited, in visiting order; `length` is the number of partition reads. */
  buckets: number[];
}

export interface WalkBackOptions {
  startBucket: number;
  /** `conversation.created_bucket`: the walk never reads below it. */
  floorBucket: number;
  /** Rows strictly below this id (scroll up). */
  before?: MessageId;
  limit: number;
}

/** Newest-first rows from `startBucket` down to `floorBucket`, at most `limit`. */
export async function walkBack(store: MessageStore, conversation_id: ConversationId, opts: WalkBackOptions): Promise<WalkResult> {
  const messages: Message[] = [];
  const buckets: number[] = [];
  for (let bucket = opts.startBucket; bucket >= opts.floorBucket && messages.length < opts.limit; bucket = prevBucket(bucket)) {
    buckets.push(bucket);
    const read: Parameters<MessageStore['readPartition']>[2] = { limit: opts.limit - messages.length, order: 'desc' };
    if (opts.before !== undefined) read.before = opts.before;
    messages.push(...(await store.readPartition(conversation_id, bucket, read)));
  }
  return { messages, buckets };
}

export interface WalkForwardOptions {
  startBucket: number;
  /** The current month: nothing is ever written above it. */
  ceilBucket: number;
  /** Rows strictly above this id. */
  after: MessageId;
  limit: number;
}

/** Oldest-first rows above `after`, from `startBucket` up to `ceilBucket`, at most `limit`. */
export async function walkForward(store: MessageStore, conversation_id: ConversationId, opts: WalkForwardOptions): Promise<WalkResult> {
  const messages: Message[] = [];
  const buckets: number[] = [];
  for (let bucket = opts.startBucket; bucket <= opts.ceilBucket && messages.length < opts.limit; bucket = nextBucket(bucket)) {
    buckets.push(bucket);
    messages.push(...(await store.readPartition(conversation_id, bucket, { after: opts.after, limit: opts.limit - messages.length, order: 'asc' })));
  }
  return { messages, buckets };
}

/** Smallest id of a page, the `before` cursor of the next scroll-up; null for an empty page. */
export function smallestId(messages: Message[]): MessageId | null {
  return messages.reduce<MessageId | null>((min, m) => (min === null || compareIds(m.message_id, min) < 0 ? m.message_id : min), null);
}

/** Largest id of a page, the `after` cursor of the next page down; null for an empty page. */
export function largestId(messages: Message[]): MessageId | null {
  return messages.reduce<MessageId | null>((max, m) => (max === null || compareIds(m.message_id, max) > 0 ? m.message_id : max), null);
}
