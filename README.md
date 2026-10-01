# nestjs-auth-throttle

Attempt limits, cooldowns and temporary lockouts for authentication flows in NestJS: login, password reset, OTP, email/phone verification, MFA, or any action you define.

It tracks failed attempts per **action** and **key** and tells you what to do next. It does not authenticate anyone, and the service never decides HTTP responses (an optional guard can).

- NestJS-native: modules, DI tokens, an optional guard
- Per-action policies, with a default policy
- Pluggable storage; in-memory store included
- Race-safe state transitions (compare-and-set), deterministic time (injectable clock)
- No runtime dependencies besides the Nest peers

## Installation

```bash
npm install nestjs-auth-throttle
```

Peer dependencies: `@nestjs/common` and `@nestjs/core` `^12`, `reflect-metadata`, `rxjs`. The package is ESM and requires Node.js 20+.

## Basic setup

```ts
import { Module } from '@nestjs/common';
import { AuthThrottleModule } from 'nestjs-auth-throttle';

@Module({
  imports: [AuthThrottleModule.forRoot()], // built-in default policy, in-memory store
})
export class AppModule {}
```

The built-in default is 5 failures per 15 minutes, then a 15 minute lockout, no cooldown, success resets failures.

### `forRoot`

```ts
AuthThrottleModule.forRoot({
  global: true, // optional: make AuthThrottleService injectable everywhere
  defaultPolicy: { maxAttempts: 5, window: 15 * 60, lockoutDuration: 15 * 60 },
  policies: {
    login: { cooldown: 2 },
    'otp-request': { maxAttempts: 3, window: 10 * 60, lockoutDuration: 30 * 60 },
    'otp-verification': { maxAttempts: 5, lockoutDuration: 60 * 60 },
  },
});
```

### `forRootAsync`

```ts
AuthThrottleModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService, RedisThrottleStore],
  useFactory: (config: ConfigService, store: RedisThrottleStore) => ({
    store,
    defaultPolicy: { maxAttempts: config.getOrThrow<number>('AUTH_MAX_ATTEMPTS') },
  }),
});
```

Options are validated when the application bootstraps. An invalid policy stops the app from starting.

## Basic login example

Check **before** verifying credentials, record the outcome **after**.

```ts
@Injectable()
export class AuthService {
  constructor(
    @Inject(AuthThrottleService) private readonly throttle: AuthThrottleService,
    private readonly users: UsersService,
  ) {}

  async login(email: string, password: string) {
    const target = { action: 'login', key: `email:${email.trim().toLowerCase()}` };

    const state = await this.throttle.check(target);
    if (!state.allowed) {
      throw new HttpException(
        { message: 'Too many attempts', retryAfter: state.retryAfter },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const user = await this.users.verifyCredentials(email, password);
    if (!user) {
      await this.throttle.recordFailure(target);
      throw new UnauthorizedException();
    }

    await this.throttle.recordSuccess(target);
    return this.issueSession(user);
  }
}
```

The `key` is entirely yours: `user:42`, `ip:203.0.113.7`, `phone:+15550100`, `user:42:ip:203.0.113.7`. It is used verbatim, so normalise it yourself. Keys must be 1-256 characters, not blank, with no control characters. Actions must match `[A-Za-z0-9][A-Za-z0-9._-]*` (max 64).

## How limit, cooldown and lockout interact

| Concept | Option | Meaning |
|---|---|---|
| Attempt limit | `maxAttempts` | Failures allowed within `window`. |
| Window | `window` (s) | A failure counts while it is younger than this (sliding). A failure exactly `window` old no longer counts. |
| Cooldown | `cooldown` (s) | After *every* failure, further attempts are blocked for this long. `0` disables it. Must be shorter than `window`. |
| Lockout | `lockoutDuration` (s) | Once the limit is reached the key is blocked this long. Afterwards the count starts again from zero. |

