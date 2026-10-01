// Public entry point of nestjs-auth-throttle.
// Exports are added deliberately as each part of the package lands.
export type {
  AuthThrottleAction,
  AuthThrottleAllowed,
  AuthThrottleBlockReason,
  AuthThrottleBlocked,
  AuthThrottleClock,
  AuthThrottleResult,
  AuthThrottleTarget,
} from './auth-throttle.types.js';
export {
  DEFAULT_AUTH_THROTTLE_POLICY,
  type AuthThrottlePolicy,
  type AuthThrottlePolicyOptions,
} from './auth-throttle.policy.js';
export type {
  AuthThrottleModuleAsyncOptions,
  AuthThrottleModuleOptions,
  AuthThrottleOptions,
} from './auth-throttle.options.js';
export type {
  AuthThrottleState,
  AuthThrottleStore,
  AuthThrottleStoreEntry,
} from './auth-throttle.store.js';
export {
  AUTH_THROTTLE_CLOCK,
  AUTH_THROTTLE_OPTIONS,
  AUTH_THROTTLE_STORE,
} from './auth-throttle.tokens.js';
export {
  AuthThrottleError,
  AuthThrottleStoreError,
  InvalidAuthThrottleConfigError,
  InvalidThrottleActionError,
  InvalidThrottleKeyError,
  InvalidThrottlePolicyError,
} from './auth-throttle.errors.js';
export { AuthThrottleService } from './auth-throttle.service.js';
export { AuthThrottleModule } from './auth-throttle.module.js';
export {
  MemoryAuthThrottleStore,
  type MemoryAuthThrottleStoreOptions,
} from './memory-auth-throttle.store.js';
export type { AuthThrottleStatus } from './auth-throttle.types.js';
