/**
 * B7 · media stub: upload intent and signed-URL download (design §6.2, §6.3, §6.4; scenario S6).
 *
 * The server never touches a media byte (media ADR). This module mints two kinds of
 * stand-in URLs and keeps two small tables in memory:
 *
 *   intents   media_key → {uploader, size, mime, sha256, created_at}   written by POST /media/intent
 *   sent      media_key → {conversation_id, message_id}                 written on `message_stored`
 *
 * `POST /media/intent?user_id=` validates the size against the 10 MB cap and answers with a
 * `stub://bucket/<key>` PUT URL carrying the content-length and content-type conditions the
 * real pre-signed URL would. `GET /media/:region/:yyyy/:mm/:uuid/url?user_id=` authorizes at
 * minting time against membership of the conversation the key was sent in (the uploader may
 * fetch before any message carries the key) and answers with a 1 h bearer-looking URL whose
 * host is the CDN for group conversations and the bucket for 1:1 (design §6.4).
 *
 * No auth in the prototype: `?user_id=` is the caller's identity. `media_size`/`media_mime`
 * on the stored row stay null; the `msg` frame carries `media_key` only (protocol gap, C2).
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { ConversationId, UserId } from '../protocol.js';
import type { MessageId } from '../ids.js';
import type { HttpRequest, HttpResponse, ServerContext } from '../server.js';

export interface MediaOptions {
  /** Region recorded in the key and selecting the bucket (design §6.4). */
  region: string;
  /** Upload cap the storage enforces through the pre-signed URL's content-length condition. */
  capBytes: number;
  /** Life of the pre-signed PUT. */
  putTtlS: number;
  /** Life of the signed GET: a 1 h bearer URL (design §6.3). */
  getTtlMs: number;
}

export const DEFAULT_MEDIA_OPTIONS: MediaOptions = {
  region: 'ap-southeast-1',
  capBytes: 10 * 1024 * 1024,
  putTtlS: 600,
  getTtlMs: 3_600_000,
};

/** `ctx.moduleOptions['media']`, with defaults for whatever the caller left out. */
export function resolveMediaOptions(raw: unknown): MediaOptions {
  const given = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<MediaOptions>;
  return {
    region: given.region ?? DEFAULT_MEDIA_OPTIONS.region,
    capBytes: given.capBytes ?? DEFAULT_MEDIA_OPTIONS.capBytes,
    putTtlS: given.putTtlS ?? DEFAULT_MEDIA_OPTIONS.putTtlS,
    getTtlMs: given.getTtlMs ?? DEFAULT_MEDIA_OPTIONS.getTtlMs,
  };
}

export interface MediaIntent {
  media_key: string;
  uploader: UserId;
  size: number;
  mime: string;
  sha256: string;
  created_at: number;
}

interface SentIn {
  conversation_id: ConversationId;
  message_id: MessageId;
}

const MB = 1024 * 1024;
const fmtMB = (bytes: number): string => `${(bytes / MB).toFixed(1).replace(/\.0$/, '')} MB`;

