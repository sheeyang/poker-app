import { createHash, randomBytes } from 'node:crypto';
import { request } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

interface DeploymentOptions { readonly apiKey: string; readonly serviceId: string; readonly appUrl: string; readonly commit: string; readonly timeoutMs?: number }
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

export async function deployRender(options: DeploymentOptions, dependencies: Dependencies = {}) {
  if (!options.apiKey) throw new Error('Set RENDER_API_KEY.');
  if (!/^srv-[a-z0-9]+$/.test(options.serviceId)) throw new Error('Set RENDER_SERVICE_ID to the Render web service ID.');
  if (!/^[0-9a-f]{40}$/.test(options.commit)) throw new Error('DEPLOY_COMMIT must be a full tested Git commit SHA.');
  const app = new URL(options.appUrl);
  if (app.protocol !== 'https:' || app.username || app.password || app.pathname !== '/' || app.search || app.hash) throw new Error('APP_URL must be the HTTPS application origin without a path.');
  const origin = app.origin;
  const get = dependencies.fetch ?? fetch;
  const wait = dependencies.wait ?? (milliseconds => delay(milliseconds));
  const now = dependencies.now ?? Date.now;
  const log = dependencies.log ?? console.log;
  const deadline = now() + (options.timeoutMs ?? 20 * 60 * 1000);
  const base = 'https://api.render.com/v1/services/' + options.serviceId;
  const headers = { authorization: 'Bearer ' + options.apiKey, 'content-type': 'application/json' };
  async function read(url: string) {
    const response = await get(url, { headers, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('Render API returned HTTP ' + response.status + '.');
    return await response.json();
  }
  const service = await read(base);
  if (service.type !== 'web_service' || !(service.autoDeployTrigger === 'off' || service.autoDeploy === 'no')) {
    throw new Error('Use a Render Web Service with automatic deploys disabled.');
  }
  let deployment: { id?: string; status?: string; commit?: { id?: string } };
  try {
    const response = await get(base + '/deploys', { method: 'POST', headers,
      body: JSON.stringify({ commitId: options.commit }), signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('Render API returned HTTP ' + response.status + '.');
    deployment = await response.json();
    if (!deployment.id || !/^dep-[a-z0-9]+$/.test(deployment.id)) throw new Error('Render did not return a deploy ID.');
  } catch {
    // Never retry an ambiguous mutation: another deployment may already exist.
    throw new Error('Render did not confirm deploy creation. Inspect Render Deploys before starting another release.');
  }
  const deployId = deployment.id!;
  log('Created Render deployment ' + deployId + ' for ' + options.commit + '.');
  let lastStatus = '';
  while (now() < deadline) {
    try { deployment = await read(base + '/deploys/' + deployId); }
    catch {
      // A read is safe to repeat; the earlier creation POST is not.
      log('Render status temporarily unavailable; checking again.');
      await wait(5000);
      continue;
    }
    if (deployment.status !== lastStatus) { lastStatus = deployment.status ?? 'unknown'; log('Render: ' + lastStatus); }
    if (['build_failed', 'pre_deploy_failed', 'update_failed', 'canceled', 'deactivated'].includes(lastStatus)) throw new Error('Render deployment ended with ' + lastStatus + '.');
    if (lastStatus === 'live') {
      if (deployment.commit?.id !== options.commit) throw new Error('Render deployed a different commit.');
      break;
    }
    await wait(5000);
  }
  if (lastStatus !== 'live') throw new Error('Timed out waiting for the Render deployment.');
  log('Listener live; waiting for restored application authority.');
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
    } catch { /* Cold starts and the old process draining are expected during handoff. */ }
    if (verified) {
      await (dependencies.smoke ?? verifyHostedApp)(origin);
      log('Trainer, secure identity, WebSocket, and revision verified.');
      return { deployId, revision: options.commit };
    }
    await wait(5000);
  }
  throw new Error('Timed out waiting for the requested application revision. Inspect Render logs; no automatic rollback or database reset was attempted.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  deployRender({ apiKey: process.env.RENDER_API_KEY ?? '', serviceId: process.env.RENDER_SERVICE_ID ?? '',
    appUrl: process.env.APP_URL ?? '', commit: process.env.DEPLOY_COMMIT ?? '' }).catch(error => {
    console.error(error instanceof Error ? error.message : 'Deployment failed.');
    process.exitCode = 1;
  });
}
