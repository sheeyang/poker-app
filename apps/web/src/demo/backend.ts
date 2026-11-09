import type { DecisionAnalysis, ObservableTableSession, ScoreSummary } from '@poker/contracts';
import { replayAt } from './time.js';

/** How the Demo Table's fake server behaves. `normal` serves the recorded view and a live connection that is always ready. */
export type DemoBehavior = 'normal' | 'loading' | 'error' | 'offline' | 'connecting';

export interface DemoScenario {
  readonly id: string;
  readonly session: ObservableTableSession;
  readonly analyses: Readonly<Record<string, DecisionAnalysis>>;
  readonly handSummaries: Readonly<Record<string, ScoreSummary>>;
  readonly sessionSummary?: ScoreSummary;
  readonly savedTables: readonly unknown[];
  /** The Tables screen, with no table open. */
  readonly home?: boolean;
  readonly behavior?: DemoBehavior;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const rejection = (code: string, message: string, status = 400) => json({ ok: false, rejection: { code, message } }, status);

/**
 * Stands in for the poker server while a Demo Table is on screen: `/api` requests and the `/api/live` socket are
 * answered from the recorded scenario, and nothing reaches the real server. Returns the function that restores both.
 */
export function installDemoBackend(scenario: DemoScenario): () => void {
  const realFetch = window.fetch, RealSocket = window.WebSocket;
  const behavior = scenario.behavior ?? 'normal';
  const session = replayAt(scenario.session, Date.now());
  const summaries = [...Object.values(scenario.handSummaries), ...(scenario.sessionSummary ? [scenario.sessionSummary] : [])];

  async function answer(method: string, path: string, body: Record<string, unknown>, signal?: AbortSignal | null): Promise<Response> {
    if (behavior === 'offline') throw new TypeError('Failed to fetch');
    if (method === 'GET' && path === '/identity') return json({ ok: true, displayName: 'You' });
    if (method === 'GET' && path === '/table-sessions') return json({ ok: true, tables: scenario.savedTables });
    const table = /^\/table-sessions\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (table && table[1] === session.tableSessionId) {
      const rest = table[2];
      if (method === 'GET' && rest === undefined) {
        if (behavior === 'loading') return new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
        if (behavior === 'error') return rejection('internal-error', 'The server could not load this table.', 500);
        return json(session);
      }
      if (method === 'POST' && rest === 'analysis') {
        const found = scenario.analyses[String(body.decisionId)];
        return found ? json(found) : rejection('not-found', 'This demo table has no recorded analysis for that decision.', 404);
      }
      if (method === 'GET' && rest?.startsWith('analysis/')) {
        const found = Object.values(scenario.analyses).find(a => a.requestId === decodeURIComponent(rest.slice(9)));
        return found ? json(found) : rejection('not-found', 'Analysis not found.', 404);
      }
      if (method === 'POST' && rest === 'hand-summaries') {
        const found = scenario.handSummaries[String(body.handId)];
        return found ? json(found) : rejection('not-found', 'This demo table has no recorded summary for that hand.', 404);
      }
      if (method === 'POST' && rest === 'session-summaries') {
        return scenario.sessionSummary ? json(scenario.sessionSummary) : rejection('not-found', 'This demo table has no recorded summary.', 404);
      }
      if (method === 'GET' && rest?.startsWith('summaries/')) {
        const found = summaries.find(s => s.requestId === decodeURIComponent(rest.slice(10)));
        return found ? json(found) : rejection('not-found', 'Summary not found.', 404);
      }
    }
    return rejection('demo-table', 'This is a demo table: it shows the screen as recorded, and actions are switched off.');
  }

  window.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
    let body: Record<string, unknown> = {};
    try { body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}; } catch { /* a request without a JSON body */ }
    return answer((init?.method ?? 'GET').toUpperCase(), url.pathname.slice(4), body, init?.signal);
  };

  class DemoSocket {
    static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSING = 2; static readonly CLOSED = 3;
    readyState = behavior === 'connecting' ? 0 : 1;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private timers = new Set<ReturnType<typeof setTimeout>>();
    constructor(url: string | URL) {
      if (new URL(String(url), location.href).pathname !== '/api/live') return new RealSocket(url) as unknown as DemoSocket;
      if (this.readyState === 1) this.emit({ type: 'user-channel-ready' }, 20);
    }
    private emit(message: unknown, delay = 0) {
      const timer = setTimeout(() => { this.timers.delete(timer); this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent); }, delay);
      this.timers.add(timer);
    }
    send(data: string) {
      const message = JSON.parse(data) as { type: string; requestId: string; tableSessionId: string };
      if (message.type !== 'subscribe-table' || message.tableSessionId !== session.tableSessionId) return;
      this.emit({ type: 'table-subscription-result', requestId: message.requestId, tableSessionId: message.tableSessionId, status: 'subscribed' }, 10);
      // A table that is meant to be loading or failing must not arrive over the live connection either.
      if (behavior === 'loading' || behavior === 'error') return;
      // The inspection capabilities ride on a live update; it carries the recorded revision, so the cached view stands.
      this.emit({ type: 'table-update', ...session, presentationEvents: [] }, 20);
    }
    close() { this.readyState = 3; this.timers.forEach(clearTimeout); this.timers.clear(); }
  }
  window.WebSocket = DemoSocket as unknown as typeof WebSocket;
  return () => { window.fetch = realFetch; window.WebSocket = RealSocket; };
}