export function registerMedia(ctx: ServerContext): () => void {
  const opts = resolveMediaOptions(ctx.moduleOptions['media']);
  const intents = new Map<string, MediaIntent>();
  /** `(uploader, sha256) → media_key`, so a file already sent is not uploaded again (design §6.2). */
  const bySha = new Map<string, string>();
  const sent = new Map<string, SentIn>();

  const bad = (message: string): HttpResponse => ({ status: 400, body: { error: 'bad_request', message } });

  ctx.http.route('POST', '/media/intent', (req: HttpRequest): HttpResponse => {
    const user_id = req.query['user_id'];
    if (!user_id) return bad('user_id query parameter is required (no auth in the prototype)');
    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return bad('body must be a JSON object {size, mime, sha256}');
    const { size, mime, sha256 } = body as Record<string, unknown>;
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) return bad('size must be a non-negative integer (bytes)');
    if (typeof mime !== 'string' || mime.length === 0) return bad('mime must be a string');
    if (typeof sha256 !== 'string' || sha256.length === 0) return bad('sha256 must be a string');

    ctx.trace.add('http', `POST /media/intent {size:${fmtMB(size)}, mime:${mime}} ← ${user_id}`);
    if (size > opts.capBytes) {
      ctx.trace.add('media', `413: ${fmtMB(size)} > ${fmtMB(opts.capBytes)} cap; no upload link minted`);
      return { status: 413, body: { error: 'too_large', cap: opts.capBytes } };
    }

    const shaKey = `${user_id}\u0000${sha256}`;
    let media_key = bySha.get(shaKey);
    if (media_key === undefined) {
      const now = new Date(ctx.clock.now());
      const yyyy = String(now.getUTCFullYear());
      const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
      media_key = `${opts.region}/${yyyy}/${mm}/${randomUUID()}`;
      intents.set(media_key, { media_key, uploader: user_id, size, mime, sha256, created_at: ctx.clock.now() });
      bySha.set(shaKey, media_key);
    } else {
      ctx.trace.add('media', `same sha256 from ${user_id} → ${media_key} again, no re-upload`);
    }
    ctx.trace.add('media', `pre-signed PUT, ${Math.round(opts.putTtlS / 60)} min, content-length=${size} → ${media_key}`);
    return {
      status: 200,
      body: { media_key, put_url: `stub://bucket/${media_key}`, expires_in_s: opts.putTtlS, content_length: size, content_type: mime },
    };
  });

  ctx.http.route('GET', '/media/:region/:yyyy/:mm/:uuid/url', async (req: HttpRequest): Promise<HttpResponse> => {
    const user_id = req.query['user_id'];
    if (!user_id) return bad('user_id query parameter is required (no auth in the prototype)');
    const { region, yyyy, mm, uuid } = req.params;
    const media_key = `${region}/${yyyy}/${mm}/${uuid}`;
    const intent = intents.get(media_key);
    if (!intent) return { status: 404, body: { error: 'not_found' } };

    const where = sent.get(media_key);
    let host: 'cdn' | 'bucket';
    let why: string;
    if (!where) {
      // Not referenced by any message yet: only the uploader can look at it.
      if (intent.uploader !== user_id) {
        ctx.trace.add('http', `GET /media/${uuid}/url ← ${user_id} → 403, not sent yet and not the uploader`);
        return { status: 403, body: { error: 'forbidden' } };
      }
      host = 'bucket';
      why = 'uploader, not sent yet';
    } else {
      if (!(await ctx.ports.conversations.isMember(where.conversation_id, user_id))) {
        ctx.trace.add('http', `GET /media/${uuid}/url ← ${user_id} → 403, not a member of ${where.conversation_id}`);
        return { status: 403, body: { error: 'forbidden' } };
      }
      const conversation = await ctx.ports.conversations.get(where.conversation_id);
      host = conversation?.type === 'group' ? 'cdn' : 'bucket';
      why = `member of ${where.conversation_id}`;
    }
    const expires_at = ctx.clock.now() + opts.getTtlMs;
    const sig = randomBytes(16).toString('hex');
    ctx.trace.add('http', `GET /media/${uuid}/url ← ${user_id} → ${why}, signed ${Math.round(opts.getTtlMs / 60_000 / 60)} h, host=${host}`
      + (host === 'cdn' ? ' (group: CDN in front)' : ' (dm: straight from the bucket)'));
    return { status: 200, body: { get_url: `stub://${host}/${media_key}?sig=${sig}&exp=${expires_at}`, expires_at, host } };
  });

  // The first message that carries a key decides which conversation authorizes its download.
  const offStored = ctx.events.on('message_stored', ({ message }) => {
    if (message.media_key && !sent.has(message.media_key)) {
      sent.set(message.media_key, { conversation_id: message.conversation_id, message_id: message.message_id });
    }
  });

  return () => {
    offStored();
    intents.clear();
    bySha.clear();
    sent.clear();
  };
}
