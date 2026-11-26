import type { OverallHistoryUpdate, ProgressResource } from '@poker/contracts';
import type { ProgressChannel } from './progress.js';
import { progressOf, type Entry, type UserOwner, type Owner } from './shared-analyses.js';

/** Where a User's Overall History requests are told of: their notices, and their pending counts. */
export interface UserDelivery {
  /** Sends a notice on the User's user channel, to every connection of theirs and nobody else's. */
  readonly publish: (userId: string, update: OverallHistoryUpdate) => void;
  readonly progress: ProgressChannel;
}

/** What one request's owner and follow need: who hears of it, what it is, and how its results and notices go. */
export interface PendingRequestSetup {
  /** The User who asked: their progress channel carries the request's count, and they alone hear of it. */
  readonly userId: string;
  readonly requestId: string;
  readonly resource: ProgressResource;
  readonly progress: ProgressChannel;
  /** Applies a change only while the request's results may still be accepted; whether it was applied. */
  readonly accept: Owner['accept'];
  /** Sends the notice of an entry left pending: its completion or failure. */
  readonly publish: (entry: Entry) => void;
  /** The User whose `history-analysis` bound the request's jobs run under; absent for a table's own summary. */
  readonly runAs?: string;
  /** The entry whose count is the request's, when it has several entries; absent when every entry of it is counted. */
  readonly counted?: () => Entry | undefined;
}

/**
 * The one shape every request kind shares (ADR-0026, ADR-0041): an owner that accepts its results, publishes each
 * entry's completion or failure, and moves the request's count on the User's progress channel while it is pending;
 * and `follow`, which starts that count when the request is pending and has nothing to follow once it is decided.
 */
export function pendingRequest(setup: PendingRequestSetup & { readonly runAs: string }): { readonly owner: UserOwner; follow(entry: Entry): void };
export function pendingRequest(setup: PendingRequestSetup): { readonly owner: Owner; follow(entry: Entry): void };
export function pendingRequest({ userId, requestId, resource, progress, accept, publish, runAs, counted }: PendingRequestSetup) {
  const countsFor = (entry: Entry) => !counted || entry === counted();
  const owner: Owner = {
    ...(runAs ? { userId: runAs } : {}),
    accept,
    notify: entry => {
      if (countsFor(entry)) progress.settled(userId, requestId);
      publish(entry);
    },
    progress: entry => { if (entry.outcome.status === 'pending' && countsFor(entry)) progress.changed(userId, requestId); },
  };
  return {
    owner,
    /** Follows the request's count while its `entry` is pending. */
    follow(entry: Entry) {
      if (entry.outcome.status !== 'pending') return;
      progress.follow(userId, { resource, requestId, count: () => progressOf(entry) });
    },
  };
}
