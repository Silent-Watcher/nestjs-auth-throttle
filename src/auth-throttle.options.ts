import type { InjectionToken, ModuleMetadata, OptionalFactoryDependency } from '@nestjs/common';
import type { AuthThrottlePolicyConfig } from './auth-throttle.policy.js';
import type { AuthThrottleStore } from './auth-throttle.store.js';
import type { AuthThrottleClock } from './auth-throttle.types.js';

export interface AuthThrottleOptions extends AuthThrottlePolicyConfig {
  /**
   * Store to use. Defaults to a new in-memory store, which is only suitable for
   * a single process (development, tests).
   */
  readonly store?: AuthThrottleStore;
  /** Time source. Defaults to the system clock; override in tests. */
  readonly clock?: AuthThrottleClock;
}

export interface AuthThrottleModuleOptions extends AuthThrottleOptions {
  /** Register the module globally. Defaults to `false`. */
  readonly global?: boolean;
}

export interface AuthThrottleModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  readonly inject?: readonly (InjectionToken | OptionalFactoryDependency)[];
  readonly useFactory: (...args: never[]) => AuthThrottleOptions | Promise<AuthThrottleOptions>;
  /** Register the module globally. Defaults to `false`. */
  readonly global?: boolean;
}
