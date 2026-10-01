/** Base class for every error thrown by this package. */
export class AuthThrottleError extends Error {
  override name = 'AuthThrottleError';
}

/** Thrown at startup when module options are invalid. */
export class InvalidAuthThrottleConfigError extends AuthThrottleError {
  override name = 'InvalidAuthThrottleConfigError';
}

/** Thrown at startup when a throttle policy is invalid. */
export class InvalidThrottlePolicyError extends InvalidAuthThrottleConfigError {
  override name = 'InvalidThrottlePolicyError';
}

/** Thrown when a call is made with an unusable throttle key. */
export class InvalidThrottleKeyError extends AuthThrottleError {
  override name = 'InvalidThrottleKeyError';
}

/** Thrown when an action name is unusable (in a call or in configuration). */
export class InvalidThrottleActionError extends AuthThrottleError {
  override name = 'InvalidThrottleActionError';
}

/**
 * Thrown when the store fails, returns malformed state, or cannot complete an
 * update. It is never converted into an `allowed`/`locked` result: callers
 * decide explicitly how to react (see README, "Storage failures").
 */
export class AuthThrottleStoreError extends AuthThrottleError {
  override name = 'AuthThrottleStoreError';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}
