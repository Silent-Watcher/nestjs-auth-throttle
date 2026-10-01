import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUTH_THROTTLE_POLICY,
  MAX_ATTEMPTS_LIMIT,
  MAX_DURATION_SECONDS,
  createPolicyResolver,
  resolveAuthThrottlePolicy,
} from '../src/auth-throttle.policy.js';
import {
  InvalidThrottleActionError,
  InvalidThrottlePolicyError,
} from '../src/auth-throttle.errors.js';

describe('resolveAuthThrottlePolicy', () => {
  it('returns the built-in default when nothing is configured', () => {
    expect(resolveAuthThrottlePolicy([])).toEqual(DEFAULT_AUTH_THROTTLE_POLICY);
    expect(resolveAuthThrottlePolicy([undefined])).toEqual(DEFAULT_AUTH_THROTTLE_POLICY);
  });

  it('merges layers in order, later layers winning', () => {
    const policy = resolveAuthThrottlePolicy([{ maxAttempts: 10, cooldown: 5 }, { maxAttempts: 3 }]);
    expect(policy).toMatchObject({ maxAttempts: 3, cooldown: 5, window: 900 });
  });

  it('ignores explicitly undefined fields instead of overriding with them', () => {
    const policy = resolveAuthThrottlePolicy([
      { maxAttempts: 7 },
      { maxAttempts: undefined } as never,
    ]);
    expect(policy.maxAttempts).toBe(7);
  });

  it('returns a frozen object', () => {
    expect(Object.isFrozen(resolveAuthThrottlePolicy([]))).toBe(true);
  });

  describe('maxAttempts', () => {
    it('accepts 1 and the upper limit', () => {
      expect(resolveAuthThrottlePolicy([{ maxAttempts: 1 }]).maxAttempts).toBe(1);
      expect(resolveAuthThrottlePolicy([{ maxAttempts: MAX_ATTEMPTS_LIMIT }]).maxAttempts).toBe(
        MAX_ATTEMPTS_LIMIT,
      );
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_ATTEMPTS_LIMIT + 1, 1e9])(
      'rejects %s',
      (value) => {
        expect(() => resolveAuthThrottlePolicy([{ maxAttempts: value }])).toThrow(
          InvalidThrottlePolicyError,
        );
      },
    );

    it('rejects non-numbers', () => {
      expect(() => resolveAuthThrottlePolicy([{ maxAttempts: '5' as never }])).toThrow(
        InvalidThrottlePolicyError,
      );
    });
  });

  describe('durations', () => {
    it('allows zero cooldown (disabled) but not negative cooldown', () => {
      expect(resolveAuthThrottlePolicy([{ cooldown: 0 }]).cooldown).toBe(0);
      expect(() => resolveAuthThrottlePolicy([{ cooldown: -1 }])).toThrow(/cooldown/);
    });

    it.each(['window', 'lockoutDuration'] as const)('rejects zero and negative %s', (name) => {
      expect(() => resolveAuthThrottlePolicy([{ [name]: 0 }])).toThrow(InvalidThrottlePolicyError);
      expect(() => resolveAuthThrottlePolicy([{ [name]: -5 }])).toThrow(InvalidThrottlePolicyError);
    });

    it.each(['window', 'lockoutDuration'] as const)('rejects huge %s', (name) => {
      expect(() => resolveAuthThrottlePolicy([{ [name]: MAX_DURATION_SECONDS + 1 }])).toThrow(
        InvalidThrottlePolicyError,
      );
      expect(resolveAuthThrottlePolicy([{ [name]: MAX_DURATION_SECONDS }])[name]).toBe(
        MAX_DURATION_SECONDS,
      );
    });

    it('rejects non-finite durations', () => {
      expect(() => resolveAuthThrottlePolicy([{ window: Number.POSITIVE_INFINITY }])).toThrow(
        InvalidThrottlePolicyError,
      );
      expect(() => resolveAuthThrottlePolicy([{ lockoutDuration: Number.NaN }])).toThrow(
        InvalidThrottlePolicyError,
      );
    });

    it('accepts fractional durations', () => {
      expect(resolveAuthThrottlePolicy([{ cooldown: 0.5 }]).cooldown).toBe(0.5);
    });
  });

  describe('conflicting options', () => {
    it('rejects a cooldown that is not shorter than the window', () => {
      expect(() => resolveAuthThrottlePolicy([{ window: 10, cooldown: 10 }])).toThrow(/shorter/);
      expect(() => resolveAuthThrottlePolicy([{ window: 10, cooldown: 11 }])).toThrow(/shorter/);
      expect(resolveAuthThrottlePolicy([{ window: 10, cooldown: 9.9 }]).cooldown).toBe(9.9);
    });

    it('detects a conflict that only appears after merging layers', () => {
      expect(() => resolveAuthThrottlePolicy([{ cooldown: 60 }, { window: 30 }])).toThrow(
        /shorter/,
      );
    });
  });

  it('rejects unknown option names (typos must not silently fall back to defaults)', () => {
    expect(() => resolveAuthThrottlePolicy([{ maxAttempt: 3 } as never])).toThrow(/unknown policy option "maxAttempt"/);
  });

  it('rejects non-object layers and non-boolean resetOnSuccess', () => {
    expect(() => resolveAuthThrottlePolicy([5 as never])).toThrow(InvalidThrottlePolicyError);
    expect(() => resolveAuthThrottlePolicy([null as never])).toThrow(InvalidThrottlePolicyError);
    expect(() => resolveAuthThrottlePolicy([{ resetOnSuccess: 'yes' as never }])).toThrow(
      InvalidThrottlePolicyError,
    );
  });

  it('names the offending policy in the error message', () => {
    expect(() => resolveAuthThrottlePolicy([{ maxAttempts: 0 }], 'policies.login')).toThrow(
      /policies\.login: maxAttempts/,
    );
  });
});

