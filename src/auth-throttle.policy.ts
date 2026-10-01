import { InvalidThrottlePolicyError } from './auth-throttle.errors.js';
import { assertValidAction } from './auth-throttle.validation.js';

/**
 * Throttle policy for one authentication action.
 *
 * - `maxAttempts` (attempt limit): failures allowed inside `window`. The
 *   failure that reaches this number starts a lockout.
 * - `window` (seconds): a failure counts towards the limit while it is younger
 *   than this. Sliding window; a failure exactly `window` seconds old has expired.
 * - `cooldown` (seconds): after every failure, attempts are blocked for this
 *   long. `0` disables cooldown. Must be shorter than `window`.
 * - `lockoutDuration` (seconds): how long the key is blocked once the limit is
 *   reached. When it ends the failure count starts again from zero.
 * - `resetOnSuccess`: whether a successful attempt clears recorded failures.
 */
export interface AuthThrottlePolicy {
  readonly maxAttempts: number;
  readonly window: number;
  readonly cooldown: number;
  readonly lockoutDuration: number;
  readonly resetOnSuccess: boolean;
}

/** Partial policy as written in configuration; omitted fields are inherited. */
export type AuthThrottlePolicyOptions = Partial<AuthThrottlePolicy>;

/** Policy-related part of the module options. */
export interface AuthThrottlePolicyConfig {
  /** Applied to every action without its own entry; merged over the built-in default. */
  readonly defaultPolicy?: AuthThrottlePolicyOptions;
  /** Per-action policies; each is merged over `defaultPolicy`. */
  readonly policies?: Readonly<Record<string, AuthThrottlePolicyOptions>>;
}

export const DEFAULT_AUTH_THROTTLE_POLICY: AuthThrottlePolicy = Object.freeze({
  maxAttempts: 5,
  window: 15 * 60,
  cooldown: 0,
  lockoutDuration: 15 * 60,
  resetOnSuccess: true,
});

/** Upper bounds keep per-key state small and reject obviously mistaken values. */
export const MAX_ATTEMPTS_LIMIT = 1000;
export const MAX_DURATION_SECONDS = 365 * 24 * 60 * 60;

const POLICY_KEYS: ReadonlySet<string> = new Set([
  'maxAttempts',
  'window',
  'cooldown',
  'lockoutDuration',
  'resetOnSuccess',
]);

function readNumber(
  label: string,
  name: string,
  value: unknown,
  rule: { min: number; minInclusive: boolean; max: number; integer?: boolean },
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidThrottlePolicyError(`${label}: ${name} must be a finite number.`);
  }
  if (rule.integer === true && !Number.isInteger(value)) {
    throw new InvalidThrottlePolicyError(`${label}: ${name} must be an integer.`);
  }
  const aboveMin = rule.minInclusive ? value >= rule.min : value > rule.min;
  if (!aboveMin) {
    throw new InvalidThrottlePolicyError(
      `${label}: ${name} must be ${rule.minInclusive ? 'at least' : 'greater than'} ${rule.min}.`,
    );
  }
  if (value > rule.max) {
    throw new InvalidThrottlePolicyError(`${label}: ${name} must not exceed ${rule.max}.`);
  }
  return value;
}

/**
 * Merges policy layers over the built-in default (later layers win; `undefined`
 * fields are ignored) and validates the result.
 */
export function resolveAuthThrottlePolicy(
  layers: readonly (AuthThrottlePolicyOptions | undefined)[],
  label = 'policy',
): AuthThrottlePolicy {
  const raw: Record<string, unknown> = { ...DEFAULT_AUTH_THROTTLE_POLICY };

  for (const layer of layers) {
    if (layer === undefined) continue;
    if (typeof layer !== 'object' || layer === null || Array.isArray(layer)) {
      throw new InvalidThrottlePolicyError(`${label}: policy must be an object.`);
    }
    for (const [name, value] of Object.entries(layer)) {
      if (!POLICY_KEYS.has(name)) {
        throw new InvalidThrottlePolicyError(`${label}: unknown policy option "${name}".`);
      }
      if (value !== undefined) raw[name] = value;
    }
  }

  const maxAttempts = readNumber(label, 'maxAttempts', raw['maxAttempts'], {
    min: 1,
    minInclusive: true,
    max: MAX_ATTEMPTS_LIMIT,
    integer: true,
  });
  const window = readNumber(label, 'window', raw['window'], {
    min: 0,
    minInclusive: false,
    max: MAX_DURATION_SECONDS,
  });
  const cooldown = readNumber(label, 'cooldown', raw['cooldown'], {
    min: 0,
    minInclusive: true,
    max: MAX_DURATION_SECONDS,
  });
  const lockoutDuration = readNumber(label, 'lockoutDuration', raw['lockoutDuration'], {
    min: 0,
    minInclusive: false,
    max: MAX_DURATION_SECONDS,
  });
  const resetOnSuccess = raw['resetOnSuccess'];
  if (typeof resetOnSuccess !== 'boolean') {
    throw new InvalidThrottlePolicyError(`${label}: resetOnSuccess must be a boolean.`);
  }
  if (cooldown >= window) {
    throw new InvalidThrottlePolicyError(
      `${label}: cooldown (${cooldown}s) must be shorter than window (${window}s), otherwise a failure would expire before its cooldown ends.`,
    );
  }

  return Object.freeze({ maxAttempts, window, cooldown, lockoutDuration, resetOnSuccess });
}

/** Returns the effective policy for an action. */
export type AuthThrottlePolicyResolver = (action: string) => AuthThrottlePolicy;

/**
 * Validates every configured policy eagerly (so bad configuration fails at
 * startup) and returns a lookup. Actions without an entry use the default
 * policy, which is how custom actions work without registration.
 */
export function createPolicyResolver(config: AuthThrottlePolicyConfig): AuthThrottlePolicyResolver {
  const defaultPolicy = resolveAuthThrottlePolicy([config.defaultPolicy], 'defaultPolicy');
  const perAction = new Map<string, AuthThrottlePolicy>();

  const entries = config.policies;
  if (entries !== undefined) {
    if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
      throw new InvalidThrottlePolicyError('policies must be an object keyed by action.');
    }
    for (const [action, policy] of Object.entries(entries)) {
      assertValidAction(action);
      perAction.set(
        action,
        resolveAuthThrottlePolicy([config.defaultPolicy, policy], `policies.${action}`),
      );
    }
  }

  return (action) => perAction.get(action) ?? defaultPolicy;
}
