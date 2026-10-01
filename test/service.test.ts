import { describe, expect, it } from 'vitest';
import {
  AuthThrottleStoreError,
  InvalidAuthThrottleConfigError,
  InvalidThrottleActionError,
  InvalidThrottleKeyError,
  InvalidThrottlePolicyError,
} from '../src/auth-throttle.errors.js';
import { AuthThrottleService } from '../src/auth-throttle.service.js';
import type { AuthThrottleStore } from '../src/auth-throttle.store.js';
import { MemoryAuthThrottleStore } from '../src/memory-auth-throttle.store.js';
import { FakeClock } from './fake-clock.js';
import { TEST_POLICY, createHarness } from './helpers.js';

const login = { action: 'login', key: 'user:1' } as const;

function harness(policy: Record<string, unknown> = {}) {
  return createHarness({ defaultPolicy: { ...TEST_POLICY, ...policy } });
}

describe('attempts', () => {
  it('starts allowed with the full attempt budget', async () => {
    const { service } = harness();
    expect(await service.check(login)).toEqual({ allowed: true, failedAttempts: 0, remainingAttempts: 3 });
  });

  it('first failed attempt is counted and still allowed', async () => {
    const { service } = harness();
    expect(await service.recordFailure(login)).toEqual({
      allowed: true,
      failedAttempts: 1,
      remainingAttempts: 2,
    });
  });

  it('the last allowed attempt is still allowed', async () => {
    const { service } = harness();
    await service.recordFailure(login);
    await service.recordFailure(login);
    expect(await service.check(login)).toEqual({ allowed: true, failedAttempts: 2, remainingAttempts: 1 });
  });

  it('locks exactly when the threshold is reached', async () => {
    const { service } = harness();
    await service.recordFailure(login);
    await service.recordFailure(login);
    expect(await service.recordFailure(login)).toEqual({
      allowed: false,
      reason: 'locked',
      retryAfter: 120,
      failedAttempts: 3,
      remainingAttempts: 0,
    });
    expect(await service.check(login)).toMatchObject({ allowed: false, reason: 'locked' });
  });

  it('failures beyond the threshold change nothing and do not extend the lockout', async () => {
    const { service, clock } = harness();
    for (let i = 0; i < 3; i++) await service.recordFailure(login);
    clock.advanceSeconds(10);
    const result = await service.recordFailure(login);
    expect(result).toMatchObject({ allowed: false, reason: 'locked', retryAfter: 110, failedAttempts: 3 });
    clock.advanceSeconds(110);
    expect(await service.check(login)).toMatchObject({ allowed: true, failedAttempts: 0 });
  });

  it('success after failures clears them', async () => {
    const { service } = harness();
    await service.recordFailure(login);
    await service.recordFailure(login);
    expect(await service.recordSuccess(login)).toEqual({ allowed: true, failedAttempts: 0, remainingAttempts: 3 });
    expect(await service.check(login)).toMatchObject({ failedAttempts: 0 });
  });

  it('repeated success is harmless', async () => {
    const { service } = harness();
    await service.recordSuccess(login);
    await service.recordSuccess(login);
    expect(await service.check(login)).toMatchObject({ allowed: true, failedAttempts: 0 });
  });

  it('resetOnSuccess: false keeps failures after a success', async () => {
    const { service } = harness({ resetOnSuccess: false });
    await service.recordFailure(login);
    expect(await service.recordSuccess(login)).toMatchObject({ failedAttempts: 1 });
    expect(await service.check(login)).toMatchObject({ failedAttempts: 1 });
  });

  it('success does not lift an active lockout', async () => {
    const { service } = harness();
    for (let i = 0; i < 3; i++) await service.recordFailure(login);
    expect(await service.recordSuccess(login)).toMatchObject({ allowed: false, reason: 'locked' });
    expect(await service.check(login)).toMatchObject({ allowed: false, reason: 'locked' });
  });

  it('manual reset clears failures', async () => {
    const { service } = harness();
    await service.recordFailure(login);
    await service.reset(login);
    expect(await service.check(login)).toMatchObject({ failedAttempts: 0, remainingAttempts: 3 });
  });

  it('manual reset lifts an active lockout immediately', async () => {
    const { service } = harness();
    for (let i = 0; i < 3; i++) await service.recordFailure(login);
    await service.reset(login);
    expect(await service.check(login)).toMatchObject({ allowed: true, failedAttempts: 0 });
  });

  it('reset of an unknown key is a no-op', async () => {
    const { service } = harness();
    await expect(service.reset(login)).resolves.toBeUndefined();
  });

  it('keeps keys and actions independent', async () => {
    const { service } = harness();
    for (let i = 0; i < 3; i++) await service.recordFailure(login);
    expect(await service.check({ action: 'login', key: 'user:2' })).toMatchObject({ allowed: true });
    expect(await service.check({ action: 'otp-request', key: 'user:1' })).toMatchObject({ allowed: true });
  });

  it('a key containing ":" cannot collide with another action', async () => {
    const { service } = harness();
    for (let i = 0; i < 3; i++) await service.recordFailure({ action: 'a', key: 'b:c' });
    expect(await service.check({ action: 'a', key: 'b:c' })).toMatchObject({ allowed: false });
    expect(await service.check({ action: 'a:b', key: 'c' } as never).catch((e: unknown) => e)).toBeInstanceOf(
      InvalidThrottleActionError,
    );
  });

  it('getStatus is read-only and exposes details', async () => {
    const { service, memory } = harness();
    expect(await service.getStatus(login)).toEqual({
      state: 'allowed',
      failedAttempts: 0,
      remainingAttempts: 3,
      maxAttempts: 3,
      retryAfter: 0,
    });
    await service.getStatus(login);
    expect(memory.size).toBe(0);

    for (let i = 0; i < 3; i++) await service.recordFailure(login);
    expect(await service.getStatus(login)).toMatchObject({
      state: 'locked',
      retryAfter: 120,
      blockedUntil: 1_000_000 + 120_000,
    });
  });

  it('check does not mutate state', async () => {
    const { service, memory } = harness();
    await service.recordFailure(login);
    const before = await memory.get('login:user:1');
    await service.check(login);
    await service.check(login);
    expect(await memory.get('login:user:1')).toEqual(before);
  });
});

