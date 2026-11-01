import type { Message } from '../../../src/protocol.js';

/** Builds a message row for tests; `message_id` is the only thing that has to be unique. */
export function msg(over: Partial<Message> & { message_id: string }): Message {
  return {
    conversation_id: 'c1',
    bucket: 202611,
    sender_id: 'truc',
    client_msg_id: `cm-${over.message_id}`,
    body: `body ${over.message_id}`,
    reply_to: null,
    media_key: null,
    media_size: null,
    media_mime: null,
    created_at: 0,
    ...over,
  };
}
