import { expect, test } from 'vitest';
import { deployRender, verifyHostedApp } from '../deploy-render.js';

const commit = 'a'.repeat(40);
const options = { apiKey: 'private-token', serviceId: 'srv-test', appUrl: 'https://poker.onrender.com', commit, timeoutMs: 30000 };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('release pins the tested commit and waits beyond provider liveness for application readiness', async () => {
  let clock = 0; let probes = 0; let posts = 0; let smoked = false;
  const messages: string[] = [];
  const result = await deployRender(options, {
    now: () => clock, wait: async ms => { clock += ms; }, log: message => { messages.push(message); }, smoke: async () => { smoked = true; },
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith('/readyz')) {
        expect(init?.headers).toBeUndefined();
        return ++probes === 1 ? json({ ok: true, status: 'ready', revision: 'old' }) : json({ ok: true, status: 'ready', revision: commit });
      }
      expect(init?.headers).toMatchObject({ authorization: 'Bearer private-token' });
      if (init?.method === 'POST') { posts++; expect(JSON.parse(String(init.body))).toEqual({ commitId: commit }); return json({ id: 'dep-test' }); }
      if (url.endsWith('/dep-test')) return json({ id: 'dep-test', status: 'live', commit: { id: commit } });
      return json({ type: 'web_service', autoDeployTrigger: 'off' });
    },
  });
  expect(result).toEqual({ deployId: 'dep-test', revision: commit });
  expect(probes).toBe(2); expect(posts).toBe(1); expect(smoked).toBe(true);
  expect(messages.join(' ')).not.toContain('private-token');
});

test('an ambiguous deploy creation is never automatically retried', async () => {
  let posts = 0;
  await expect(deployRender(options, { fetch: async (_input, init) => {
    if (init?.method === 'POST') { posts++; throw new Error('Connection lost after sending request.'); }
    return json({ type: 'web_service', autoDeploy: 'no' });
  } })).rejects.toThrow('Inspect Render Deploys');
  expect(posts).toBe(1);
});

test('a transient provider read is retried without creating a second deployment', async () => {
  let clock = 0; let reads = 0; let posts = 0;
  await deployRender(options, { now: () => clock, wait: async ms => { clock += ms; }, log: () => {}, smoke: async () => {}, fetch: async (input, init) => {
    if (init?.method === 'POST') { posts++; return json({ id: 'dep-test' }); }
    if (String(input).endsWith('/dep-test')) return ++reads === 1 ? json({}, 503) : json({ status: 'live', commit: { id: commit } });
    if (String(input).endsWith('/readyz')) return json({ ok: true, status: 'ready', revision: commit });
    return json({ type: 'web_service', autoDeploy: 'no' });
  } });
  expect(reads).toBe(2); expect(posts).toBe(1);
});

test('a live provider deployment of a different commit is rejected', async () => {
  await expect(deployRender(options, { log: () => {}, fetch: async (input, init) => {
    if (init?.method === 'POST') return json({ id: 'dep-test' });
    if (String(input).endsWith('/dep-test')) return json({ status: 'live', commit: { id: 'b'.repeat(40) } });
    return json({ type: 'web_service', autoDeploy: 'no' });
  } })).rejects.toThrow('different commit');
});

test('automatic deploys must be disabled before a release mutates Render', async () => {
  let posts = 0;
  await expect(deployRender(options, { fetch: async (_input, init) => { if (init?.method === 'POST') posts++; return json({ type: 'web_service', autoDeploy: 'yes' }); } })).rejects.toThrow('automatic deploys disabled');
  expect(posts).toBe(0);
});

test('unready application times out without rolling back or resetting data', async () => {
  let clock = 0; const mutations: string[] = [];
  await expect(deployRender(options, { now: () => clock, wait: async ms => { clock += ms; }, log: () => {}, fetch: async (input, init) => {
    if (init?.method === 'POST') { mutations.push(String(input)); return json({ id: 'dep-test' }); }
    if (String(input).endsWith('/readyz')) return json({ ok: false }, 503);
    if (String(input).endsWith('/dep-test')) return json({ status: 'live', commit: { id: commit } });
    return json({ type: 'web_service', autoDeploy: 'no' });
  } })).rejects.toThrow('no automatic rollback or database reset');
  expect(mutations).toEqual(['https://api.render.com/v1/services/srv-test/deploys']);
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
