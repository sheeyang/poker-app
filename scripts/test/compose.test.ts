import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';

const compose = (await readFile(new URL('../../deploy/compose.yaml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
/** The text of one service block, from its name up to the next service or top-level key. */
const service = (name: string) => new RegExp(`^  ${name}:\\n((?:(?:    .*)?\\n)+)`, 'm').exec(compose)?.[1] ?? '';
const address = (text: string) => text.split('.').reduce((value, part) => value * 256 + Number(part), 0);

test('the app believes forwarding headers from Caddy’s fixed address and from nothing else', () => {
  const subnet = /subnet: (\d+\.\d+\.\d+\.\d+)\/(\d+)/.exec(compose);
  const caddy = /ipv4_address: (\S+)/.exec(service('caddy'))?.[1];
  const trusted = /TRUSTED_PROXIES: (\S+)/.exec(service('app'))?.[1];
  expect(subnet).not.toBeNull();
  expect(caddy).toBeDefined();
  // One address, not a range: the app's other neighbours (PostgreSQL) cannot vouch for a client's address.
  expect(trusted).toBe(caddy);
  const bits = 32 - Number(subnet![2]);
  expect(address(caddy!) >>> bits).toBe(address(subnet![1]!) >>> bits);
  // Nothing else is published: the app is reachable only through Caddy.
  expect(service('app')).not.toMatch(/^    ports:/m);
  expect(service('postgres')).not.toMatch(/^    ports:/m);
});
