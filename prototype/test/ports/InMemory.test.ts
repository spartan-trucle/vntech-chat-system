import { InMemoryMessageStore } from '../../src/ports/InMemoryMessageStore.js';
import { InMemorySyncQueue } from '../../src/ports/InMemorySyncQueue.js';
import { InMemoryRouteTable } from '../../src/ports/InMemoryRouteTable.js';
import { InMemoryPresenceStore } from '../../src/ports/InMemoryPresenceStore.js';
import { InMemorySummaries } from '../../src/ports/InMemorySummaries.js';
import { InMemoryConversations } from '../../src/ports/InMemoryConversations.js';
import { InMemoryCursors } from '../../src/ports/InMemoryCursors.js';
import { describeMessageStoreContract } from './contracts/messageStore.contract.js';
import { describeSyncQueueContract } from './contracts/syncQueue.contract.js';
import { describeRouteTableContract } from './contracts/routeTable.contract.js';
import { describePresenceStoreContract } from './contracts/presenceStore.contract.js';
import { describeSummariesContract } from './contracts/summaries.contract.js';
import { describeConversationsContract } from './contracts/conversations.contract.js';
import { describeCursorsContract } from './contracts/cursors.contract.js';

describeMessageStoreContract('InMemoryMessageStore', () => {
  let now = 1_000_000;
  return { store: new InMemoryMessageStore({ now: () => now }), advance: (ms) => { now += ms; } };
});
describeSyncQueueContract('InMemorySyncQueue', (opts = {}) => {
  const q = new InMemorySyncQueue({ ...(opts.maxLen === undefined ? {} : { maxLen: opts.maxLen }), ...(opts.xaddTimeoutMs === undefined ? {} : { xaddTimeoutMs: opts.xaddTimeoutMs }) });
  if (opts.xaddDelayMs !== undefined) q.faults.xaddDelayMs = opts.xaddDelayMs;
  return q;
});
describeRouteTableContract('InMemoryRouteTable', () => new InMemoryRouteTable());
describePresenceStoreContract('InMemoryPresenceStore', () => {
  let now = 1_000_000;
  return { store: new InMemoryPresenceStore({ now: () => now }), advance: (ms) => { now += ms; } };
});
describeSummariesContract('InMemorySummaries', () => new InMemorySummaries());
describeConversationsContract('InMemoryConversations', () => new InMemoryConversations());
describeCursorsContract('InMemoryCursors', () => new InMemoryCursors());
import { InMemoryDevices } from '../../src/ports/InMemoryDevices.js';
import { describeDevicesContract } from './contracts/devices.contract.js';
describeDevicesContract('InMemoryDevices', () => new InMemoryDevices());
