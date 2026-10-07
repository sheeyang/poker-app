import type { ObservableTableSession, ParticipantBinding } from '@poker/contracts';
import { CashGame } from '@poker/engine';
import type { PersistedTableSession } from './aggregate.js';
export function projectBindings(bindings: readonly ParticipantBinding[]): ParticipantBinding[] {
  return bindings.map(b => ({
    participantId: b.participantId, name: b.name,
    controller: b.controller.kind === 'human' ? { kind: 'human' } : {
      kind: 'bot', playingStrategy: {
        policy: { id: b.controller.playingStrategy.policy.id, version: b.controller.playingStrategy.policy.version, configuration: structuredClone(b.controller.playingStrategy.policy.configuration) },
        selector: { id: b.controller.playingStrategy.selector.id, version: b.controller.playingStrategy.selector.version, configuration: structuredClone(b.controller.playingStrategy.selector.configuration) },
      },
    },
  }));
}
export function projectTableSession(aggregate: PersistedTableSession, participantId: string): ObservableTableSession {
  const restored = CashGame.fromRecord(aggregate.pokerRecord);
  if (!restored.ok) throw new Error('Committed CashGame record could not be restored.');
  const view = restored.game.forParticipant(participantId).getView();
  const c = view.configuration;
  return {
    tableSessionId: aggregate.tableSessionId, pokerRevision: aggregate.pokerRevision, sessionRevision: aggregate.sessionRevision,
    bindings: projectBindings(aggregate.bindings),
    view: {
      configuration: { seatCount: c.seatCount, smallBlind: c.smallBlind, bigBlind: c.bigBlind, ante: c.ante, minimumBuyIn: c.minimumBuyIn, defaultBuyIn: c.defaultBuyIn, maximumBuyIn: c.maximumBuyIn, allowSeatChanges: c.allowSeatChanges },
      state: {
        status: view.state.status, buttonSeat: view.state.buttonSeat,
        participants: view.state.participants.map(p => ({ participantId: p.participantId, seat: p.seat, stack: p.stack, sittingOut: p.sittingOut })),
        board: [...view.state.board],
        pots: view.state.pots.map(p => ({ amount: p.amount, eligibleParticipantIds: [...p.eligibleParticipantIds] })),
        actorId: view.state.actorId,
        legalActions: view.state.legalActions.map(a => a.type === 'bet' || a.type === 'raise' ? { type: a.type, minimum: a.minimum, maximum: a.maximum } : { type: a.type }),
      },
      history: view.history.map(h => ({ handId: h.handId, description: h.description })),
    },
  };
}
