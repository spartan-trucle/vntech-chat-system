import type { DeviceId, UserId } from '../protocol.js';
import type { DeviceRecord, Devices } from './Devices.js';

export class InMemoryDevices implements Devices {
  private readonly rows = new Map<DeviceId, DeviceRecord>();

  async register(device: DeviceRecord): Promise<void> {
    if (!this.rows.has(device.device_id)) this.rows.set(device.device_id, { ...device });
  }

  async get(device_id: DeviceId): Promise<DeviceRecord | undefined> {
    const row = this.rows.get(device_id);
    return row ? { ...row } : undefined;
  }

  async devicesOf(user_id: UserId): Promise<DeviceRecord[]> {
    return [...this.rows.values()].filter((d) => d.user_id === user_id).map((d) => ({ ...d }));
  }
}