describe('cooldown', () => {
  const cd = { cooldown: 5 };

  it('begins after a failure', async () => {
    const { service } = harness(cd);
    expect(await service.recordFailure(login)).toEqual({
      allowed: false,
      reason: 'cooldown',
      retryAfter: 5,
      failedAttempts: 1,
      remainingAttempts: 2,
    });
  });

  it('blocks an attempt during cooldown and rounds retryAfter up', async () => {
    const { service, clock } = harness(cd);
    await service.recordFailure(login);
    clock.advance(1500);
    expect(await service.check(login)).toMatchObject({ allowed: false, reason: 'cooldown', retryAfter: 4 });
    clock.advance(3499);
    expect(await service.check(login)).toMatchObject({ allowed: false, retryAfter: 1 });
  });

  it('expires exactly at the cooldown boundary', async () => {
    const { service, clock } = harness(cd);
    await service.recordFailure(login);
    clock.advance(4999);
    expect(await service.check(login)).toMatchObject({ allowed: false, reason: 'cooldown' });
    clock.advance(1);
    expect(await service.check(login)).toEqual({ allowed: true, failedAttempts: 1, remainingAttempts: 2 });
  });

  it('a failure recorded during cooldown still counts and restarts the cooldown', async () => {
    const { service, clock } = harness(cd);
    await service.recordFailure(login);
    clock.advanceSeconds(2);
    expect(await service.recordFailure(login)).toMatchObject({
      reason: 'cooldown',
      failedAttempts: 2,
      retryAfter: 5,
    });
  });

  it('repeated failures across cooldowns eventually lock', async () => {
    const { service, clock } = harness(cd);
    await service.recordFailure(login);
    clock.advanceSeconds(5);
    await service.recordFailure(login);
    clock.advanceSeconds(5);
    expect(await service.recordFailure(login)).toMatchObject({ reason: 'locked', retryAfter: 120 });
  });

  it('lockout takes precedence over cooldown', async () => {
    const { service } = harness(cd);
    await service.recordFailure(login);
    await service.recordFailure(login);
    await service.recordFailure(login);
    expect(await service.check(login)).toMatchObject({ reason: 'locked' });
  });

  it('zero cooldown never blocks between failures', async () => {
    const { service } = harness({ cooldown: 0 });
    expect(await service.recordFailure(login)).toMatchObject({ allowed: true });
    expect(await service.check(login)).toMatchObject({ allowed: true });
  });

  it('negative cooldown is rejected', () => {
    expect(() => harness({ cooldown: -1 })).toThrow(InvalidThrottlePolicyError);
  });
});

