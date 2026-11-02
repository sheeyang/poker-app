import { expect, test } from 'vitest';
import { hostingOptionsFromEnvironment } from '../src/environment.js';
import { defaultRateLimits } from '../src/rate-limit.js';

test('production trusts forwarding headers only from the proxies it names, and limits requests per address', () => {
  expect(hostingOptionsFromEnvironment({ NODE_ENV: 'production', TRUSTED_PROXIES: ' 172.29.77.2 , 10.0.0.0/8,' })).toEqual({
    secureCookies: true, adminMode: true, singleAuthority: true, trustedProxies: ['172.29.77.2', '10.0.0.0/8'], rateLimits: defaultRateLimits,
  });
  // With nothing named, no proxy is trusted: a forged header changes nothing.
  expect(hostingOptionsFromEnvironment({ NODE_ENV: 'production' })).not.toHaveProperty('trustedProxies');
  expect(hostingOptionsFromEnvironment({ NODE_ENV: 'production', TRUSTED_PROXIES: ' , ' })).not.toHaveProperty('trustedProxies');
});

test('local development is not rate limited unless asked, and production can be told not to', () => {
  expect(hostingOptionsFromEnvironment({})).toEqual({ secureCookies: false, adminMode: true, singleAuthority: false });
  expect(hostingOptionsFromEnvironment({ POKER_RATE_LIMITS: 'true' })).toHaveProperty('rateLimits', defaultRateLimits);
  expect(hostingOptionsFromEnvironment({ NODE_ENV: 'production', POKER_RATE_LIMITS: 'false' })).not.toHaveProperty('rateLimits');
  expect(hostingOptionsFromEnvironment({ POKER_ADMIN_MODE: 'false', SINGLE_SERVER_GUARD: 'true' })).toMatchObject({ adminMode: false, singleAuthority: true });
});
