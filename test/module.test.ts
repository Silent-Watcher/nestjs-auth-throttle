import { Inject, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import {
  AUTH_THROTTLE_CLOCK,
  AUTH_THROTTLE_OPTIONS,
  AUTH_THROTTLE_STORE,
  AuthThrottleModule,
  AuthThrottleService,
  InvalidAuthThrottleConfigError,
  InvalidThrottlePolicyError,
  MemoryAuthThrottleStore,
  type AuthThrottleStore,
} from '../src/index.js';
import { FakeClock } from './fake-clock.js';

const login = { action: 'login', key: 'user:1' };

describe('AuthThrottleModule.forRoot', () => {
  it('provides a working service with the in-memory store by default', async () => {
    const ref = await Test.createTestingModule({ imports: [AuthThrottleModule.forRoot()] }).compile();
    const service = ref.get(AuthThrottleService);
    expect(await service.recordFailure(login)).toMatchObject({ failedAttempts: 1, remainingAttempts: 4 });
    expect(ref.get(AUTH_THROTTLE_STORE)).toBeInstanceOf(MemoryAuthThrottleStore);
  });

  it('applies configured policies', async () => {
    const ref = await Test.createTestingModule({
      imports: [
        AuthThrottleModule.forRoot({
          defaultPolicy: { maxAttempts: 2 },
          policies: { 'otp-request': { maxAttempts: 1 } },
        }),
      ],
    }).compile();
    const service = ref.get(AuthThrottleService);
    expect(await service.recordFailure({ action: 'otp-request', key: 'p' })).toMatchObject({ reason: 'locked' });
    expect(await service.recordFailure(login)).toMatchObject({ allowed: true, remainingAttempts: 1 });
  });

  it('injects the resolved options without the module-only `global` flag', async () => {
    const ref = await Test.createTestingModule({
      imports: [AuthThrottleModule.forRoot({ global: true, defaultPolicy: { maxAttempts: 7 } })],
    }).compile();
    expect(ref.get(AUTH_THROTTLE_OPTIONS)).toEqual({ defaultPolicy: { maxAttempts: 7 } });
  });

  it('uses a custom store', async () => {
    const calls: string[] = [];
    const inner = new MemoryAuthThrottleStore();
    const store: AuthThrottleStore = {
      get: (k) => (calls.push('get'), inner.get(k)),
      compareAndSet: (k, v, s, t) => (calls.push('cas'), inner.compareAndSet(k, v, s, t)),
      delete: (k, v) => (calls.push('delete'), inner.delete(k, v)),
    };
    const ref = await Test.createTestingModule({ imports: [AuthThrottleModule.forRoot({ store })] }).compile();
    await ref.get(AuthThrottleService).recordFailure(login);
    expect(ref.get(AUTH_THROTTLE_STORE)).toBe(store);
    expect(calls).toEqual(['get', 'cas']);
  });

  it('uses a custom clock for both the service and the default store', async () => {
    const clock = new FakeClock();
    const ref = await Test.createTestingModule({
      imports: [AuthThrottleModule.forRoot({ clock, defaultPolicy: { window: 60, lockoutDuration: 60 } })],
    }).compile();
    const service = ref.get(AuthThrottleService);
    expect(ref.get(AUTH_THROTTLE_CLOCK)).toBe(clock);
    for (let i = 0; i < 5; i++) await service.recordFailure(login);
    expect(await service.check(login)).toMatchObject({ allowed: false, retryAfter: 60 });
    clock.advanceSeconds(60);
    expect(await service.check(login)).toMatchObject({ allowed: true, failedAttempts: 0 });
  });

  it('fails at bootstrap on invalid configuration, not on first use', async () => {
    await expect(
      Test.createTestingModule({
        imports: [AuthThrottleModule.forRoot({ defaultPolicy: { maxAttempts: 0 } })],
      }).compile(),
    ).rejects.toBeInstanceOf(InvalidThrottlePolicyError);
    await expect(
      Test.createTestingModule({
        imports: [AuthThrottleModule.forRoot({ policies: { login: { window: -1 } } })],
      }).compile(),
    ).rejects.toBeInstanceOf(InvalidThrottlePolicyError);
  });

  it('rejects a store that does not implement the contract', async () => {
    await expect(
      Test.createTestingModule({ imports: [AuthThrottleModule.forRoot({ store: {} as never })] }).compile(),
    ).rejects.toBeInstanceOf(InvalidAuthThrottleConfigError);
  });

  it('is not visible to other modules unless imported, and is when global', async () => {
    @Injectable()
    class Consumer {
      constructor(@Inject(AuthThrottleService) readonly throttle: AuthThrottleService) {}
    }
    @Module({ providers: [Consumer] })
    class FeatureModule {}

    await expect(
      Test.createTestingModule({ imports: [AuthThrottleModule.forRoot(), FeatureModule] }).compile(),
    ).rejects.toThrow(/AuthThrottleService/);

    const ref = await Test.createTestingModule({
      imports: [AuthThrottleModule.forRoot({ global: true }), FeatureModule],
    }).compile();
    expect(ref.get(Consumer).throttle).toBeInstanceOf(AuthThrottleService);
  });

  it('shares state between consumers of the same module instance', async () => {
    @Module({ imports: [AuthThrottleModule.forRoot({ defaultPolicy: { maxAttempts: 2 } })], exports: [AuthThrottleModule] })
    class Shared {}
    @Injectable()
    class A { constructor(@Inject(AuthThrottleService) readonly t: AuthThrottleService) {} }
    @Injectable()
    class B { constructor(@Inject(AuthThrottleService) readonly t: AuthThrottleService) {} }
    @Module({ imports: [Shared], providers: [A, B] })
    class App {}
    const ref = await Test.createTestingModule({ imports: [App] }).compile();
    await ref.get(A).t.recordFailure(login);
    expect(await ref.get(B).t.check(login)).toMatchObject({ failedAttempts: 1 });
  });
});

describe('AuthThrottleModule.forRootAsync', () => {
  it('builds options from a factory with injected dependencies', async () => {
    const CONFIG = Symbol('CONFIG');
    @Module({ providers: [{ provide: CONFIG, useValue: { attempts: 3 } }], exports: [CONFIG] })
    class ConfigModule {}

    const ref = await Test.createTestingModule({
      imports: [
        AuthThrottleModule.forRootAsync({
          imports: [ConfigModule],
          inject: [CONFIG],
          useFactory: (config: { attempts: number }) => ({ defaultPolicy: { maxAttempts: config.attempts } }),
        }),
      ],
    }).compile();
    expect(await ref.get(AuthThrottleService).getStatus(login)).toMatchObject({ maxAttempts: 3 });
  });

  it('supports async factories and injecting a store provider', async () => {
    const STORE = Symbol('STORE');
    const store = new MemoryAuthThrottleStore();
    @Module({ providers: [{ provide: STORE, useValue: store }], exports: [STORE] })
    class StoreModule {}

    const ref = await Test.createTestingModule({
      imports: [
        AuthThrottleModule.forRootAsync({
          imports: [StoreModule],
          inject: [STORE],
          useFactory: async (s: MemoryAuthThrottleStore) => {
            await Promise.resolve();
            return { store: s };
          },
        }),
      ],
    }).compile();
    expect(ref.get(AUTH_THROTTLE_STORE)).toBe(store);
  });

  it('works without inject/imports', async () => {
    const ref = await Test.createTestingModule({
      imports: [AuthThrottleModule.forRootAsync({ useFactory: () => ({ defaultPolicy: { maxAttempts: 9 } }) })],
    }).compile();
    expect(await ref.get(AuthThrottleService).getStatus(login)).toMatchObject({ maxAttempts: 9 });
  });

  it('honours the global flag', async () => {
    @Injectable()
    class Consumer { constructor(@Inject(AuthThrottleService) readonly t: AuthThrottleService) {} }
    @Module({ providers: [Consumer] })
    class Feature {}
    const ref = await Test.createTestingModule({
      imports: [AuthThrottleModule.forRootAsync({ global: true, useFactory: () => ({}) }), Feature],
    }).compile();
    expect(ref.get(Consumer).t).toBeInstanceOf(AuthThrottleService);
  });

  it('fails at bootstrap when the factory returns invalid options', async () => {
    await expect(
      Test.createTestingModule({
        imports: [AuthThrottleModule.forRootAsync({ useFactory: () => ({ defaultPolicy: { cooldown: -1 } }) })],
      }).compile(),
    ).rejects.toBeInstanceOf(InvalidThrottlePolicyError);
  });

  it('propagates a rejected factory', async () => {
    await expect(
      Test.createTestingModule({
        imports: [AuthThrottleModule.forRootAsync({ useFactory: async () => { throw new Error('config unavailable'); } })],
      }).compile(),
    ).rejects.toThrow('config unavailable');
  });

  it('requires a factory', () => {
    expect(() => AuthThrottleModule.forRootAsync({} as never)).toThrow(InvalidAuthThrottleConfigError);
  });
});
