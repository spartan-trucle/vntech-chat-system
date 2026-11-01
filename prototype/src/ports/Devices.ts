import type { DeviceId, UserId } from '../protocol.js';

export interface DeviceRecord {
  user_id: UserId;
  device_id: DeviceId;
  kind: 'phone' | 'laptop' | 'bot';
}

/**
 * Devices a user has ever connected with. Needed by anything that must reach devices
 * without a live route: the per-device sync queue (design §4.2) and push notifications
 * (§3.6). The route table (§1.5) knows only the connected ones.
 */
export interface Devices {
  register(device: DeviceRecord): Promise<void>;
  get(device_id: DeviceId): Promise<DeviceRecord | undefined>;
  devicesOf(user_id: UserId): Promise<DeviceRecord[]>;
}
