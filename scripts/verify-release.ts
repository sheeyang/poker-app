import { createHash, randomBytes } from 'node:crypto';
import { request } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

interface VerificationOptions { readonly appUrl: string; readonly commit: string; readonly timeoutMs?: number }
interface Dependencies {
  readonly fetch?: typeof fetch;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
  readonly smoke?: (origin: string) => Promise<void>;
}

export async function verifyHostedApp(origin: string, get: typeof fetch = fetch, upgrade = verifyWebSocket) {
  const page = await get(origin, { signal: AbortSignal.timeout(20000) });
  if (!page.ok || !page.headers.get('content-type')?.includes('text/html')) throw new Error('The deployed Trainer did not return HTML.');
  const html = await page.text();
  const script = html.match(/<script\b[^>]*\bsrc="([^"]+)"/i)?.[1];
  const asset = script && new URL(script, origin);
  if (!asset || asset.origin !== origin || !asset.pathname.startsWith('/assets/')) throw new Error('The Trainer has no same-origin built script.');
  const javascript = await get(asset, { signal: AbortSignal.timeout(20000) });
  if (!javascript.ok || !/javascript/.test(javascript.headers.get('content-type') ?? '')) throw new Error('The Trainer script could not be loaded.');
  const identity = await get(origin + '/api/identity', { signal: AbortSignal.timeout(20000) });
  const cookie = identity.headers.get('set-cookie');
  if (!identity.ok || !cookie?.includes('poker_local=') || !/;\s*secure(?:;|$)/i.test(cookie)
    || !/;\s*httponly(?:;|$)/i.test(cookie) || !/;\s*samesite=strict(?:;|$)/i.test(cookie)) throw new Error('Hosted identity did not return the expected secure cookie.');
  await upgrade(origin, cookie.split(';')[0]!);
}

function verifyWebSocket(origin: string, cookie: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const expected = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const req = request(new URL('/api/live', origin), { headers: {
      cookie, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': key,
    } });
    req.setTimeout(20000, () => req.destroy(new Error('WebSocket upgrade timed out.')));
    req.once('upgrade', (response, socket) => {
      socket.destroy();
      if (response.statusCode !== 101 || response.headers['sec-websocket-accept'] !== expected) reject(new Error('Invalid WebSocket upgrade.'));
      else resolve();
    });
    req.once('response', response => { response.resume(); reject(new Error('Hosted WebSocket did not upgrade.')); });
    req.once('error', () => reject(new Error('Hosted WebSocket connection failed.')));
    req.end();
  });
}

/** A started container is not a release: wait for restored authority at the requested revision. */
export async function verifyRelease(options: VerificationOptions, dependencies: Dependencies = {}) {
  if (!/^[0-9a-f]{40}$/.test(options.commit)) throw new Error('DEPLOY_COMMIT must be a full tested Git commit SHA.');
  const app = URL.parse(options.appUrl);
  if (!app || app.protocol !== 'https:' || app.username || app.password || app.pathname !== '/' || app.search || app.hash) throw new Error('APP_URL must be the HTTPS application origin without a path.');
  const origin = app.origin;
  const get = dependencies.fetch ?? fetch;
  const wait = dependencies.wait ?? (milliseconds => delay(milliseconds));
  const now = dependencies.now ?? Date.now;
  const log = dependencies.log ?? console.log;
  const deadline = now() + (options.timeoutMs ?? 10 * 60 * 1000);
  log('Waiting for restored application authority at ' + options.commit + '.');
  while (now() < deadline) {
    let verified = false;
    try {
      const response = await get(origin + '/readyz', { signal: AbortSignal.timeout(20000), cache: 'no-store' });
      if (response.ok) {
        const ready = await response.json();
        if (ready.ok === true && ready.status === 'ready' && ready.revision === options.commit) {
          verified = true;
        }
      }
    } catch { /* The old process draining and the new one restoring are expected during handoff. */ }
    if (verified) {
      await (dependencies.smoke ?? verifyHostedApp)(origin);
      log('Trainer, secure identity, WebSocket, and revision verified.');
      return { revision: options.commit };
    }
    await wait(5000);
  }
  throw new Error('Timed out waiting for the requested application revision. Inspect the VM logs; no automatic rollback or database reset was attempted.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyRelease({ appUrl: process.env.APP_URL ?? '', commit: process.env.DEPLOY_COMMIT ?? '' }).catch(error => {
    console.error(error instanceof Error ? error.message : 'Release verification failed.');
    process.exitCode = 1;
  });
}
