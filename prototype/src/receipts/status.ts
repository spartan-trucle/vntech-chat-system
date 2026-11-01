/**
 * Message status for its sender, derived from the cursor partitions of design §3.3 and
 * never stored: *read* if every other member's read cursor is ≥ the id, *delivered* if
 * every device of every other member has a delivery cursor ≥ the id, else *sent*.
 *
 * Pure: the caller does the two partition reads (`readCursors`, `deliveryCursors`) and
 * hands them in, so "who has read N" costs one partition read and a compare.
 */

import { compareIds, type MessageId } from '../ids.js';
import type { DeviceRecord } from '../ports/index.js';
import type { DeviceId, Message, UserId } from '../protocol.js';

export type MessageStatus = 'read' | 'delivered' | 'sent';

export interface StatusReport {
  status: MessageStatus;
  /** Other members whose read cursor is ≥ the message id, in member order. */
  read_by: UserId[];
  /** Devices of other members whose delivery cursor is ≥ the message id, in member then device order. */
  delivered_to: DeviceId[];
}

const atLeast = (cursor: MessageId | undefined, id: MessageId): boolean => cursor !== undefined && compareIds(cursor, id) >= 0;

export function statusOf(
  message: Message,
  memberReadCursors: ReadonlyMap<UserId, MessageId>,
  deviceDeliveryCursors: ReadonlyMap<DeviceId, MessageId>,
  members: readonly UserId[],
  devices: readonly DeviceRecord[],
): StatusReport {
  const id = message.message_id;
  const others = members.filter((m) => m !== message.sender_id);
  const read_by = others.filter((m) => atLeast(memberReadCursors.get(m), id));

  const delivered_to: DeviceId[] = [];
  // A member with no device has not received the message anywhere: the vacuous "all of
  // zero devices" reading is rejected on purpose.
  let everyDeviceDelivered = true;
  for (const member of others) {
    const theirs = devices.filter((d) => d.user_id === member);
    if (theirs.length === 0) everyDeviceDelivered = false;
    for (const d of theirs) {
      if (atLeast(deviceDeliveryCursors.get(d.device_id), id)) delivered_to.push(d.device_id);
      else everyDeviceDelivered = false;
    }
  }

  const status: MessageStatus = read_by.length === others.length ? 'read' : everyDeviceDelivered ? 'delivered' : 'sent';
  return { status, read_by, delivered_to };
}