describe('lockout', () => {
  it('blocks during lockout and reports shrinking retryAfter', async () => {
    const { service, clock } = harness();
    for (let i = 0; i < 3; i++) await service.recordFailure(login);
    clock.advanceSeconds(30);
    expect(await service.check(login)).toMatchObject({ allowed: false, reason: 'locked', retryAfter: 90 });
  });

  it('expires exactly at the lockout boundary and starts a fresh count', async () => {
    const { service, clock } = harness();
    for (let i = 0; i < 3; i++) await service.recordFailure(login);
    clock.advance(119_999);
    expect(await service.check(login)).toMatchObject({ allowed: false, retryAfter: 1 });
    clock.advance(1);
    expect(await service.check(login)).toEqual({ allowed: true, failedAttempts: 0, remainingAttempts: 3 });
  });

  it('a failure after lockout expiry counts as the first failure', async () => {
    const { service, clock } = harness();
    for (let i = 0; i < 3; i++) await service.recordFailure(login);
    clock.advanceSeconds(120);
    expect(await service.recordFailure(login)).toEqual({ allowed: true, failedAttempts: 1, remainingAttempts: 2 });
  });

  it('lockout can outlast the window', async () => {
    const { service, clock } = harness({ window: 10, lockoutDuration: 600 });
    for (let i = 0; i < 3; i++) await service.recordFailure(login);
    clock.advanceSeconds(300);
    expect(await service.check(login)).toMatchObject({ allowed: false, reason: 'locked', retryAfter: 300 });
  });

  it('zero lockout duration is rejected', () => {
    expect(() => harness({ lockoutDuration: 0 })).toThrow(InvalidThrottlePolicyError);
  });

  it('negative lockout duration is rejected', () => {
    expect(() => harness({ lockoutDuration: -1 })).toThrow(InvalidThrottlePolicyError);
  });
});

describe('time window', () => {
  it('counts attempts inside the window', async () => {
    const { service, clock } = harness();
    await service.recordFailure(login);
    clock.advanceSeconds(30);
    expect(await service.recordFailure(login)).toMatchObject({ failedAttempts: 2 });
  });

  it('a failure exactly window-old has expired; one millisecond younger has not', async () => {
    const { service, clock } = harness();
    await service.recordFailure(login);
    clock.advance(59_999);
    expect(await service.check(login)).toMatchObject({ failedAttempts: 1 });
    clock.advance(1);
    expect(await service.check(login)).toMatchObject({ failedAttempts: 0, remainingAttempts: 3 });
  });

  it('expires stale failures individually (sliding window)', async () => {
    const { service, clock } = harness();
    await service.recordFailure(login); // t=0
    clock.advanceSeconds(40);
    await service.recordFailure(login); // t=40
    clock.advanceSeconds(20); // t=60: first expired, second alive
    expect(await service.check(login)).toMatchObject({ failedAttempts: 1, remainingAttempts: 2 });
  });

  it('stale failures do not add up to a lockout', async () => {
    const { service, clock } = harness();
    await service.recordFailure(login);
    await service.recordFailure(login);
    clock.advanceSeconds(60);
    expect(await service.recordFailure(login)).toEqual({ allowed: true, failedAttempts: 1, remainingAttempts: 2 });
  });

  it('long inactivity followed by a new attempt starts from scratch', async () => {
    const { service, clock, memory } = harness();
    await service.recordFailure(login);
    await service.recordFailure(login);
    clock.advanceSeconds(30 * 24 * 3600);
    expect(await service.check(login)).toMatchObject({ allowed: true, failedAttempts: 0 });
    expect(await service.recordFailure(login)).toMatchObject({ failedAttempts: 1 });
    expect(memory.size).toBe(1);
  });
});

