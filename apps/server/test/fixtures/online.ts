import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { expect, onTestFinished } from 'vitest';
import type { ServerLiveMessage } from '@poker/contracts';

/**
 * One live connection (one device or tab) of a Guest, subscribed to a table through `/api/live`. At an Online
 * Table a human counts as connected while at least one such connection of their Guest is subscribed, and
 * Automatic Dealing deals only to connected humans. The connection ends with the test, if not before.
 */
export async function connectLive(base: string, cookie: string, tableSessionId: string) {
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/live', { headers: { cookie } });
  const close = async () => {
    if (socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise(resolve => socket.once('close', resolve));
    socket.terminate();
    await closed;
  };
  onTestFinished(close);
  const messages: ServerLiveMessage[] = [];
  socket.on('message', data => messages.push(JSON.parse(data.toString())));
  socket.on('error', () => {});
  await expect.poll(() => messages[0]).toEqual({ type: 'user-channel-ready' });
  const requestId = randomUUID();
  socket.send(JSON.stringify({ type: 'subscribe-table', requestId, tableSessionId }));
  await expect.poll(() => messages.find(message => message.type === 'table-subscription-result' && message.requestId === requestId)).toMatchObject({ status: 'subscribed' });
  /** `close` ends this connection, as closing a tab or losing the network does. */
  return { socket, messages, close };
}
export type LiveConnection = Awaited<ReturnType<typeof connectLive>>;
