/**
 * The identities of docs/prototype/index.html, so a scenario trace reads like the page:
 * Truc on a phone and a laptop, Khanh on a phone; Linh, Minh and An are scripted members.
 */

import type { Conversation, Conversations, Devices } from './ports/index.js';
import type { DeviceId, UserId } from './protocol.js';

export interface FixtureDevice {
  device_id: DeviceId;
  user_id: UserId;
  kind: 'phone' | 'laptop' | 'bot';
  /** Display name in the trace, `User·kind`, as `devName()` on the page. */
  name: string;
}

export const USERS: Record<UserId, { name: string }> = {
  truc: { name: 'Truc' },
  khanh: { name: 'Khanh' },
  linh: { name: 'Linh' },
  minh: { name: 'Minh' },
  an: { name: 'An' },
};

export const DEVICES = {
  trucPhone: { device_id: 'A1', user_id: 'truc', kind: 'phone', name: 'Truc·phone' },
  trucLaptop: { device_id: 'A2', user_id: 'truc', kind: 'laptop', name: 'Truc·laptop' },
  khanhPhone: { device_id: 'B1', user_id: 'khanh', kind: 'phone', name: 'Khanh·phone' },
  linhBot: { device_id: 'C1', user_id: 'linh', kind: 'bot', name: 'Linh·bot' },
  minhBot: { device_id: 'D1', user_id: 'minh', kind: 'bot', name: 'Minh·bot' },
  anBot: { device_id: 'E1', user_id: 'an', kind: 'bot', name: 'An·bot' },
} as const satisfies Record<string, FixtureDevice>;

export const CONVERSATIONS: Conversation[] = [
  { conversation_id: 'c1', type: 'dm', members: ['truc', 'khanh'], created_bucket: 202601 },
  { conversation_id: 'c2', type: 'group', name: 'vntech design', members: ['truc', 'khanh', 'linh', 'minh', 'an'], created_bucket: 202601 },
  { conversation_id: 'c3', type: 'dm', members: ['truc', 'linh'], created_bucket: 202601 },
];

/** `devName()` of the page: `Truc·phone`, or the raw id for an unknown device. */
export function deviceName(device_id: DeviceId, user_id?: UserId, kind?: string): string {
  for (const d of Object.values(DEVICES)) if (d.device_id === device_id) return d.name;
  if (user_id) {
    const user = USERS[user_id]?.name ?? user_id;
    return `${user}·${kind ?? 'device'}`;
  }
  return device_id;
}

export async function seedFixtures(ports: { conversations: Conversations; devices: Devices }): Promise<void> {
  for (const c of CONVERSATIONS) await ports.conversations.create(c);
  for (const d of Object.values(DEVICES)) await ports.devices.register({ user_id: d.user_id, device_id: d.device_id, kind: d.kind });
}
