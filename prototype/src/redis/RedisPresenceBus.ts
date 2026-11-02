/**
 * B9 · the `pres:{user}` fan-out channel of design §5.3 on Redis pub/sub.
 *
 *   PUBLISH     pres:{user} {origin, seq, event}      on the shared client
 *   SUBSCRIBE   pres:{user}                            on a dedicated subscriber connection,
 *   UNSUBSCRIBE pres:{user}                            issued by the first/last local handler
 *
 * ioredis puts a connection into subscriber mode on SUBSCRIBE, so the bus duplicates the
 * client for that and keeps the original for PUBLISH. (Un)subscribes are issued in call
 * order on one promise chain and `publish` waits for that chain first, so a server that
 * subscribes and publishes without an await in between is still ordered.
 *
 * Delivery is asynchronous: PUBLISH returns when Redis has queued the message, the event
 * reaches the local handlers on the subscriber connection later. `settled()` exists for
 * tests: it resolves once every event this instance published to a channel it is itself
 * subscribed to has come back (matched by `origin` and `seq` in the payload).
 */

import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { PresenceBus, PresenceEvent, PresenceHandler } from '../presence/PresenceBus.js';
import type { UserId } from '../protocol.js';
import { keyOf } from './client.js';

export interface RedisPresenceBusOptions {
  prefix?: string;
}

interface Envelope {
  origin: string;
  seq: number;
  event: PresenceEvent;
}

export class RedisPresenceBus implements PresenceBus {
  private readonly pub: Redis;
  private readonly sub: Redis;
  private readonly prefix: string | undefined;
  private readonly handlers = new Map<UserId, Set<PresenceHandler>>();
  /** SUBSCRIBE / UNSUBSCRIBE commands, in call order. */
  private chain: Promise<void> = Promise.resolve();
  private failure: unknown = undefined;
  private closed = false;
  private readonly origin = randomUUID();
  private seq = 0;
  /** Published by this instance to a locally subscribed channel and not yet seen back: seq → user. */
  private readonly outstanding = new Map<number, UserId>();
  private waiters: Array<() => void> = [];

  constructor(redis: Redis, opts: RedisPresenceBusOptions = {}) {
    this.pub = redis;
    this.prefix = opts.prefix;
    this.sub = redis.duplicate();
    this.sub.on('message', (channel: string, raw: string) => this.onMessage(channel, raw));
  }

  channelOf(user_id: UserId): string {
    return keyOf(this.prefix, `pres:${user_id}`);
  }

  private userOf(channel: string): UserId | undefined {
    const head = keyOf(this.prefix, 'pres:');
    return channel.startsWith(head) ? channel.slice(head.length) : undefined;
  }

  async publish(user_id: UserId, event: PresenceEvent): Promise<void> {
    await this.ready();
    const seq = (this.seq += 1);
    if (this.handlers.has(user_id)) this.outstanding.set(seq, user_id);
    const envelope: Envelope = { origin: this.origin, seq, event };
    await this.pub.publish(this.channelOf(user_id), JSON.stringify(envelope));
  }

  subscribe(user_id: UserId, handler: PresenceHandler): () => void {
    let set = this.handlers.get(user_id);
    if (!set) {
      set = new Set();
      this.handlers.set(user_id, set);
      this.enqueue(() => this.sub.subscribe(this.channelOf(user_id)));
    }
    set.add(handler);
    return () => {
      const current = this.handlers.get(user_id);
      if (!current || !current.delete(handler)) return;
      if (current.size > 0) return;
      this.handlers.delete(user_id);
      for (const [seq, user] of this.outstanding) if (user === user_id) this.outstanding.delete(seq);
      this.settleWaiters();
      this.enqueue(() => this.sub.unsubscribe(this.channelOf(user_id)));
    };
  }

  /** Resolves once every SUBSCRIBE / UNSUBSCRIBE issued so far has been answered. */
  async ready(): Promise<void> {
    await this.chain;
    if (this.failure !== undefined) throw this.failure;
  }

  /** Instrumentation: resolves once every event published here to a locally subscribed channel has come back. */
  settled(timeoutMs = 2000): Promise<void> {
    if (this.outstanding.size === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        reject(new Error(`RedisPresenceBus.settled: ${this.outstanding.size} published event(s) not back within ${timeoutMs} ms`));
      }, timeoutMs);
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push(done);
    });
  }

  /** Instrumentation: `PUBSUB CHANNELS <prefix>pres:*`, the channels with a subscriber anywhere. */
  async subscribedChannels(): Promise<string[]> {
    const channels = (await this.pub.pubsub('CHANNELS', `${keyOf(this.prefix, 'pres:')}*`)) as string[];
    return channels.sort();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.chain.catch(() => {});
    this.handlers.clear();
    this.outstanding.clear();
    this.settleWaiters();
    await this.sub.quit().catch(() => {});
  }

  private enqueue(op: () => Promise<unknown>): void {
    if (this.closed) return;
    this.chain = this.chain.then(op).then(
      () => {},
      (e: unknown) => { this.failure = e; },
    );
  }

  private onMessage(channel: string, raw: string): void {
    const user_id = this.userOf(channel);
    if (user_id === undefined) return;
    let envelope: Envelope;
    try {
      envelope = JSON.parse(raw) as Envelope;
    } catch {
      return;
    }
    const handlers = this.handlers.get(user_id);
    if (handlers) for (const handler of [...handlers]) handler({ ...envelope.event });
    if (envelope.origin === this.origin) {
      this.outstanding.delete(envelope.seq);
      this.settleWaiters();
    }
  }

  private settleWaiters(): void {
    if (this.outstanding.size > 0) return;
    const waiters = this.waiters;
    this.waiters = [];
    for (const done of waiters) done();
  }
}
