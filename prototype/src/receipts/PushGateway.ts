/**
 * Push-notification port (design §3.6). A hint carries `{conversation_id, message_id,
 * sender_display_name}` and nothing else: the body never leaves our boundary and would go
 * stale on delete. The type has no `body` field on purpose; a test asserts the recorded
 * object carries none either.
 *
 * The in-memory adapter records what it would have sent; B9 can put APNs/FCM behind the
 * same interface and run `test/receipts/pushGateway.contract.ts` against it.
 */

import type { MessageId } from '../ids.js';
import type { ConversationId, DeviceId } from '../protocol.js';

export interface PushHint {
  conversation_id: ConversationId;
  message_id: MessageId;
  sender_display_name: string;
}

export interface PushGateway {
  push(device_id: DeviceId, hint: PushHint): Promise<void>;
}

export interface RecordedPush {
  device_id: DeviceId;
  hint: PushHint;
}

export class InMemoryPushGateway implements PushGateway {
  private readonly rows: RecordedPush[] = [];

  async push(device_id: DeviceId, hint: PushHint): Promise<void> {
    this.rows.push({
      device_id,
      hint: { conversation_id: hint.conversation_id, message_id: hint.message_id, sender_display_name: hint.sender_display_name },
    });
  }

  recorded(): RecordedPush[] {
    return this.rows.map((r) => ({ device_id: r.device_id, hint: { ...r.hint } }));
  }

  clear(): void {
    this.rows.length = 0;
  }
}
