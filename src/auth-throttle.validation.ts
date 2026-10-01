import { InvalidThrottleActionError, InvalidThrottleKeyError } from './auth-throttle.errors.js';

export const MAX_ACTION_LENGTH = 64;
export const MAX_KEY_LENGTH = 256;

// Letters, digits, '.', '_' and '-'; must start alphanumeric. ':' is excluded
// so `${action}:${key}` can never be ambiguous.
const ACTION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CONTROL_CHARACTERS = /\p{Cc}/u;

export function assertValidAction(action: unknown): asserts action is string {
  if (typeof action !== 'string') {
    throw new InvalidThrottleActionError('Throttle action must be a string.');
  }
  if (action.length === 0 || action.length > MAX_ACTION_LENGTH || !ACTION_PATTERN.test(action)) {
    throw new InvalidThrottleActionError(
      `Throttle action must be 1-${MAX_ACTION_LENGTH} characters of letters, digits, '.', '_' or '-', starting with a letter or digit.`,
    );
  }
}

export function assertValidKey(key: unknown): asserts key is string {
  if (typeof key !== 'string') {
    throw new InvalidThrottleKeyError('Throttle key must be a string.');
  }
  if (key.trim().length === 0) {
    throw new InvalidThrottleKeyError('Throttle key must not be empty or whitespace-only.');
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new InvalidThrottleKeyError(`Throttle key must not exceed ${MAX_KEY_LENGTH} characters.`);
  }
  if (CONTROL_CHARACTERS.test(key)) {
    throw new InvalidThrottleKeyError('Throttle key must not contain control characters.');
  }
}
