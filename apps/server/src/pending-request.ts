import type { OverallHistoryUpdate, ProgressResource } from '@poker/contracts';
import type { ProgressChannel } from './progress.js';
import { progressOf, type Entry, type GuestOwner, type Owner } from './shared-analyses.js';

/** Where a Guest's Overall History requests are told of: their notices, and their pending counts. */
export interface GuestDelivery {
  /** Sends a notice on the Guest's user channel, to every connection of theirs and nobody else's. */
  readonly publish: (guestId: string, update: OverallHistoryUpdate) => void;
  readonly progress: ProgressChannel;
}

/** What one request's owner and follow need: who hears of it, what it is, and how its results and notices go. */
export interface PendingRequestSetup {
  /** The Guest who asked: their progress channel carries the request's count, and they alone hear of it. */
  readonly guestId: string;
  readonly requestId: string;
  readonly resource: ProgressResource;
  readonly progress: ProgressChannel;
  /** Applies a change only while the request's results may still be accepted; whether it was applied. */
  readonly accept: Owner['accept'];
  /** Sends the notice of an entry left pending: its completion or failure. */
  readonly publish: (entry: Entry) => void;
  /** The Guest whose `history-analysis` bound the request's jobs run under; absent for a table's own summary. */
  readonly runAs?: string;
  /** The entry whose count is the request's, when it has several entries; absent when every entry of it is counted. */
  readonly counted?: () => Entry | undefined;
}

/**
 * The one shape every request kind shares (ADR-0026, ADR-0041): an owner that accepts its results, publishes each
 * entry's completion or failure, and moves the request's count on the Guest's progress channel while it is pending;
 * and `follow`, which starts that count when the request is pending and has nothing to follow once it is decided.
 */
export function pendingRequest(setup: PendingRequestSetup & { readonly runAs: string }): { readonly owner: GuestOwner; follow(entry: Entry): void };
export function pendingRequest(setup: PendingRequestSetup): { readonly owner: Owner; follow(entry: Entry): void };
export function pendingRequest({ guestId, requestId, resource, progress, accept, publish, runAs, counted }: PendingRequestSetup) {
  const countsFor = (entry: Entry) => !counted || entry === counted();
  const owner: Owner = {
    ...(runAs ? { guestId: runAs } : {}),
    accept,
    notify: entry => {
      if (countsFor(entry)) progress.settled(guestId, requestId);
      publish(entry);
    },
    progress: entry => { if (entry.outcome.status === 'pending' && countsFor(entry)) progress.changed(guestId, requestId); },
  };
  return {
    owner,
    /** Follows the request's count while its `entry` is pending. */
    follow(entry: Entry) {
      if (entry.outcome.status !== 'pending') return;
      progress.follow(guestId, { resource, requestId, count: () => progressOf(entry) });
    },
  };
}