describe('configuration and policies', () => {
  it('maxAttempts = 1 locks on the first failure', async () => {
    const { service } = harness({ maxAttempts: 1 });
    expect(await service.recordFailure(login)).toMatchObject({ allowed: false, reason: 'locked', failedAttempts: 1 });
  });

  it.each([0, -3, 1.5, Number.NaN])('rejects maxAttempts = %s at construction', (maxAttempts) => {
    expect(() => harness({ maxAttempts })).toThrow(InvalidThrottlePolicyError);
  });

  it('rejects huge values', () => {
    expect(() => harness({ maxAttempts: 10 ** 9 })).toThrow(InvalidThrottlePolicyError);
    expect(() => harness({ window: 10 ** 12 })).toThrow(InvalidThrottlePolicyError);
  });

  it('rejects conflicting cooldown and window', () => {
    expect(() => harness({ window: 10, cooldown: 10 })).toThrow(InvalidThrottlePolicyError);
  });

  it('applies different policies per action', async () => {
    const { service } = createHarness({
      defaultPolicy: TEST_POLICY,
      policies: { 'otp-request': { maxAttempts: 2 }, mfa: { maxAttempts: 4 } },
    });
    const otp = { action: 'otp-request', key: 'phone:1' };
    await service.recordFailure(otp);
    expect(await service.recordFailure(otp)).toMatchObject({ reason: 'locked' });
    const mfa = { action: 'mfa', key: 'user:1' };
    for (let i = 0; i < 3; i++) await service.recordFailure(mfa);
    expect(await service.check(mfa)).toMatchObject({ allowed: true, remainingAttempts: 1 });
  });

  it('uses the default policy for custom and unknown actions', async () => {
    const { service } = createHarness({ defaultPolicy: TEST_POLICY, policies: { login: { maxAttempts: 9 } } });
    const custom = { action: 'my-custom-flow', key: 'k' };
    expect(await service.check(custom)).toMatchObject({ remainingAttempts: 3 });
    expect(await service.check(login)).toMatchObject({ remainingAttempts: 9 });
  });

  it('falls back to the built-in default when no policy is configured', async () => {
    const { service } = createHarness({});
    expect(await service.getStatus(login)).toMatchObject({ maxAttempts: 5 });
  });

  it('rejects invalid keys and actions on every method', async () => {
    const { service } = harness();
    const bad = [
      { action: 'login', key: '' },
      { action: 'login', key: '   ' },
      { action: 'login', key: 'x'.repeat(257) },
      { action: 'login', key: undefined as never },
    ];
    for (const target of bad) {
      await expect(service.check(target)).rejects.toBeInstanceOf(InvalidThrottleKeyError);
      await expect(service.recordFailure(target)).rejects.toBeInstanceOf(InvalidThrottleKeyError);
      await expect(service.recordSuccess(target)).rejects.toBeInstanceOf(InvalidThrottleKeyError);
      await expect(service.getStatus(target)).rejects.toBeInstanceOf(InvalidThrottleKeyError);
      await expect(service.reset(target)).rejects.toBeInstanceOf(InvalidThrottleKeyError);
    }
    await expect(service.check({ action: '', key: 'k' })).rejects.toBeInstanceOf(InvalidThrottleActionError);
    await expect(service.check(undefined as never)).rejects.toBeInstanceOf(TypeError);
  });

  it('rejects an unusable store or clock at construction', () => {
    const clock = new FakeClock();
    expect(() => new AuthThrottleService({}, {} as never, clock)).toThrow(InvalidAuthThrottleConfigError);
    expect(() => new AuthThrottleService({}, new MemoryAuthThrottleStore(), {} as never)).toThrow(
      InvalidAuthThrottleConfigError,
    );
    expect(() => new AuthThrottleService(null as never, new MemoryAuthThrottleStore(), clock)).toThrow(
      InvalidAuthThrottleConfigError,
    );
  });
});

