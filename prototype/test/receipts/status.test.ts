import { describe, expect, test } from 'vitest';
import { statusOf } from '../../src/receipts/status.js';
import type { DeviceRecord } from '../../src/ports/index.js';
import type { Message } from '../../src/protocol.js';

const message = (over: Partial<Message> = {}): Message => ({
  conversation_id: 'c2', bucket: 202611, message_id: '100', sender_id: 'truc', client_msg_id: 'cid', body: 'x',
  reply_to: null, media_key: null, media_size: null, media_mime: null, created_at: 0, ...over,
});
const dev = (device_id: string, user_id: string): DeviceRecord => ({ device_id, user_id, kind: 'phone' });

describe('statusOf: read / delivered / sent derived from cursors, never stored (design §3.3)', () => {
  const members = ['truc', 'khanh', 'linh'];
  const devices = [dev('A1', 'truc'), dev('A2', 'truc'), dev('B1', 'khanh'), dev('B2', 'khanh'), dev('C1', 'linh')];

  test('sent: nobody else has it yet; the sender\'s own cursors do not count', () => {
    const out = statusOf(message(), new Map([['truc', '100']]), new Map([['A1', '100'], ['A2', '100']]), members, devices);
    expect(out).toEqual({ status: 'sent', read_by: [], delivered_to: [] });
  });

  test('delivered: every device of every other member has a delivery cursor ≥ id', () => {
    const out = statusOf(
      message(),
      new Map(),
      new Map([['B1', '100'], ['B2', '150'], ['C1', '100']]),
      members, devices,
    );
    expect(out).toEqual({ status: 'delivered', read_by: [], delivered_to: ['B1', 'B2', 'C1'] });
  });

  test('one device of one member behind → still sent, the partial list says who has it', () => {
    const out = statusOf(message(), new Map(), new Map([['B1', '100'], ['B2', '99'], ['C1', '100']]), members, devices);
    expect(out).toEqual({ status: 'sent', read_by: [], delivered_to: ['B1', 'C1'] });
  });

  test('read: every other member\'s read cursor ≥ id, regardless of delivery cursors', () => {
    const out = statusOf(message(), new Map([['khanh', '100'], ['linh', '200']]), new Map(), members, devices);
    expect(out).toEqual({ status: 'read', read_by: ['khanh', 'linh'], delivered_to: [] });
  });

  test('one member read, one only delivered → delivered, read_by names the reader', () => {
    const out = statusOf(message(), new Map([['khanh', '100']]), new Map([['B1', '100'], ['B2', '100'], ['C1', '100']]), members, devices);
    expect(out).toEqual({ status: 'delivered', read_by: ['khanh'], delivered_to: ['B1', 'B2', 'C1'] });
  });

  test('comparison is numeric, not lexicographic', () => {
    const out = statusOf(message({ message_id: '9' }), new Map([['khanh', '10'], ['linh', '10']]), new Map(), members, devices);
    expect(out.status).toBe('read');
  });

  test('a member with no device at all blocks delivered (it has not received the message anywhere)', () => {
    const out = statusOf(message(), new Map(), new Map([['B1', '100'], ['B2', '100']]), members, devices.filter((d) => d.user_id !== 'linh'));
    expect(out).toEqual({ status: 'sent', read_by: [], delivered_to: ['B1', 'B2'] });
  });

  test('no other member → read (nothing outstanding)', () => {
    expect(statusOf(message(), new Map(), new Map(), ['truc'], devices).status).toBe('read');
  });
});
