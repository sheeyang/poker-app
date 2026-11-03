import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';

const compose = (await readFile(new URL('../../deploy/compose.yaml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
/** The text of one service block, from its name up to the next service or top-level key. */
const service = (name: string) => new RegExp(`^  ${name}:\\n((?:(?:    .*)?\\n)+)`, 'm').exec(compose)?.[1] ?? '';
const address = (text: string) => text.split('.').reduce((value, part) => value * 256 + Number(part), 0);
/** The network's address block for one IPAM key, such as `subnet` or `ip_range`. */
const block = (key: string) => {
  const match = new RegExp(`${key}: (\\d+\\.\\d+\\.\\d+\\.\\d+)/(\\d+)`).exec(compose);
  return match ? { base: match[1]!, prefix: Number(match[2]) } : undefined;
};
const within = (text: string, { base, prefix }: { base: string; prefix: number }) =>
  address(text) >>> (32 - prefix) === address(base) >>> (32 - prefix);
const caddy = /ipv4_address: (\S+)/.exec(service('caddy'))?.[1];

test('the app believes forwarding headers from Caddy’s fixed address and from nothing else', () => {
  const subnet = block('subnet');
  const trusted = /TRUSTED_PROXIES: (\S+)/.exec(service('app'))?.[1];
  expect(subnet).toBeDefined();
  expect(caddy).toBeDefined();
  // One address, not a range: the app's other neighbours (PostgreSQL) cannot vouch for a client's address.
  expect(trusted).toBe(caddy);
  expect(within(caddy!, subnet!)).toBe(true);
  // Nothing else is published: the app is reachable only through Caddy.
  expect(service('app')).not.toMatch(/^    ports:/m);
  expect(service('postgres')).not.toMatch(/^    ports:/m);
});

test('Docker never gives Caddy’s fixed address to a container that starts before Caddy', () => {
  const subnet = block('subnet');
  const automatic = block('ip_range');
  const gateway = /gateway: (\S+)/.exec(compose)?.[1];
  expect(automatic).toBeDefined();
  expect(gateway).toBeDefined();
  expect(within(automatic!.base, subnet!) && automatic!.prefix > subnet!.prefix).toBe(true);
  expect(within(caddy!, automatic!)).toBe(false);
  expect(caddy).not.toBe(gateway);
});