describe('policy changes against existing state', () => {
  function withPolicy(store: AuthThrottleStore, clock: FakeClock, policy: Record<string, unknown>) {
    return new AuthThrottleService({ defaultPolicy: policy }, store, clock);
  }

  it('raising maxAttempts gives existing unlocked state more headroom', async () => {
    const clock = new FakeClock();
    const store = new MemoryAuthThrottleStore({ clock });
    const before = withPolicy(store, clock, { ...TEST_POLICY, maxAttempts: 5 });
    await before.recordFailure(login);
    await before.recordFailure(login);
    const after = withPolicy(store, clock, { ...TEST_POLICY, maxAttempts: 10 });
    expect(await after.check(login)).toMatchObject({ allowed: true, failedAttempts: 2, remainingAttempts: 8 });
  });

  it('lowering maxAttempts below the stored failure count locks from the latest failure', async () => {
    const clock = new FakeClock();
    const store = new MemoryAuthThrottleStore({ clock });
    const before = withPolicy(store, clock, { ...TEST_POLICY, maxAttempts: 5 });
    await before.recordFailure(login);
    await before.recordFailure(login);
    await before.recordFailure(login);
    clock.advanceSeconds(10);
    const after = withPolicy(store, clock, { ...TEST_POLICY, maxAttempts: 2 });
    expect(await after.check(login)).toMatchObject({
      allowed: false,
      reason: 'locked',
      retryAfter: 110,
      failedAttempts: 2,
    });
  });

  it('an existing lockout survives a higher maxAttempts and then expires normally', async () => {
    const clock = new FakeClock();
    const store = new MemoryAuthThrottleStore({ clock });
    const before = withPolicy(store, clock, TEST_POLICY);
    for (let i = 0; i < 3; i++) await before.recordFailure(login);
    const after = withPolicy(store, clock, { ...TEST_POLICY, maxAttempts: 10 });
    expect(await after.check(login)).toMatchObject({ allowed: false, reason: 'locked' });
    clock.advanceSeconds(120);
    expect(await after.check(login)).toMatchObject({ allowed: true, failedAttempts: 0, remainingAttempts: 10 });
  });

  it('a shorter lockoutDuration releases an existing lockout sooner, a longer one holds it longer', async () => {
    const clock = new FakeClock();
    const store = new MemoryAuthThrottleStore({ clock });
    const before = withPolicy(store, clock, TEST_POLICY);
    for (let i = 0; i < 3; i++) await before.recordFailure(login);
    clock.advanceSeconds(30);
    const shorter = withPolicy(store, clock, { ...TEST_POLICY, lockoutDuration: 20 });
    expect(await shorter.check(login)).toMatchObject({ allowed: true, failedAttempts: 0 });
    const longer = withPolicy(store, clock, { ...TEST_POLICY, lockoutDuration: 600 });
    expect(await longer.check(login)).toMatchObject({ allowed: false, retryAfter: 570 });
  });

  it('a shorter window expires old failures sooner', async () => {
    const clock = new FakeClock();
    const store = new MemoryAuthThrottleStore({ clock });
    const before = withPolicy(store, clock, { ...TEST_POLICY, window: 600 });
    await before.recordFailure(login);
    clock.advanceSeconds(90);
    const after = withPolicy(store, clock, { ...TEST_POLICY, window: 60 });
    expect(await after.check(login)).toMatchObject({ failedAttempts: 0 });
  });
});

describe('concurrency', () => {
  it('does not lose failures when requests race on the same key', async () => {
    const { service } = harness({ maxAttempts: 10 });
    await Promise.all(Array.from({ length: 8 }, () => service.recordFailure(login)));
    expect(await service.check(login)).toMatchObject({ allowed: true, failedAttempts: 8, remainingAttempts: 2 });
  });

  it('locks exactly once the threshold is reached under parallel failures', async () => {
    const { service } = harness();
    const results = await Promise.all(Array.from({ length: 10 }, () => service.recordFailure(login)));
    expect(await service.check(login)).toMatchObject({ allowed: false, reason: 'locked', failedAttempts: 3 });
    expect(results.filter((r) => !r.allowed).length).toBeGreaterThanOrEqual(8);
  });

  it('races between a failure and a success never leave inconsistent state', async () => {
    const { service } = harness();
    await service.recordFailure(login);
    await Promise.all([service.recordFailure(login), service.recordSuccess(login)]);
    const { failedAttempts } = await service.check(login);
    expect([0, 1]).toContain(failedAttempts);
  });

  it('gives up with a store error when a key is endlessly contended', async () => {
    const clock = new FakeClock();
    const base = new MemoryAuthThrottleStore({ clock });
    const contended: AuthThrottleStore = {
      get: (k) => base.get(k),
      delete: (k, v) => base.delete(k, v),
      compareAndSet: async () => false,
    };
    const service = new AuthThrottleService({ defaultPolicy: TEST_POLICY }, contended, clock);
    await expect(service.recordFailure(login)).rejects.toThrow(/concurrent writers/);
  });
});

