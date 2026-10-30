import { expect, test } from 'vitest';
import { verifyHostedApp, verifyRelease } from '../verify-release.js';

const commit = 'a'.repeat(40);
const options = { appUrl: 'https://poker.duckdns.org', commit, timeoutMs: 30000 };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('release waits through the handoff until the requested revision is ready', async () => {
  let clock = 0; let probes = 0; let smoked = false;
  const result = await verifyRelease(options, {
    now: () => clock, wait: async ms => { clock += ms; }, log: () => {}, smoke: async origin => { expect(origin).toBe(options.appUrl); smoked = true; },
    fetch: async input => {
      expect(String(input)).toBe(options.appUrl + '/readyz');
      probes++;
      if (probes === 1) return json({ ok: true, status: 'ready', revision: 'b'.repeat(40) });
      if (probes === 2) throw new Error('Connection refused while the container restarts.');
      if (probes === 3) return json({ ok: false, status: 'waiting-for-authority', revision: commit }, 503);
      return json({ ok: true, status: 'ready', revision: commit });
    },
  });
  expect(result).toEqual({ revision: commit });
  expect(probes).toBe(4); expect(smoked).toBe(true);
});

test('unready application times out without rolling back or resetting data', async () => {
  let clock = 0; let smoked = false;
  await expect(verifyRelease(options, { now: () => clock, wait: async ms => { clock += ms; }, log: () => {}, smoke: async () => { smoked = true; },
    fetch: async () => json({ ok: false, status: 'initializing', revision: commit }, 503) })).rejects.toThrow('no automatic rollback or database reset');
  expect(smoked).toBe(false);
});

test('release verification requires a full commit and a bare HTTPS origin', async () => {
  const fetch = async () => { throw new Error('No request is expected.'); };
  await expect(verifyRelease({ ...options, commit: 'abc123' }, { fetch })).rejects.toThrow('full tested Git commit SHA');
  for (const appUrl of ['', 'http://poker.duckdns.org', 'https://poker.duckdns.org/readyz']) {
    await expect(verifyRelease({ ...options, appUrl }, { fetch })).rejects.toThrow('HTTPS application origin');
  }
});

test('hosted smoke verification loads the real script and supplies only its fresh identity to the WebSocket', async () => {
  let upgraded = false;
  await verifyHostedApp(options.appUrl, async input => {
    if (String(input).endsWith('/api/identity')) return new Response('{}', { headers: { 'set-cookie': 'poker_local=smoke; Path=/; HttpOnly; Secure; SameSite=Strict' } });
    if (String(input).endsWith('/assets/app.js')) return new Response('export {};', { headers: { 'content-type': 'text/javascript' } });
    return new Response('<html><script type="module" src="/assets/app.js"></script></html>', { headers: { 'content-type': 'text/html' } });
  }, async (origin, cookie) => { expect(origin).toBe(options.appUrl); expect(cookie).toBe('poker_local=smoke'); upgraded = true; });
  expect(upgraded).toBe(true);
});
