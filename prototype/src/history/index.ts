/**
 * B4 · history page API, conversation summary and the slow path (design §2.3, §4.3, §4.5;
 * scenario S4). HTTPS beside the socket:
 *
 *   GET /conversations/:id/messages?limit&before|after   page, scroll up, page down (§2.3)
 *   GET /conversations/:id/messages/:message_id          jump by key plus a window around it (§2.3, F10)
 *   GET /conversations?since&limit                       chat list from the summary rows (§4.3)
 *
 * and a `message_stored` listener that keeps `conv:{id}:summary` current on every write.
 *
 * No auth (runtime ADR) and `HttpRequest` carries no headers, so the caller names itself in
 * the query string: `user_id` (required; 403 unless a member) and `device_id` (for the trace
 * only). The slow path, a cold open or a full-list load, takes a token from one bucket per
 * server first; an empty bucket is a 429 with `retry_after_ms`. That rate limit is the
 * sync-queue ADR's precondition for relying on the queue (design §4.5).
 */

import { bucketOf, bucketOfTime, type MessageId } from '../ids.js';
import type { Conversation } from '../ports/index.js';
import type { Message, UserId } from '../protocol.js';
import { deviceName, USERS } from '../fixtures.js';
import type { HttpRequest, HttpResponse, ServerContext } from '../server.js';
import { largestId, smallestId, walkBack, walkForward } from './buckets.js';
import { TokenBucket } from './tokenBucket.js';

export interface HistoryOptions {
  /** Tokens the slow path may spend in a burst (cold opens plus full-list loads). */
  slowPathCapacity: number;
  /** Tokens given back per second. */
  slowPathRefillPerSecond: number;
}

export const DEFAULT_HISTORY_OPTIONS: HistoryOptions = { slowPathCapacity: 100, slowPathRefillPerSecond: 50 };

/** `ctx.moduleOptions['history']`, with defaults for whatever the caller left out. */
export function resolveHistoryOptions(raw: unknown): HistoryOptions {
  const given = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<HistoryOptions>;
  return {
    slowPathCapacity: given.slowPathCapacity ?? DEFAULT_HISTORY_OPTIONS.slowPathCapacity,
    slowPathRefillPerSecond: given.slowPathRefillPerSecond ?? DEFAULT_HISTORY_OPTIONS.slowPathRefillPerSecond,
  };
}

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;
export const DEFAULT_LIST_LIMIT = 200;
export const MAX_LIST_LIMIT = 200;
export const UNREAD_CAP = 99;

// ---- response shapes (what B8's scenarios parse) ---------------------------------------

export interface PageResponse {
  messages: Message[];
  /** Smallest id returned: the `before` of the next scroll-up. Null for an empty page. */
  next_before: MessageId | null;
  /** Largest id returned on an `after` page: the `after` of the next page down. Null otherwise. */
  next_after: MessageId | null;
}

export interface JumpResponse {
  message: Message;
  /** Rows strictly older than the anchor, newest first. */
  before: Message[];
  /** Rows strictly newer than the anchor, oldest first. */
  after: Message[];
}

export interface ListRow {
  conversation_id: string;
  last_message_id: MessageId;
  last_preview: string;
  last_sender: UserId;
  last_at: number;
  my_read_cursor: MessageId | null;
  /** Rows above the read cursor in the last message's bucket, never above `UNREAD_CAP`. */
  unread_count: number;
  /** True when the count hit the cap; the client renders `99+`. */
  unread_capped: boolean;
}

export interface ListResponse {
  conversations: ListRow[];
  /** Largest `last_at` returned (or `since` when nothing changed): the next `since`. */
  list_cursor: number;
}

export interface RateLimited {
  error: 'slow_path_rate_limited';
  retry_after_ms: number;
}

// ---- request parsing ---------------------------------------------------------------------

const error = (status: number, code: string): HttpResponse => ({ status, body: { error: code } });

class BadRequest extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const ID_RE = /^\d{1,20}$/;

function parseLimit(raw: string | undefined, fallback: number, max: number, min = 1): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new BadRequest('bad_limit');
  const n = Number(raw);
  if (n < min || n > max) throw new BadRequest('bad_limit');
  return n;
}