- The failure that reaches `maxAttempts` starts the lockout immediately (`maxAttempts: 1` locks on the first failure).
- Lockout wins over cooldown. A lockout may outlast the window.
- A failure *recorded* during cooldown still counts and restarts the cooldown, so parallel guesses cannot dodge the limit.
- A failure recorded during a lockout changes nothing: it does not extend the lockout, so an attacker cannot keep a victim locked out indefinitely.

### Cooldown example

```ts
AuthThrottleModule.forRoot({ policies: { login: { maxAttempts: 5, cooldown: 3 } } });

await throttle.recordFailure(target);
// { allowed: false, reason: 'cooldown', retryAfter: 3, failedAttempts: 1, remainingAttempts: 4 }
```

### Lockout example

```ts
// maxAttempts: 3, lockoutDuration: 900
await throttle.recordFailure(target);
await throttle.recordFailure(target);
await throttle.recordFailure(target);
// { allowed: false, reason: 'locked', retryAfter: 900, failedAttempts: 3, remainingAttempts: 0 }
```

## Success and reset

- `recordSuccess` clears recorded failures when the policy has `resetOnSuccess: true` (the default). Set it to `false` for actions where success should not forgive failures, for example `otp-request`, where counting *requests* is the point.
- `recordSuccess` never lifts an active lockout. Only `reset` does, so code that forgot to `check` cannot bypass a lockout.
- `reset(target)` unconditionally clears state, including a lockout: use it for admin unlocks, completed password resets and account recovery.

## Multiple actions and custom policies

Each action has its own state and policy. Any string is a valid action; actions without an entry in `policies` use `defaultPolicy`. Policy options are validated eagerly and typos are rejected.

```ts
await throttle.recordFailure({ action: 'otp-verification', key: `phone:${phone}` });
await throttle.check({ action: 'my-custom-flow', key: `device:${deviceId}` });
```

### Changing a policy later

Stored state contains only timestamps, and the policy is applied when state is evaluated, so a new policy takes effect on existing state immediately:

- raising `maxAttempts` gives unlocked keys more headroom; an existing lockout continues until it ends;
- lowering `maxAttempts` below a key's stored failure count locks it (measured from its latest failure);
- a shorter or longer `window` or `lockoutDuration` re-applies to the stored timestamps.

## Custom storage

Implement `AuthThrottleStore` and pass it as `store`:

```ts
interface AuthThrottleStore {
  get(key: string): Promise<AuthThrottleStoreEntry | undefined>;
  compareAndSet(key: string, expectedVersion: number | undefined, state: AuthThrottleState, ttlMs: number): Promise<boolean>;
  delete(key: string, expectedVersion?: number): Promise<boolean>;
}
```

A store must:

1. treat expired entries as absent everywhere;
2. make `compareAndSet` and `delete(key, version)` **atomic across all writers on the same key, including other processes** (a Lua script in Redis, a conditional `UPDATE ... WHERE version = ?` in SQL);
3. give every successful write a fresh version that is never reused for that key, even after expiry;
4. throw on infrastructure failure rather than returning empty results.

The service never does get-modify-set blindly: it reads, computes the next state, and writes only if the version is unchanged, retrying on conflict. N concurrent failures therefore always count as N. Redis is not a dependency of this package; a Redis store only needs to implement the contract above.

## In-memory store

`MemoryAuthThrottleStore` is the default. It is atomic within a single process and suitable for development, tests and single-instance apps. It is **not** shared between processes or instances and loses state on restart (a restart clears every lockout). In a multi-instance deployment the effective limit becomes `maxAttempts x instances`.

Memory is bounded: expired entries are removed on access and swept every 500 writes (no timers), and the store holds at most `maxEntries` keys (default 10 000), evicting the least recently written entry when full. Because of that eviction, an attacker flooding unique keys can push out other keys' state, which is one more reason to use a shared store in production.

```ts
new MemoryAuthThrottleStore({ maxEntries: 50_000, sweepEvery: 1000 });
```

## Guard usage

The guard is optional and **check-only**: it rejects blocked requests with `429` and a `Retry-After` header. You still call `recordFailure` / `recordSuccess` in your authentication code.

