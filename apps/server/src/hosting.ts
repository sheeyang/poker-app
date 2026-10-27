import { access } from 'node:fs/promises';
import { extname, join } from 'node:path';
import staticFiles from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { ServerAuthority } from './authority.js';
import { createServer, type ServerOptions } from './server.js';

export interface HostedServerOptions extends Omit<ServerOptions, 'beforeInitialize'> {
  readonly host: string;
  readonly port: number;
  readonly revision: string;
  readonly webRoot?: string;
  readonly singleAuthority?: boolean;
}

/** Liveness permits Render's rolling handoff; readiness permits application use. */
export function startHostedServer(options: HostedServerOptions) {
  let phase = 'starting';
  let app: FastifyInstance | undefined;
  let closing: Promise<void> | undefined;
  const stop = new AbortController();
  const listening = Promise.withResolvers<string>();
  const failure = Promise.withResolvers<never>();
  const authority = options.singleAuthority ? new ServerAuthority(options.databaseUrl, options.schema ?? 'public', error => {
    phase = 'failed';
    failure.reject(error);
    void close().catch(() => {});
  }) : undefined;

  function close(): Promise<void> {
    if (closing) return closing;
    phase = 'stopping';
    stop.abort();
    closing = (async () => {
      // Do not hand authority to a replacement until queues and jobs have stopped.
      try { await app?.close(); } finally { await authority?.close(); }
    })();
    return closing;
  }

  const ready = createServer({ ...options, beforeInitialize: async instance => {
    app = instance;
    stop.signal.throwIfAborted();
    app.addHook('onRequest', async (request, reply) => {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/healthz' || pathname === '/readyz') return;
      if (phase !== 'ready') return reply.code(503).header('retry-after', '2').header('cache-control', 'no-store')
        .send({ ok: false, rejection: { code: 'server-starting', message: 'The server is restarting. Reconnect shortly.' } });
    });
    app.get('/healthz', async () => ({ ok: true }));
    app.get('/readyz', async (_request, reply) => reply.code(phase === 'ready' ? 200 : 503).header('cache-control', 'no-store')
      .send({ ok: phase === 'ready', revision: options.revision, status: phase }));
    if (options.webRoot) {
      await access(join(options.webRoot, 'index.html'));
      await app.register(staticFiles, { root: options.webRoot, wildcard: false, maxAge: 0 });
      app.setNotFoundHandler((request, reply) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        if (['GET', 'HEAD'].includes(request.method) && pathname !== '/api' && !pathname.startsWith('/api/')
          && pathname !== '/assets' && !pathname.startsWith('/assets/') && extname(pathname) === '') {
          return reply.header('cache-control', 'no-store').sendFile('index.html');
        }
        return reply.code(404).send({ error: 'Not found' });
      });
    }
    const address = await app.listen({ host: options.host, port: options.port });
    phase = 'waiting-for-authority';
    listening.resolve(address);
    await authority?.acquire(stop.signal);
    stop.signal.throwIfAborted();
    phase = 'initializing';
  } }).then(() => {
    stop.signal.throwIfAborted();
    phase = 'ready';
  }).catch(async error => {
    listening.reject(error);
    if (!stop.signal.aborted) failure.reject(error);
    await close();
    throw error;
  });
  // Callers may attach after the listener binds, including during shutdown.
  void listening.promise.catch(() => {});
  void failure.promise.catch(() => {});
  void ready.catch(() => {});
  return { listening: listening.promise, ready, failure: failure.promise, close };
}