function parseCursor(raw: string | undefined): MessageId | undefined {
  if (raw === undefined) return undefined;
  if (!ID_RE.test(raw)) throw new BadRequest('bad_cursor');
  return raw;
}

/** `Truc·phone` when a device_id is given, else the user's display name. */
function callerName(user_id: UserId, device_id: string | undefined): string {
  if (device_id) return deviceName(device_id, user_id);
  return USERS[user_id]?.name ?? user_id;
}

/** `GET /conversations/c1/messages?limit=50`: the request line as the page's trace prints it. */
function requestLine(req: HttpRequest, keys: string[]): string {
  const qs = keys.filter((k) => req.query[k] !== undefined).map((k) => `${k}=${req.query[k]}`).join('&');
  return `GET ${req.path}${qs ? `?${qs}` : ''}`;
}

export function registerHistory(ctx: ServerContext): void {
  const opts = resolveHistoryOptions(ctx.moduleOptions['history']);
  const slowPath = new TokenBucket({ capacity: opts.slowPathCapacity, refillPerSecond: opts.slowPathRefillPerSecond, now: () => ctx.clock.now() });

  /** Identity stand-in (no auth): `user_id` from the query, then membership. */
  const identify = async (req: HttpRequest, conversation_id: string): Promise<{ user_id: UserId; conversation: Conversation; who: string } | HttpResponse> => {
    const user_id = req.query['user_id'];
    if (!user_id) return error(400, 'missing_user_id');
    const conversation = await ctx.ports.conversations.get(conversation_id);
    if (!conversation) return error(404, 'not_found');
    if (!conversation.members.includes(user_id)) return error(403, 'not_member');
    return { user_id, conversation, who: callerName(user_id, req.query['device_id']) };
  };

  /** One token for a cold open or a full-list load; 429 with the wait when the bucket is empty. */
  const chargeSlowPath = (line: string, who: string): HttpResponse | undefined => {
    const taken = slowPath.take();
    if (taken.ok) return undefined;
    ctx.trace.add('http', `429 slow path: ${line} ← ${who}, retry in ${taken.retry_after_ms} ms`);
    const body: RateLimited = { error: 'slow_path_rate_limited', retry_after_ms: taken.retry_after_ms };
    return { status: 429, body };
  };

  const handle = async (req: HttpRequest, fn: () => Promise<HttpResponse>): Promise<HttpResponse> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof BadRequest) return error(400, e.code);
      throw e;
    }
  };

  // ---- page: open, scroll up, page down (design §2.3) ----
  ctx.http.route('GET', '/conversations/:id/messages', (req) => handle(req, async () => {
    const id = req.params['id'] ?? '';
    const identity = await identify(req, id);
    if ('status' in identity) return identity;
    const limit = parseLimit(req.query['limit'], DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
    const before = parseCursor(req.query['before']);
    const after = parseCursor(req.query['after']);
    if (before !== undefined && after !== undefined) throw new BadRequest('bad_cursor');
    const line = requestLine(req, ['limit', 'before', 'after']);

    if (before === undefined && after === undefined) {
      // Cold open: the device has no cache, this is the slow path.
      const limited = chargeSlowPath(line, identity.who);
      if (limited) return limited;
    }

    const store = ctx.ports.messages;
    const floor = identity.conversation.created_bucket;
    const nowBucket = bucketOfTime(ctx.clock.now());
    const walk = after !== undefined
      ? await walkForward(store, id, { startBucket: bucketOf(after), ceilBucket: nowBucket, after, limit })
      : before !== undefined
        ? await walkBack(store, id, { startBucket: bucketOf(before), floorBucket: floor, before, limit })
        : await walkBack(store, id, { startBucket: nowBucket, floorBucket: floor, limit });

    const visited = walk.buckets;
    const where = visited.length <= 1
      ? `(bucket ${visited[0] ?? nowBucket})`
      : `(buckets ${visited[0]}→${visited[visited.length - 1]}, ${visited.length} reads)`;
    ctx.trace.add('http', `${line} ← ${identity.who} ${where}`);

    const body: PageResponse = {
      messages: walk.messages,
      next_before: after === undefined ? smallestId(walk.messages) : null,
      next_after: after !== undefined ? largestId(walk.messages) : null,
    };
    return { status: 200, body };
  }));
}
