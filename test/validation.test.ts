import { describe, expect, it } from 'vitest';
import {
  MAX_ACTION_LENGTH,
  MAX_KEY_LENGTH,
  assertValidAction,
  assertValidKey,
} from '../src/auth-throttle.validation.js';
import {
  InvalidThrottleActionError,
  InvalidThrottleKeyError,
} from '../src/auth-throttle.errors.js';

describe('assertValidKey', () => {
  it.each(['user:42', 'ip:203.0.113.7', 'phone:+15550100', 'user:1:ip:::1', 'a', 'ключ:😀'])(
    'accepts %s',
    (key) => {
      expect(() => assertValidKey(key)).not.toThrow();
    },
  );

  it('accepts a key of exactly the maximum length and rejects one character more', () => {
    expect(() => assertValidKey('k'.repeat(MAX_KEY_LENGTH))).not.toThrow();
    expect(() => assertValidKey('k'.repeat(MAX_KEY_LENGTH + 1))).toThrow(InvalidThrottleKeyError);
  });

  it.each(['', ' ', '\t\n', '   '])('rejects empty or whitespace-only key %j', (key) => {
    expect(() => assertValidKey(key)).toThrow(InvalidThrottleKeyError);
  });

  it.each(['a\nb', 'a\u0000b', 'a\rb', 'a\u007fb', 'a\u0085b'])(
    'rejects control characters in %j',
    (key) => {
      expect(() => assertValidKey(key)).toThrow(/control characters/);
    },
  );

  it.each([undefined, null, 42, {}, ['a'], Symbol('x')])('rejects non-string %s', (key) => {
    expect(() => assertValidKey(key)).toThrow(InvalidThrottleKeyError);
  });

  it('does not trim or normalise: padded keys are accepted as-is', () => {
    expect(() => assertValidKey(' user:1 ')).not.toThrow();
  });
});

describe('assertValidAction', () => {
  it.each(['login', 'otp-verification', 'custom.flow_2', 'A1'])('accepts %s', (action) => {
    expect(() => assertValidAction(action)).not.toThrow();
  });

  it('accepts the maximum length and rejects one more', () => {
    expect(() => assertValidAction('a'.repeat(MAX_ACTION_LENGTH))).not.toThrow();
    expect(() => assertValidAction('a'.repeat(MAX_ACTION_LENGTH + 1))).toThrow(
      InvalidThrottleActionError,
    );
  });

  it.each(['', 'a:b', 'has space', '-leading', '_leading', '.dot', 'new\nline', 'ü'])(
    'rejects %j',
    (action) => {
      expect(() => assertValidAction(action)).toThrow(InvalidThrottleActionError);
    },
  );

  it('rejects non-strings', () => {
    expect(() => assertValidAction(undefined)).toThrow(InvalidThrottleActionError);
    expect(() => assertValidAction(1)).toThrow(InvalidThrottleActionError);
  });

  it('rejects prototype-pollution style names', () => {
    expect(() => assertValidAction('__proto__')).toThrow(InvalidThrottleActionError);
    expect(() => assertValidAction('constructor')).not.toThrow(); // harmless: policies use a Map
  });
});