describe('clock behaviour', () => {
  it('clamps timestamps from the future so skew cannot extend a cooldown', async () => {
    const clock = new FakeClock();
    const store = new MemoryAuthThrottleStore({ clock });
    await store.compareAndSet('login:user:1', undefined, { failures: [clock.now() + 3_600_000] }, 3_600_000);
    const service = new AuthThrottleService({ defaultPolicy: { ...TEST_POLICY, cooldown: 5 } }, store, clock);
    expect(await service.check(login)).toMatchObject({ reason: 'cooldown', retryAfter: 5 });
  });

  it('clamps a future lockedAt so skew cannot extend a lockout', async () => {
    const clock = new FakeClock();
    const store = new MemoryAuthThrottleStore({ clock });
    await store.compareAndSet(
      'login:user:1',
      undefined,
      { failures: [clock.now(), clock.now(), clock.now()], lockedAt: clock.now() + 3_600_000 },
      3_600_000,
    );
    const service = new AuthThrottleService({ defaultPolicy: TEST_POLICY }, store, clock);
    expect(await service.check(login)).toMatchObject({ reason: 'locked', retryAfter: 120 });
  });
});

describe('storage', () => {
  function failingStore(overrides: Partial<AuthThrottleStore>): AuthThrottleStore {
    const base = new MemoryAuthThrottleStore();
    return {
      get: (k) => base.get(k),
      compareAndSet: (k, v, s, t) => base.compareAndSet(k, v, s, t),
      delete: (k, v) => base.delete(k, v),
      ...overrides,
    };
  }

  it('surfaces store failures as AuthThrottleStoreError instead of an allowed/locked result', async () => {
    const cause = new Error('redis down');
    const store = failingStore({ get: async () => { throw cause; } });
    const { service } = createHarness({ defaultPolicy: TEST_POLICY }, store);
    for (const call of [
      () => service.check(login),
      () => service.getStatus(login),
      () => service.recordFailure(login),
      () => service.recordSuccess(login),
    ]) {
      const error = await call().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AuthThrottleStoreError);
      expect((error as AuthThrottleStoreError).cause).toBe(cause);
    }
  });

  it('surfaces write and delete failures too, without leaking the key', async () => {
    const store = failingStore({
      compareAndSet: async () => { throw new Error('write failed'); },
      delete: async () => { throw new Error('delete failed'); },
    });
    const { service } = createHarness({ defaultPolicy: TEST_POLICY }, store);
    const failure = await service.recordFailure(login).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AuthThrottleStoreError);
    expect((failure as Error).message).not.toContain('user:1');
    await expect(service.reset(login)).rejects.toBeInstanceOf(AuthThrottleStoreError);
  });

  it.each([
    ['not an object', 'garbage'],
    ['no version', { state: { failures: [] } }],
    ['bad failures', { version: 1, state: { failures: ['x'] } }],
    ['non-finite timestamp', { version: 1, state: { failures: [Number.NaN] } }],
    ['bad lockedAt', { version: 1, state: { failures: [], lockedAt: 'now' } }],
    ['missing state', { version: 1 }],
  ])('rejects malformed stored state (%s) rather than treating it as allowed', async (_name, entry) => {
    const store = failingStore({ get: async () => entry as never });
    const { service } = createHarness({ defaultPolicy: TEST_POLICY }, store);
    await expect(service.check(login)).rejects.toBeInstanceOf(AuthThrottleStoreError);
  });

  it('stores only timestamps: no key, credentials or other data inside the state', async () => {
    const { service, memory } = harness();
    await service.recordFailure({ action: 'login', key: 'user:1' });
    for (let i = 0; i < 2; i++) await service.recordFailure({ action: 'login', key: 'user:1' });
    const entry = await memory.get('login:user:1');
    expect(Object.keys(entry?.state ?? {}).sort()).toEqual(['failures', 'lockedAt']);
    expect(JSON.stringify(entry)).not.toMatch(/user|login|password/);
  });
});
