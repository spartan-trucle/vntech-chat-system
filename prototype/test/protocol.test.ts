import { describe, expect, test } from 'vitest';
import { decodeFrame, encodeFrame, FrameError, type ClientFrame, type ServerFrame } from '../src/protocol.js';

const clientFrames: ClientFrame[] = [
  { t: 'hello', device_id: 'A1', user_id: 'truc', last_synced_message_id: null, list_cursor: null, app_state: 'foreground' },
  { t: 'hello', device_id: 'A1', user_id: 'truc', last_synced_message_id: '123-0', list_cursor: 1700000000000, app_state: 'background' },
  { t: 'msg', client_msg_id: 'c-1', conversation_id: 'c1', body: 'hi' },
  { t: 'msg', client_msg_id: 'c-2', conversation_id: 'c1', body: '', reply_to: '41', media_key: 'ap-southeast-1/2026/11/u1' },
  { t: 'msg', client_msg_id: 'c-3', conversation_id: 'c1', body: 'pic', media_key: 'ap-southeast-1/2026/11/u1', media_size: 4404019, media_mime: 'image/jpeg', sha256: 'ab'.repeat(32) },
  { t: 'ack', up_to_stream_id: '55-0' },
  { t: 'receipt', conversation_id: 'c1', last_read_id: '41' },
  { t: 'watch', user_ids: ['khanh', 'linh'] },
  { t: 'unwatch', user_ids: ['khanh'] },
];

const serverFrames: ServerFrame[] = [
  { t: 'hello_ack', server_time: 1 },
  { t: 'hello_ack', server_time: 1, slow_path: true },
  { t: 'msg_ack', client_msg_id: 'c-1', message_id: '41' },
  {
    t: 'deliver',
    stream_id: '1761955200000-0',
    replay: true,
    message: {
      conversation_id: 'c1', bucket: 202611, message_id: '41', sender_id: 'truc', client_msg_id: 'c-1',
      body: 'hi', reply_to: null, media_key: null, media_size: null, media_mime: null, sha256: null, created_at: 1,
    },
  },
  {
    t: 'deliver',
    stream_id: '1761955200000-1',
    replay: false,
    message: {
      conversation_id: 'c1', bucket: 202611, message_id: '42', sender_id: 'truc', client_msg_id: 'c-2',
      body: 'live', reply_to: null, media_key: null, media_size: null, media_mime: null, sha256: null, created_at: 2,
    },
  },
  { t: 'replay_done' },
  { t: 'receipt', conversation_id: 'c1', user_id: 'khanh', last_read_id: '41' },
  { t: 'presence', user_id: 'khanh', state: 'online' },
  { t: 'presence', user_id: 'khanh', state: 'offline', last_seen: 1700000000000 },
  { t: 'error', code: 'bad_frame', message: 'nope' },
];

describe('protocol frames', () => {
  test.each(clientFrames)('client frame round-trips: %o', (frame) => {
    expect(decodeFrame(encodeFrame(frame), 'client')).toEqual(frame);
  });

  test.each(serverFrames)('server frame round-trips: %o', (frame) => {
    expect(decodeFrame(encodeFrame(frame), 'server')).toEqual(frame);
  });

  test('rejects an unknown frame type', () => {
    expect(() => decodeFrame('{"t":"nope"}', 'client')).toThrow(FrameError);
  });

  test('rejects a client frame missing a required field', () => {
    expect(() => decodeFrame('{"t":"msg","conversation_id":"c1","body":"x"}', 'client')).toThrow(FrameError);
  });

  test('rejects a server frame on the client side and vice versa', () => {
    expect(() => decodeFrame('{"t":"msg_ack","client_msg_id":"c","message_id":"1"}', 'client')).toThrow(FrameError);
    expect(() => decodeFrame('{"t":"ack","up_to_stream_id":"1-0"}', 'server')).toThrow(FrameError);
  });

  test('media metadata is only valid together with media_key (design §6.2)', () => {
    expect(() => decodeFrame('{"t":"msg","client_msg_id":"c","conversation_id":"c1","body":"x","media_size":10}', 'client')).toThrow(FrameError);
    expect(() => decodeFrame('{"t":"msg","client_msg_id":"c","conversation_id":"c1","body":"x","media_mime":"image/png"}', 'client')).toThrow(FrameError);
    expect(() => decodeFrame('{"t":"msg","client_msg_id":"c","conversation_id":"c1","body":"x","sha256":"ab"}', 'client')).toThrow(FrameError);
  });

  test('deliver requires the replay flag, a boolean (replay-mode ADR): a frame without it, or with a string, is refused', () => {
    const message = '{"conversation_id":"c1","bucket":202611,"message_id":"41","sender_id":"truc","client_msg_id":"c-1","body":"hi","reply_to":null,"media_key":null,"media_size":null,"media_mime":null,"sha256":null,"created_at":1}';
    expect(() => decodeFrame(`{"t":"deliver","stream_id":"1-0","message":${message}}`, 'server')).toThrow(/deliver: missing field replay/);
    expect(() => decodeFrame(`{"t":"deliver","stream_id":"1-0","replay":"yes","message":${message}}`, 'server')).toThrow(/deliver: field replay has the wrong type/);
  });

  test('replay_done carries nothing but its type and is a server frame only', () => {
    expect(decodeFrame('{"t":"replay_done"}', 'server')).toEqual({ t: 'replay_done' });
    expect(() => decodeFrame('{"t":"replay_done"}', 'client')).toThrow(FrameError);
  });

  test('rejects non-JSON', () => {
    expect(() => decodeFrame('not json', 'client')).toThrow(FrameError);
  });
});
