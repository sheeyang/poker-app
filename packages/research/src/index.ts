import { CashGame, type TableSessionRecord } from '@poker/engine';
import type { CompletedHandInspectionOutcome } from '@poker/contracts';

/** These are the entire permitted durable inputs; never a live CashGame or aggregate. */
export interface CompletedHandInspectionInput {
  readonly tableSessionId: string;
  readonly handId: string;
  readonly pokerRecord: TableSessionRecord;
}
export async function loadCompletedHandInspection(tableSessionId: string, handId: string, readPermittedRecord: (id: string) => Promise<TableSessionRecord | undefined>): Promise<CompletedHandInspectionInput | undefined> {
  const pokerRecord = await readPermittedRecord(tableSessionId);
  return pokerRecord && { tableSessionId, handId, pokerRecord };
}
/** Bounded M1 reconstruction runs only within the authoritative deployment's JobRunner. */
export function inspectCompletedHand(input: CompletedHandInspectionInput): CompletedHandInspectionOutcome {
  const restored = CashGame.fromRecord(input.pokerRecord);
  if (!restored.ok) return { ok: false, rejection: { code: 'record-restoration-failed', message: 'The complete committed Table Session could not be restored.' } };
  const facts = restored.game.getHand(input.handId);
  if (!facts) return { ok: false, rejection: { code: 'hand-not-found', message: 'Choose a completed Hand from this Table Session.' } };
  if (!facts.completed) return { ok: false, rejection: { code: 'active-hand', message: 'Complete this Hand before revealing its hidden information.' } };
  // Deliberate field mapping confines disclosure to the requested completed Hand.
  return { ok: true, tableSessionId: input.tableSessionId, hand: {
    handId: facts.handId, sequence: facts.sequence, buttonSeat: facts.buttonSeat,
    smallBlindParticipantId: facts.smallBlindParticipantId, bigBlindParticipantId: facts.bigBlindParticipantId,
    participants: facts.participants.map(p => ({ participantId: p.participantId, seat: p.seat, holeCards: [...p.holeCards], contribution: p.contribution, anteContribution: p.anteContribution, folded: p.folded, allIn: p.allIn })),
    deck: [...facts.deck], drawnCardCount: facts.drawnCardCount, burns: [...facts.burns], board: [...facts.board],
    pots: facts.pots.map(p => ({ amount: p.amount, eligibleParticipantIds: [...p.eligibleParticipantIds] })),
    returns: facts.returns.map(p => ({ participantId: p.participantId, amount: p.amount })),
    payouts: facts.payouts.map(p => ({ participantId: p.participantId, amount: p.amount })),
  } };
}
