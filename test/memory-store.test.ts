import { describe, expect, it } from 'vitest';
import { InvalidAuthThrottleConfigError } from '../src/auth-throttle.errors.js';
import { MemoryAuthThrottleStore } from '../src/memory-auth-throttle.store.js';
import { FakeClock } from './fake-clock.js';

const state = (...failures: number[]) => ({ failures });

function create(options: { maxEntries?: number; sweepEvery?: number } = {}) {
  const clock = new FakeClock();
  return { clock, store: new MemoryAuthThrottleStore({ clock, ...options }) };
}

describe('MemoryAuthThrottleStore', () => {
  it('returns undefined for unknown keys', async () => {
    expect(await create().store.get('x')).toBeUndefined();
  });

  it('creates an entry only when the expected version is undefined', async () => {
    const { store } = create();
    expect(await store.compareAndSet('k', 7, state(1), 1000)).toBe(false);
    expect(await store.compareAndSet('k', undefined, state(1), 1000)).toBe(true);
    expect(await store.compareAndSet('k', undefined, state(2), 1000)).toBe(false);
    expect((await store.get('k'))?.state).toEqual(state(1));
  });

  it('updates only with the current version and issues a new one each write', async () => {
    const { store } = create();
    await store.compareAndSet('k', undefined, state(1), 1000);
    const first = await store.get('k');
    expect(await store.compareAndSet('k', first?.version, state(1, 2), 1000)).toBe(true);
    const second = await store.get('k');
    expect(second?.version).not.toBe(first?.version);
    expect(await store.compareAndSet('k', first?.version, state(9), 1000)).toBe(false);
    expect((await store.get('k'))?.state).toEqual(state(1, 2));
  });

  it('of two writers holding the same version, exactly one wins', async () => {
    const { store } = create();
    await store.compareAndSet('k', undefined, state(1), 1000);
    const { version } = (await store.get('k'))!;
    const results = await Promise.all([
      store.compareAndSet('k', version, state(1, 2), 1000),
      store.compareAndSet('k', version, state(1, 3), 1000),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('treats an entry as expired exactly at its ttl', async () => {
    const { store, clock } = create();
    await store.compareAndSet('k', undefined, state(1), 1000);
    clock.advance(999);
    expect(await store.get('k')).toBeDefined();
    clock.advance(1);
    expect(await store.get('k')).toBeUndefined();
  });

  it('never reuses a version, even after the key expired and was recreated', async () => {
    const { store, clock } = create();
    await store.compareAndSet('k', undefined, state(1), 100);
    const old = (await store.get('k'))!.version;
    clock.advance(100);
    await store.compareAndSet('k', undefined, state(2), 100);
    expect((await store.get('k'))!.version).not.toBe(old);
    expect(await store.compareAndSet('k', old, state(3), 100)).toBe(false);
  });

  it('allows creating a key whose previous entry has expired', async () => {
    const { store, clock } = create();
    await store.compareAndSet('k', undefined, state(1), 100);
    clock.advance(100);
    expect(await store.compareAndSet('k', undefined, state(2), 100)).toBe(true);
  });

  it('delete without a version removes unconditionally', async () => {
    const { store } = create();
    await store.compareAndSet('k', undefined, state(1), 1000);
    expect(await store.delete('k')).toBe(true);
    expect(await store.get('k')).toBeUndefined();
    expect(await store.delete('missing')).toBe(true);
  });

  it('delete with a version removes only the matching version', async () => {
    const { store } = create();
    await store.compareAndSet('k', undefined, state(1), 1000);
    const { version } = (await store.get('k'))!;
    expect(await store.delete('k', version + 100)).toBe(false);
    expect(await store.get('k')).toBeDefined();
    expect(await store.delete('k', version)).toBe(true);
    expect(await store.get('k')).toBeUndefined();
  });

  describe('memory bounds', () => {
    it('removes an expired entry when it is read', async () => {
      const { store, clock } = create();
      await store.compareAndSet('k', undefined, state(1), 10);
      clock.advance(10);
      await store.get('k');
      expect(store.size).toBe(0);
    });

    it('sweeps expired entries that are never read again, without any timer', async () => {
      const { store, clock } = create({ sweepEvery: 5 });
      for (let i = 0; i < 20; i++) await store.compareAndSet(`old:${i}`, undefined, state(1), 100);
      expect(store.size).toBe(20);
      clock.advance(100);
      for (let i = 0; i < 5; i++) await store.compareAndSet(`new:${i}`, undefined, state(1), 100_000);
      expect(store.size).toBe(5);
    });

    it('caps the number of entries, evicting the least recently written', async () => {
      const { store } = create({ maxEntries: 3 });
      for (const key of ['a', 'b', 'c']) await store.compareAndSet(key, undefined, state(1), 100_000);
      const a = (await store.get('a'))!;
      await store.compareAndSet('a', a.version, state(1, 2), 100_000); // refresh a
      await store.compareAndSet('d', undefined, state(1), 100_000);
      expect(store.size).toBe(3);
      expect(await store.get('b')).toBeUndefined();
      expect(await store.get('a')).toBeDefined();
      expect(await store.get('d')).toBeDefined();
    });

    it('prefers dropping expired entries over live ones when full', async () => {
      const { store, clock } = create({ maxEntries: 2 });
      await store.compareAndSet('stale', undefined, state(1), 10);
      await store.compareAndSet('live', undefined, state(1), 100_000);
      clock.advance(10);
      await store.compareAndSet('new', undefined, state(1), 100_000);
      expect(await store.get('live')).toBeDefined();
      expect(await store.get('new')).toBeDefined();
      expect(store.size).toBe(2);
    });

    it('stays bounded under a flood of unique keys', async () => {
      const { store } = create({ maxEntries: 100 });
      for (let i = 0; i < 5000; i++) await store.compareAndSet(`k${i}`, undefined, state(1), 100_000);
      expect(store.size).toBeLessThanOrEqual(100);
    });
  });

  it('validates its options', () => {
    expect(() => new MemoryAuthThrottleStore({ maxEntries: 0 })).toThrow(InvalidAuthThrottleConfigError);
    expect(() => new MemoryAuthThrottleStore({ maxEntries: 1.5 })).toThrow(InvalidAuthThrottleConfigError);
    expect(() => new MemoryAuthThrottleStore({ sweepEvery: -1 })).toThrow(InvalidAuthThrottleConfigError);
  });

  it('works with the system clock when none is given', async () => {
    const store = new MemoryAuthThrottleStore();
    await store.compareAndSet('k', undefined, state(Date.now()), 60_000);
    expect(await store.get('k')).toBeDefined();
  });
});
