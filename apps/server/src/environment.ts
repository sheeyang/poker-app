import type { HostedServerOptions } from './hosting.js';
import { defaultRateLimits } from './rate-limit.js';

/** The part of the process environment that configures hosting. */
type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Hosting options from the environment, apart from the database, address and web files.
 *
 * - `TRUSTED_PROXIES`: comma-separated addresses or CIDR ranges of the reverse proxy in front of the server (Caddy,
 *   in the production stack). Forwarding headers are believed only on a connection from one of them. Unset:
 *   no proxy is trusted, and every client's address is the connection's own.
 * - `POKER_RATE_LIMITS`: `true` or `false`. Per-address limits on table creation, joining and Table
 *   Password attempts. Unset: on in production and off elsewhere, so that development on one machine is not limited.
 * - `POKER_ADMIN_MODE`: `false` disables completed-Hand inspection.
 */
export function hostingOptionsFromEnvironment(environment: Environment): Pick<HostedServerOptions, 'secureCookies' | 'adminMode' | 'singleAuthority' | 'trustedProxies' | 'rateLimits'> {
  const production = environment.NODE_ENV === 'production';
  const trustedProxies = (environment.TRUSTED_PROXIES ?? '').split(',').map(entry => entry.trim()).filter(Boolean);
  return {
    secureCookies: production,
    adminMode: environment.POKER_ADMIN_MODE !== 'false',
    singleAuthority: production || environment.SINGLE_SERVER_GUARD === 'true',
    ...(trustedProxies.length ? { trustedProxies } : {}),
    ...((environment.POKER_RATE_LIMITS ?? String(production)) === 'true' ? { rateLimits: defaultRateLimits } : {}),
  };
}
