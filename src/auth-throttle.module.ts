import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { InvalidAuthThrottleConfigError } from './auth-throttle.errors.js';
import type {
  AuthThrottleModuleAsyncOptions,
  AuthThrottleModuleOptions,
  AuthThrottleOptions,
} from './auth-throttle.options.js';
import { AuthThrottleService } from './auth-throttle.service.js';
import type { AuthThrottleStore } from './auth-throttle.store.js';
import {
  AUTH_THROTTLE_CLOCK,
  AUTH_THROTTLE_OPTIONS,
  AUTH_THROTTLE_STORE,
} from './auth-throttle.tokens.js';
import type { AuthThrottleClock } from './auth-throttle.types.js';
import { MemoryAuthThrottleStore } from './memory-auth-throttle.store.js';

const systemClock: AuthThrottleClock = { now: () => Date.now() };

/**
 * Wires the service, store and clock. Configuration is validated when the
 * service is created during application bootstrap, so an invalid policy stops
 * the app from starting instead of failing on the first login.
 */
@Module({})
export class AuthThrottleModule {
  static forRoot(options: AuthThrottleModuleOptions = {}): DynamicModule {
    const { global = false, ...config } = options;
    return build(global, [{ provide: AUTH_THROTTLE_OPTIONS, useValue: config }]);
  }

  static forRootAsync(options: AuthThrottleModuleAsyncOptions): DynamicModule {
    if (typeof options?.useFactory !== 'function') {
      throw new InvalidAuthThrottleConfigError('forRootAsync requires a useFactory function.');
    }
    return build(
      options.global ?? false,
      [
        {
          provide: AUTH_THROTTLE_OPTIONS,
          useFactory: options.useFactory as (...args: unknown[]) => Promise<AuthThrottleOptions> | AuthThrottleOptions,
          inject: [...(options.inject ?? [])],
        },
      ],
      options.imports,
    );
  }
}

function build(
  global: boolean,
  optionsProviders: Provider[],
  imports: DynamicModule['imports'] = [],
): DynamicModule {
  return {
    module: AuthThrottleModule,
    global,
    imports,
    providers: [
      ...optionsProviders,
      {
        provide: AUTH_THROTTLE_CLOCK,
        useFactory: (options: AuthThrottleOptions): AuthThrottleClock => options.clock ?? systemClock,
        inject: [AUTH_THROTTLE_OPTIONS],
      },
      {
        provide: AUTH_THROTTLE_STORE,
        useFactory: (options: AuthThrottleOptions, clock: AuthThrottleClock): AuthThrottleStore =>
          options.store ?? new MemoryAuthThrottleStore({ clock }),
        inject: [AUTH_THROTTLE_OPTIONS, AUTH_THROTTLE_CLOCK],
      },
      AuthThrottleService,
    ],
    exports: [AuthThrottleService],
  };
}
