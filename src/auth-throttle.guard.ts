import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type CustomDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthThrottleService } from './auth-throttle.service.js';
import type { AuthThrottleAction, AuthThrottleBlocked } from './auth-throttle.types.js';

export const AUTH_THROTTLE_METADATA = Symbol('AUTH_THROTTLE_METADATA');

export interface AuthThrottleGuardOptions {
  readonly action: AuthThrottleAction;
  /**
   * Builds the throttle key from the request context, e.g.
   * `(ctx) => 'ip:' + ctx.switchToHttp().getRequest().ip`. Return `undefined`
   * to skip throttling for this request (for example when the identifying
   * field is missing and request validation will reject it anyway).
   */
  readonly key: (context: ExecutionContext) => string | undefined | Promise<string | undefined>;
}

/** Declares which action and key `AuthThrottleGuard` should check for a route. */
export const AuthThrottle = (options: AuthThrottleGuardOptions): CustomDecorator<symbol> =>
  SetMetadata(AUTH_THROTTLE_METADATA, options);

interface HeaderWritable {
  setHeader?: (name: string, value: string) => unknown;
  header?: (name: string, value: string) => unknown;
}

/**
 * Optional HTTP convenience. It only *checks*: a blocked request is rejected
 * with `429 Too Many Requests` and a `Retry-After` header. It never records
 * outcomes, because only your authentication code knows whether credentials
 * were wrong; call `recordFailure` / `recordSuccess` there.
 *
 * Store failures propagate (the request fails with a 500): the guard fails
 * closed rather than letting attempts through unthrottled.
 *
 * Without `@AuthThrottle(...)` metadata the guard does nothing.
 */
@Injectable()
export class AuthThrottleGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthThrottleService) private readonly throttle: AuthThrottleService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<AuthThrottleGuardOptions | undefined>(
      AUTH_THROTTLE_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (options === undefined) return true;

    const key = await options.key(context);
    if (key === undefined) return true;

    const result = await this.throttle.check({ action: options.action, key });
    if (result.allowed) return true;

    this.setRetryAfter(context, result);
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: 'Too many attempts. Try again later.',
        error: 'Too Many Requests',
        reason: result.reason,
        retryAfter: result.retryAfter,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private setRetryAfter(context: ExecutionContext, result: AuthThrottleBlocked): void {
    if (context.getType() !== 'http') return;
    const response: unknown = context.switchToHttp().getResponse();
    if (typeof response !== 'object' || response === null) return;
    const writable = response as HeaderWritable;
    const value = String(result.retryAfter);
    if (typeof writable.setHeader === 'function') writable.setHeader('Retry-After', value);
    else if (typeof writable.header === 'function') writable.header('Retry-After', value);
  }
}