describe('createPolicyResolver', () => {
  it('uses the built-in default when no configuration is given', () => {
    const resolve = createPolicyResolver({});
    expect(resolve('login')).toEqual(DEFAULT_AUTH_THROTTLE_POLICY);
  });

  it('falls back to defaultPolicy for unknown and custom actions', () => {
    const resolve = createPolicyResolver({ defaultPolicy: { maxAttempts: 8 } });
    expect(resolve('login').maxAttempts).toBe(8);
    expect(resolve('my-custom-flow').maxAttempts).toBe(8);
  });

  it('applies per-action policies on top of defaultPolicy', () => {
    const resolve = createPolicyResolver({
      defaultPolicy: { maxAttempts: 8, window: 600, lockoutDuration: 300 },
      policies: { 'otp-request': { maxAttempts: 3 }, login: { cooldown: 5 } },
    });
    expect(resolve('otp-request')).toMatchObject({ maxAttempts: 3, window: 600, lockoutDuration: 300 });
    expect(resolve('login')).toMatchObject({ maxAttempts: 8, cooldown: 5 });
    expect(resolve('password-reset').maxAttempts).toBe(8);
  });

  it('supports different policies per action', () => {
    const resolve = createPolicyResolver({
      policies: { login: { maxAttempts: 5 }, 'otp-request': { maxAttempts: 3 } },
    });
    expect(resolve('login').maxAttempts).toBe(5);
    expect(resolve('otp-request').maxAttempts).toBe(3);
  });

  it('fails early on an invalid default policy', () => {
    expect(() => createPolicyResolver({ defaultPolicy: { maxAttempts: 0 } })).toThrow(
      /defaultPolicy: maxAttempts/,
    );
  });

  it('fails early on an invalid per-action policy, even if never used', () => {
    expect(() => createPolicyResolver({ policies: { login: { window: -1 } } })).toThrow(
      /policies\.login: window/,
    );
  });

  it('fails early on an invalid action name in policies', () => {
    expect(() => createPolicyResolver({ policies: { 'a:b': {} } })).toThrow(
      InvalidThrottleActionError,
    );
    expect(() => createPolicyResolver({ policies: { '': {} } })).toThrow(InvalidThrottleActionError);
  });

  it('rejects a malformed policies value', () => {
    expect(() => createPolicyResolver({ policies: [] as never })).toThrow(InvalidThrottlePolicyError);
  });
});
