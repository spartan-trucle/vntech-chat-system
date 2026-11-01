import type { DeviceId, UserId } from '../protocol.js';
import type { RouteTable } from './RouteTable.js';

export class InMemoryRouteTable implements RouteTable {
  private readonly routes = new Map<UserId, Map<DeviceId, string>>();

  async set(user_id: UserId, device_id: DeviceId, server_id: string): Promise<void> {
    let devices = this.routes.get(user_id);
    if (!devices) {
      devices = new Map();
      this.routes.set(user_id, devices);
    }
    devices.set(device_id, server_id);
  }

  async get(user_id: UserId, device_id: DeviceId): Promise<string | undefined> {
    return this.routes.get(user_id)?.get(device_id);
  }

  async delete(user_id: UserId, device_id: DeviceId): Promise<boolean> {
    const devices = this.routes.get(user_id);
    if (!devices) return false;
    const had = devices.delete(device_id);
    if (devices.size === 0) this.routes.delete(user_id);
    return had;
  }

  async devicesOf(user_id: UserId): Promise<DeviceId[]> {
    return [...(this.routes.get(user_id)?.keys() ?? [])];
  }
}
