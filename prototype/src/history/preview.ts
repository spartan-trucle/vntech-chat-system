/**
 * `last_preview` of the `conv:{id}:summary` row (design §4.3): enough of the body for a
 * chat-list line, never the whole message. A media-only message shows as `[media]`.
 */

import type { Message } from '../protocol.js';

export const PREVIEW_CHARS = 80;

export function previewOf(message: Pick<Message, 'body' | 'media_key'>): string {
  const body = message.body.trim();
  if (body.length === 0) return message.media_key ? '[media]' : '';
  const chars = [...body];
  return chars.length <= PREVIEW_CHARS ? body : `${chars.slice(0, PREVIEW_CHARS).join('')}…`;
}
