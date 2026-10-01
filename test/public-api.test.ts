import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';

describe('public API surface', () => {
  it('exports exactly the intended runtime values', () => {
    expect(Object.keys(api).sort()).toEqual(
      [
        'AUTH_THROTTLE_CLOCK',
        'AUTH_THROTTLE_OPTIONS',
        'AUTH_THROTTLE_STORE',
        'AuthThrottle',
        'AuthThrottleError',
        'AuthThrottleGuard',
        'AuthThrottleModule',
        'AuthThrottleService',
        'AuthThrottleStoreError',
        'DEFAULT_AUTH_THROTTLE_POLICY',
        'InvalidAuthThrottleConfigError',
        'InvalidThrottleActionError',
        'InvalidThrottleKeyError',
        'InvalidThrottlePolicyError',
        'MemoryAuthThrottleStore',
      ].sort(),
    );
  });

  it('keeps state helpers and validation internal', () => {
    for (const internal of ['normalizeState', 'applyFailure', 'assertValidKey', 'createPolicyResolver']) {
      expect(api).not.toHaveProperty(internal);
    }
  });

  it('has an error hierarchy rooted in AuthThrottleError', () => {
    expect(new api.InvalidThrottlePolicyError('x')).toBeInstanceOf(api.InvalidAuthThrottleConfigError);
    for (const E of [
      api.InvalidAuthThrottleConfigError,
      api.InvalidThrottleKeyError,
      api.InvalidThrottleActionError,
      api.AuthThrottleStoreError,
    ]) {
      expect(new E('x')).toBeInstanceOf(api.AuthThrottleError);
      expect(new E('x').name).toBe(E.name);
    }
  });
});