```ts
@Controller('auth')
export class AuthController {
  @Post('login')
  @UseGuards(AuthThrottleGuard)
  @AuthThrottle({
    action: 'login',
    key: (ctx) => {
      const email = ctx.switchToHttp().getRequest().body?.email;
      return typeof email === 'string' ? `email:${email.trim().toLowerCase()}` : undefined; // undefined = skip
    },
  })
  login(@Body() dto: LoginDto) { /* ... */ }
}
```

The module containing the controller must import `AuthThrottleModule` (or register it with `global: true`). If the store fails, the guard fails closed and the request errors.

## Storage failures

If the store throws or returns malformed state, the service throws `AuthThrottleStoreError` (original error in `cause`). It never turns an infrastructure failure into an `allowed` or `locked` result and never swallows it. Your code chooses: reject the login (fail closed, the guard's behaviour) or proceed unthrottled (fail open), and that choice is visible in your code.

## Security considerations

- **Account lockout is an abuse vector.** Anyone who knows a username can lock that account. Consider throttling by IP (`ip:...`) or `user + ip` instead of, or in addition to, the account, prefer cooldowns over long lockouts, and give legitimate users a recovery path (`reset`).
- **User enumeration.** A blocked response can reveal that an identifier exists, or that it doesn't. Throttle by identifier regardless of whether the account exists, and return the same response shape for unknown and known users.
- **Timing.** Keep the work done for unknown and known users comparable; the throttle itself performs the same operations either way.
- **Identifier privacy.** Keys end up in your store. Consider keying on an HMAC of the email or phone rather than the raw value.
- **Never** put passwords, OTPs or tokens in keys. State contains only timestamps and the library never logs keys or state; store error messages omit the key.
- **IP keys:** make sure your proxy configuration yields the real client IP (for example Express `trust proxy`), or attackers can choose their own key.
- **Clock behaviour:** timestamps from the future (instance clock skew) are clamped to "now", so skew cannot extend a cooldown or lockout.

## Production and distributed deployments

Use a shared store whose `compareAndSet` is atomic (see Custom storage). Set TTLs from the `ttlMs` argument. Keep instance clocks synchronised (NTP). Decide your storage-failure behaviour deliberately (see above).

## API overview

```ts
throttle.check(target): Promise<AuthThrottleResult>        // read-only
throttle.getStatus(target): Promise<AuthThrottleStatus>    // read-only, detailed
throttle.recordFailure(target): Promise<AuthThrottleResult>
throttle.recordSuccess(target): Promise<AuthThrottleResult>
throttle.reset(target): Promise<void>
```

```ts
type AuthThrottleResult =
  | { allowed: true; failedAttempts: number; remainingAttempts: number }
  | { allowed: false; reason: 'cooldown' | 'locked'; retryAfter: number; failedAttempts: number; remainingAttempts: number };
```

`retryAfter` is whole seconds, rounded up. `getStatus` additionally returns `state`, `maxAttempts` and `blockedUntil` (epoch ms).

Exports: `AuthThrottleModule`, `AuthThrottleService`, `AuthThrottleGuard`, `AuthThrottle`, `MemoryAuthThrottleStore`, the `AUTH_THROTTLE_*` tokens, `DEFAULT_AUTH_THROTTLE_POLICY`, the error classes (`InvalidThrottlePolicyError`, `InvalidThrottleKeyError`, `InvalidThrottleActionError`, `InvalidAuthThrottleConfigError`, `AuthThrottleStoreError`), and the option, policy, store and result types.

## Testing

Inject a clock so time-based tests never sleep:

```ts
const clock = { t: 0, now() { return this.t; } };
const ref = await Test.createTestingModule({
  imports: [AuthThrottleModule.forRoot({ clock, defaultPolicy: { lockoutDuration: 60 } })],
}).compile();
clock.t += 60_000;
```

To work on this package: `npm run typecheck`, `npm test`, `npm run build`.

## Future scope

Not implemented: Redis or database stores, multi-key checks in one call, an optional key-hashing helper, and a framework-independent core (which, if it is ever needed, would be a separate package).

## License

MIT
