/**
 * Identifies the kind of authentication attempt being throttled. The listed
 * values are conventional; any string matching the action-name rules works.
 */
export type AuthThrottleAction =
  | 'login'
  | 'password-reset'
  | 'otp-request'
  | 'otp-verification'
  | 'email-verification'
  | 'phone-verification'
  | 'mfa'
  | (string & {});

/** What a throttle entry applies to: an action plus an application-defined key. */
export interface AuthThrottleTarget {
  readonly action: AuthThrottleAction;
  /**
   * Application-defined identifier, e.g. `user:42`, `ip:203.0.113.7` or
   * `phone:+15550100`. Used verbatim: normalise it (case, Unicode) yourself.
   * Do not put credentials or secrets in it.
   */
  readonly key: string;
}

/** Source of time, in milliseconds since the Unix epoch. */
export interface AuthThrottleClock {
  now(): number;
}

/** Why an attempt is currently blocked. */
export type AuthThrottleBlockReason = 'cooldown' | 'locked';

export interface AuthThrottleAllowed {
  readonly allowed: true;
  /** Failures currently counted inside the policy window. */
  readonly failedAttempts: number;
  /** Failures left before lockout. */
  readonly remainingAttempts: number;
}

export interface AuthThrottleBlocked {
  readonly allowed: false;
  readonly reason: AuthThrottleBlockReason;
  /** Whole seconds (rounded up, at least 1) until the block ends. */
  readonly retryAfter: number;
  readonly failedAttempts: number;
  readonly remainingAttempts: number;
}

/** Result of `check`, `recordFailure`, `recordSuccess` and `getStatus`. */
export type AuthThrottleResult = AuthThrottleAllowed | AuthThrottleBlocked;
