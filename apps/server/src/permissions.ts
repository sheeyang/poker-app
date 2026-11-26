import type { MutationOutcome, PokerMutationRequest, Refill, StartHandRequest } from '@poker/contracts';
import { findBinding, isBot, isPlayer, type PersistedPlayerBinding, type PersistedTableSession } from './aggregate.js';
import { ownerRequired, reject, unavailableOnline } from './rejections.js';

/** The poker mutations a table accepts: each is one accepted transition of its CashGame (`mutations.ts` `accept`). */
export type PokerMutationKind = 'seat-participant' | 'start-hand' | 'act' | 'stand-up-participant' | 'move-participant' | 'set-sitting-out' | 'top-up-to' | 'set-button' | 'leave-table' | 'remove-participant' | 'add-bot' | 'remove-bot';

const notYours = () => reject('not-your-participant', 'Only its own Human Controller can act for or manage this Participant.');

/**
 * Who may ask for what, decided before request idempotency, so a remembered outcome is only ever replayed to
 * a requester who may make that request. Each player manages only their own Participant; Table Ownership manages
 * the table's Bots and options and removes players, and never names another player's Participant otherwise. Unknown
 * Participants and acting as a Bot stay definitive rejections, judged with the request.
 */
export function playerMutationDenial(aggregate: PersistedTableSession, requester: PersistedPlayerBinding, kind: PokerMutationKind, request: PokerMutationRequest): MutationOutcome | undefined {
  const owner = aggregate.ownerUserId === requester.userId;
  const target = findBinding(aggregate, (request as { participantId?: unknown }).participantId);
  if (kind === 'remove-participant') {
    // The one request that names another player's Participant: the owner's Removal of a player.
    if (!owner) return ownerRequired();
    if (isBot(target)) return reject('participant-not-player', 'Only a player can be removed. Bots are managed by the Table Owner.');
    if (isPlayer(target) && target.userId === aggregate.ownerUserId) return reject('cannot-remove-owner', 'The Table Owner cannot be removed from their own table.');
    return undefined;
  }
  if (kind === 'remove-bot') {
    // The owner's Bots only: a player, however named, is never theirs to remove.
    if (!owner) return ownerRequired();
    if (isPlayer(target)) return target.participantId === requester.participantId ? reject('participant-not-bot', 'Choose a Bot. To leave the table, use Leave table.') : notYours();
    return undefined;
  }
  // Automatic Dealing deals each Hand at an Online Table and moves the button.
  if (kind === 'start-hand' && owner && aggregate.mode === 'online') return unavailableOnline('Hands at an Online Table are dealt automatically.');
  if (kind === 'set-button' && owner && aggregate.mode === 'online') return unavailableOnline('At an Online Table the dealer button moves with Automatic Dealing.');
  if (kind === 'start-hand' || kind === 'set-button' || kind === 'add-bot') {
    if (!owner) return ownerRequired();
    // Rebuy & deal refills only the owner's own Participant and their Bots.
    const refills: unknown = kind === 'start-hand' ? (request as StartHandRequest).refills : undefined;
    const refilled = refillList(refills) ? refills.map(refill => findBinding(aggregate, refill.participantId)) : [];
    return refilled.some(binding => isPlayer(binding) && binding.participantId !== requester.participantId) ? notYours() : undefined;
  }
  if (isPlayer(target) && target.participantId !== requester.participantId) return notYours();
  // A Practice Table is never left: its player keeps it in their practice history.
  if (kind === 'leave-table' && aggregate.mode !== 'online') return reject('unavailable-at-practice-tables', 'A Practice Table is never left. Stand Up or sit out instead.');
  if (isBot(target) && kind === 'leave-table') return reject('participant-not-player', 'Only a player can leave the table. Bots are managed by the Table Owner.');
  if (isBot(target) && kind !== 'act' && !owner) return ownerRequired();
}

const commandFields: Readonly<Record<PokerMutationKind, readonly string[]>> = {
  'seat-participant': ['participantId', 'seat', 'buyIn'], 'start-hand': ['refills'], act: ['participantId', 'action'],
  'stand-up-participant': ['participantId'], 'move-participant': ['participantId', 'seat'], 'set-sitting-out': ['participantId', 'sittingOut'], 'top-up-to': ['participantId', 'targetStack'], 'set-button': ['seat'], 'leave-table': ['participantId'], 'remove-participant': ['participantId'],
  'add-bot': ['name', 'playingStrategy', 'seat', 'buyIn'], 'remove-bot': ['participantId'],
};
/** Whether `refills` is a list of Refills, each with only a `participantId` and a `targetStack`. */
const refillList = (refills: unknown): refills is readonly Refill[] => Array.isArray(refills) && refills.every(refill => typeof refill === 'object' && refill !== null && Object.keys(refill).every(key => key === 'participantId' || key === 'targetStack') && typeof refill.participantId === 'string');
/** A request with fields its kind does not take, or without a nonnegative integer `expectedPokerRevision`. */
export function malformedPokerRequest(kind: PokerMutationKind, request: PokerMutationRequest): MutationOutcome | undefined {
  const fields = ['requestId', 'expectedPokerRevision', ...commandFields[kind]];
  if (Object.keys(request).some(key => !fields.includes(key)) || !Number.isSafeInteger(request.expectedPokerRevision) || request.expectedPokerRevision < 0
    || (kind === 'start-hand' && 'refills' in request && !refillList(request.refills)))
    return reject('invalid-mutation-request', 'Supply supported mutation fields and a nonnegative expectedPokerRevision.');
}
