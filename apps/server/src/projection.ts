import type { ConcreteAction, ObservableCashGameState, ObservablePresentationEvent, ObservableTableSession, ObservableTableUpdate, ParticipantBinding } from '@poker/contracts';
import { CashGame, type CashGameEvent } from '@poker/engine';
import type { PersistedTableSession } from './aggregate.js';
function projectAction(action: ConcreteAction): ConcreteAction {
  return action.type === 'bet' ? { type: 'bet', betTo: action.betTo } : action.type === 'raise' ? { type: 'raise', raiseTo: action.raiseTo } : { type: action.type };
}
function projectState(state: ObservableCashGameState): ObservableCashGameState {
  return {
    status: state.status, buttonSeat: state.buttonSeat,
    participants: state.participants.map(p => ({ participantId: p.participantId, seat: p.seat, stack: p.stack, sittingOut: p.sittingOut,
      ...(p.inHand ? { inHand: p.inHand, handSeat: p.handSeat, folded: p.folded, allIn: p.allIn, contribution: p.contribution, anteContribution: p.anteContribution, wager: p.wager, cardCount: p.cardCount, ...(p.holeCards ? { holeCards: [...p.holeCards] } : {}) } : {}) })),
    board: [...state.board], pots: state.pots.map(p => ({ amount: p.amount, eligibleParticipantIds: [...p.eligibleParticipantIds] })), actorId: state.actorId,
    legalActions: state.legalActions.map(a => a.type === 'bet' || a.type === 'raise' ? { type: a.type, minimum: a.minimum, maximum: a.maximum } : { type: a.type }),
    ...(state.amountToCall !== undefined ? { amountToCall: state.amountToCall } : {}),
    ...(state.handId ? { handId: state.handId, decisionId: state.decisionId, street: state.street, smallBlindParticipantId: state.smallBlindParticipantId, bigBlindParticipantId: state.bigBlindParticipantId,
      returns: state.returns?.map(p => ({ participantId: p.participantId, amount: p.amount })), payouts: state.payouts?.map(p => ({ participantId: p.participantId, amount: p.amount })) } : {}),
  };
}
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
export function projectTableSession(aggregate: PersistedTableSession, participantId: string, game?: CashGame, adminMode = true): ObservableTableSession {
  if (!game) {
    const restored = CashGame.fromRecord(aggregate.pokerRecord);
    if (!restored.ok) throw new Error('Committed CashGame record could not be restored.');
    game = restored.game;
  }
  const view = game.forParticipant(participantId).getView();
  const c = view.configuration;
  return {
    tableSessionId: aggregate.tableSessionId, pokerRevision: aggregate.pokerRevision, sessionRevision: aggregate.sessionRevision,
    bindings: projectBindings(aggregate.bindings),
    trainerConfiguration: structuredClone(aggregate.trainerConfiguration),
    inspection: { adminMode, completedHands: adminMode ? game.getCompletedHands() : [] },
    view: {
      configuration: { seatCount: c.seatCount, smallBlind: c.smallBlind, bigBlind: c.bigBlind, ante: c.ante, minimumBuyIn: c.minimumBuyIn, defaultBuyIn: c.defaultBuyIn, maximumBuyIn: c.maximumBuyIn, allowSeatChanges: c.allowSeatChanges },
      state: projectState(view.state),
      history: view.history.map(h => ({ handId: h.handId, description: h.description,
        decisions: h.decisions.map(d => ({ decisionId: d.decisionId, state: projectState(d.state), action: { participantId: d.action.participantId, action: projectAction(d.action.action) } })),
        ...(h.result ? { result: projectState(h.result) } : {}),
      })),
    },
  };
}
export function projectTableUpdate(aggregate: PersistedTableSession, participantId: string, game: CashGame, events: readonly CashGameEvent[] = [], adminMode = true): ObservableTableUpdate {
  const presentationEvents = game.forParticipant(participantId).projectEvents(events).map((event): ObservablePresentationEvent => {
    switch (event.type) {
      case 'participant-seated': return { type: event.type, participantId: event.participantId, seat: event.seat, buyIn: event.buyIn };
      case 'participant-left': return { type: event.type, participantId: event.participantId, seat: event.seat, cashOut: event.cashOut };
      case 'participant-moved': return { type: event.type, participantId: event.participantId, fromSeat: event.fromSeat, seat: event.seat };
      case 'sitting-out-changed': return { type: event.type, participantId: event.participantId, sittingOut: event.sittingOut };
      case 'participant-topped-up': return { type: event.type, participantId: event.participantId, targetStack: event.targetStack, amount: event.amount };
      case 'button-set': return { type: event.type, seat: event.seat };
      case 'hand-started': return { type: event.type, handId: event.handId, buttonSeat: event.buttonSeat, smallBlindParticipantId: event.smallBlindParticipantId, bigBlindParticipantId: event.bigBlindParticipantId };
      case 'forced-contribution': return { type: event.type, participantId: event.participantId, kind: event.kind, amount: event.amount };
      case 'hole-cards-dealt': return { type: event.type, participantId: event.participantId, cardCount: event.cardCount, ...(event.cards ? { cards: [...event.cards] } : {}) };
      case 'acted': return { type: event.type, participantId: event.participantId, action: event.action.type === 'bet' ? { type: 'bet', betTo: event.action.betTo } : event.action.type === 'raise' ? { type: 'raise', raiseTo: event.action.raiseTo } : { type: event.action.type } };
      case 'card-burned': return { type: event.type, street: event.street };
      case 'board-dealt': return { type: event.type, street: event.street, cards: [...event.cards] };
      case 'hole-cards-revealed': return { type: event.type, participantId: event.participantId, cards: [...event.cards] };
      case 'uncalled-return': case 'pot-awarded': return { type: event.type, participantId: event.participantId, amount: event.amount };
      case 'hand-completed': return { type: event.type, handId: event.handId };
    }
  });
  return { type: 'table-update', ...projectTableSession(aggregate, participantId, game, adminMode), presentationEvents };
}
