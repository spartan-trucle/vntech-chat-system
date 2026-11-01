import type { DeviceId, UserId } from '../protocol.js';

/** `route:{user_id}:{device_id} → server_id` of design §1.5, plus the per-user set behind `SCARD route:{user_id}`. */
export interface RouteTable {
  set(user_id: UserId, device_id: DeviceId, server_id: string): Promise<void>;
  get(user_id: UserId, device_id: DeviceId): Promise<string | undefined>;
  /** True if a route existed. */
  delete(user_id: UserId, device_id: DeviceId): Promise<boolean>;
  devicesOf(user_id: UserId): Promise<DeviceId[]>;
}
