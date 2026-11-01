/**
 * Hop trace in the format of docs/prototype/index.html: one row per hop,
 * `HH:MM:SS  tag  text`, so a scenario run can be compared with the page by eye.
 */

export type TraceTag =
  | 'hb' | 'store' | 'ack' | 'queue' | 'push' | 'lost' | 'dedup' | 'receipt'
  | 'presence' | 'apns' | 'http' | 'media' | 'note'
  // client-side rows use the frame type as the tag
  | string;

export interface TraceRow {
  at: number;
  tag: TraceTag;
  text: string;
}

export class Trace {
  private readonly buffer: TraceRow[] = [];
  private readonly now: () => number;
  private readonly max: number;

  constructor(opts: { now?: () => number; max?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.max = opts.max ?? 2000;
  }

  add(tag: TraceTag, text: string): void {
    this.buffer.push({ at: this.now(), tag, text });
    if (this.buffer.length > this.max) this.buffer.shift();
  }

  rows(): readonly TraceRow[] {
    return this.buffer;
  }

  clear(): void {
    this.buffer.length = 0;
  }

  format(): string[] {
    return this.buffer.map(formatTraceRow);
  }
}

export function formatClock(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

export function formatTraceRow(row: TraceRow): string {
  return `${formatClock(row.at)}  ${row.tag.padEnd(9)} ${row.text}`;
}
