import { describe, expect, test } from 'vitest';
import { InMemoryPresenceBus } from '../../src/presence/PresenceBus.js';
import { describePresenceBusContract } from './contracts/presenceBus.contract.js';

describePresenceBusContract('InMemoryPresenceBus', () => new InMemoryPresenceBus());

describe('InMemoryPresenceBus instrumentation', () => {
  test('subscribers(user) counts the open subscriptions of one channel', () => {
    const bus = new InMemoryPresenceBus();
    expect(bus.subscribers('truc')).toBe(0);
    const off = bus.subscribe('truc', () => {});
    bus.subscribe('khanh', () => {});
    expect(bus.subscribers('truc')).toBe(1);
    off();
    expect(bus.subscribers('truc')).toBe(0);
    expect(bus.subscribers('khanh')).toBe(1);
  });
});
