import { HttpException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import {
  AuthThrottle,
  AuthThrottleGuard,
  AuthThrottleService,
  AuthThrottleStoreError,
  InvalidThrottleKeyError,
  MemoryAuthThrottleStore,
  type AuthThrottleStore,
} from '../src/index.js';
import { FakeClock } from './fake-clock.js';

interface FakeResponse {
  headers: Record<string, string>;
  setHeader(name: string, value: string): void;
}

function userKey(ctx: ExecutionContext): string | undefined {
  const user = ctx.switchToHttp().getRequest<{ body?: { user?: string } }>().body?.user;
  return user === undefined ? undefined : `user:${user}`;
}

class Controller {
  @AuthThrottle({ action: 'login', key: userKey })
  login(): void {}

  open(): void {}
}

function context(
  handler: (...args: never[]) => unknown,
  request: unknown,
  response: unknown = { headers: {}, setHeader() {} },
  type = 'http',
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => Controller,
    getType: () => type,
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ExecutionContext;
}

function setup(store?: AuthThrottleStore) {
  const clock = new FakeClock();
  const service = new AuthThrottleService(
    { defaultPolicy: { maxAttempts: 2, window: 60, lockoutDuration: 120, cooldown: 5 } },
    store ?? new MemoryAuthThrottleStore({ clock }),
    clock,
  );
  return { clock, service, guard: new AuthThrottleGuard(new Reflector(), service) };
}

function response(): FakeResponse {
  const res: FakeResponse = {
    headers: {},
    setHeader(name, value) {
      res.headers[name] = value;
    },
  };
  return res;
}

const request = { body: { user: '1' } };

describe('AuthThrottleGuard', () => {
  it('lets requests through when nothing is blocked', async () => {
    const { guard } = setup();
    expect(await guard.canActivate(context(Controller.prototype.login, request))).toBe(true);
  });

  it('does nothing for handlers without @AuthThrottle metadata', async () => {
    const { guard, service } = setup();
    await service.recordFailure({ action: 'login', key: 'user:1' });
    await service.recordFailure({ action: 'login', key: 'user:1' });
    expect(await guard.canActivate(context(Controller.prototype.open, request))).toBe(true);
  });

  it('rejects a locked key with 429, Retry-After and a structured body', async () => {
    const { guard, service } = setup();
    await service.recordFailure({ action: 'login', key: 'user:1' });
    await service.recordFailure({ action: 'login', key: 'user:1' });
    const res = response();
    const error = await guard.canActivate(context(Controller.prototype.login, request, res)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(429);
    expect((error as HttpException).getResponse()).toMatchObject({ statusCode: 429, reason: 'locked', retryAfter: 120 });
    expect(res.headers['Retry-After']).toBe('120');
  });

  it('rejects during cooldown with the cooldown reason', async () => {
    const { guard, service, clock } = setup();
    await service.recordFailure({ action: 'login', key: 'user:1' });
    clock.advance(1500);
    const res = response();
    const error = await guard.canActivate(context(Controller.prototype.login, request, res)).catch((e: unknown) => e);
    expect((error as HttpException).getResponse()).toMatchObject({ reason: 'cooldown', retryAfter: 4 });
    expect(res.headers['Retry-After']).toBe('4');
  });

  it('allows the request again after the block expires', async () => {
    const { guard, service, clock } = setup();
    await service.recordFailure({ action: 'login', key: 'user:1' });
    await service.recordFailure({ action: 'login', key: 'user:1' });
    clock.advanceSeconds(120);
    expect(await guard.canActivate(context(Controller.prototype.login, request))).toBe(true);
  });

  it('does not record anything itself', async () => {
    const { guard, service } = setup();
    for (let i = 0; i < 5; i++) await guard.canActivate(context(Controller.prototype.login, request));
    expect(await service.check({ action: 'login', key: 'user:1' })).toMatchObject({ failedAttempts: 0 });
  });

  it('skips throttling when the key resolver returns undefined', async () => {
    const { guard } = setup();
    expect(await guard.canActivate(context(Controller.prototype.login, { body: {} }))).toBe(true);
  });

  it('works with Fastify-style responses that use header()', async () => {
    const { guard, service } = setup();
    await service.recordFailure({ action: 'login', key: 'user:1' });
    await service.recordFailure({ action: 'login', key: 'user:1' });
    const headers: Record<string, string> = {};
    const fastify = { header: (n: string, v: string) => { headers[n] = v; } };
    await guard.canActivate(context(Controller.prototype.login, request, fastify)).catch(() => undefined);
    expect(headers['Retry-After']).toBe('120');
  });

  it('still rejects when the response object cannot take headers, and outside http contexts', async () => {
    const { guard, service } = setup();
    await service.recordFailure({ action: 'login', key: 'user:1' });
    await service.recordFailure({ action: 'login', key: 'user:1' });
    await expect(guard.canActivate(context(Controller.prototype.login, request, {}))).rejects.toBeInstanceOf(HttpException);
    await expect(guard.canActivate(context(Controller.prototype.login, request, response(), 'rpc'))).rejects.toBeInstanceOf(HttpException);
  });

  it('fails closed when the store fails', async () => {
    const base = new MemoryAuthThrottleStore();
    const { guard } = setup({
      get: async () => { throw new Error('down'); },
      compareAndSet: (...a) => base.compareAndSet(...a),
      delete: (...a) => base.delete(...a),
    });
    await expect(guard.canActivate(context(Controller.prototype.login, request))).rejects.toBeInstanceOf(AuthThrottleStoreError);
  });

  it('surfaces an invalid key from the resolver instead of skipping the check', async () => {
    class Bad {
      @AuthThrottle({ action: 'login', key: () => '   ' })
      handler(): void {}
    }
    const { guard } = setup();
    const ctx = { ...context(Bad.prototype.handler, {}), getClass: () => Bad } as ExecutionContext;
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(InvalidThrottleKeyError);
  });

  it('supports async key resolvers and class-level metadata', async () => {
    @AuthThrottle({ action: 'mfa', key: async () => 'user:9' })
    class Guarded {
      handler(): void {}
    }
    const { guard, service } = setup();
    await service.recordFailure({ action: 'mfa', key: 'user:9' });
    await service.recordFailure({ action: 'mfa', key: 'user:9' });
    const ctx = { ...context(Guarded.prototype.handler, {}), getClass: () => Guarded } as ExecutionContext;
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(HttpException);
  });
});
