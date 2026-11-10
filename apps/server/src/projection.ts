import type { ConcreteAction, ObservableTableOptions, ObservableCashGameState, ObservableGameConfiguration, ObservablePresentationEvent, ObservableTableSession, ObservableTableUpdate, ParticipantBinding, StrategyDescriptor, TableOptions, TableSchedule } from '@poker/contracts';
import { CashGame, type CashGameEvent, type TableSessionRecord } from '@poker/engine';
import { findBinding, humanBindings, isHuman, type PersistedTableSession } from './aggregate.js';
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
/** A Strategy descriptor, field by field; each declared configuration is plain data and is copied whole. */
function projectStrategy(strategy: StrategyDescriptor): StrategyDescriptor {
  return {
    policy: { id: strategy.policy.id, version: strategy.policy.version, configuration: structuredClone(strategy.policy.configuration) },
    selector: { id: strategy.selector.id, version: strategy.selector.version, configuration: structuredClone(strategy.selector.configuration) },
  };
}
export function projectBindings(bindings: readonly ParticipantBinding[]): ParticipantBinding[] {
  return bindings.map(b => ({
    participantId: b.participantId, name: b.name,
    controller: b.controller.kind === 'human' ? { kind: 'human' } : { kind: 'bot', playingStrategy: projectStrategy(b.controller.playingStrategy) },
  }));
}
/** The Observable Game Configuration, field by field (ADR-0017). */
export function projectConfiguration(c: ObservableGameConfiguration): ObservableGameConfiguration {
  return { seatCount: c.seatCount, smallBlind: c.smallBlind, bigBlind: c.bigBlind, ante: c.ante, minimumBuyIn: c.minimumBuyIn, defaultBuyIn: c.defaultBuyIn, maximumBuyIn: c.maximumBuyIn, allowSeatChanges: c.allowSeatChanges };
}
/**
 * The Observable Game Configuration as it stands now, read from the record without replaying it: of its fields, only
 * the seat-change permission changes after creation, and only by its own command.
 */
export function recordedConfiguration(record: TableSessionRecord): ObservableGameConfiguration {
  const { seed: _seed, ...configuration } = record.configuration;
  const seatChanges = record.commands.findLast(command => command.type === 'set-seat-changes');
  return { ...configuration, ...(seatChanges?.type === 'set-seat-changes' ? { allowSeatChanges: seatChanges.allowSeatChanges } : {}) };
}
/** The table options, field by field (ADR-0017): a field added to the stored options is never projected by accident. */
export function projectOptions(options: TableOptions): TableOptions {
  return { actionTimeLimitSeconds: options.actionTimeLimitSeconds, allowLiveAnalysis: options.allowLiveAnalysis };
}
/** The options Participants see: whether the table has a Table Password, and never its hash. */
export function projectTableOptions(aggregate: PersistedTableSession): ObservableTableOptions {
  return { ...projectOptions(aggregate.options), ...(aggregate.tablePasswordHash ? { hasTablePassword: true as const } : {}) };
}
function projectSchedule(schedule: TableSchedule): TableSchedule {
  return {
    phases: schedule.phases.map(p => ({ kind: p.kind, handId: p.handId, street: p.street, startsAt: p.startsAt, endsAt: p.endsAt, durationMs: p.durationMs })),
    actionWindow: schedule.actionWindow && { participantId: schedule.actionWindow.participantId, decisionId: schedule.actionWindow.decisionId, opensAt: schedule.actionWindow.opensAt,
      ...(schedule.actionWindow.deadlineAt !== undefined ? { deadlineAt: schedule.actionWindow.deadlineAt } : {}),
      ...(schedule.actionWindow.liveAnalysisDisallowed ? { liveAnalysisDisallowed: true as const } : {}) },
    ...(schedule.nextHandCountdown ? { nextHandCountdown: { startsAt: schedule.nextHandCountdown.startsAt, endsAt: schedule.nextHandCountdown.endsAt, durationMs: schedule.nextHandCountdown.durationMs } } : {}),
  };
}
/**
 * Projects the table for one viewing human Participant, including only that Participant's own study settings.
 * `serverTime` is the injected clock's time at projection; `connected` lists the human Participants with a live
 * connection to the table at that time, which an Online Table's view shows.
 */
export function projectTableSession(aggregate: PersistedTableSession, participantId: string, game: CashGame | undefined, serverTime: number, adminMode = true, connected: readonly string[] = []): ObservableTableSession {
  const viewer = findBinding(aggregate, participantId);
  if (!isHuman(viewer)) throw new Error('Table views are projected only for a human Participant.');
  if (!game) {
    const restored = CashGame.fromRecord(aggregate.pokerRecord);
    if (!restored.ok) throw new Error('Committed CashGame record could not be restored.');
    game = restored.game;
  }
  const view = game.forParticipant(participantId).getView();
  // Admin Mode is never available at an Online Table, whatever the server allows.
  const inspectable = adminMode && aggregate.mode === 'practice';
  // Humans who left or were removed, and Bots the owner removed: public, so nobody is offered what no longer applies.
  const departed = aggregate.bindings.filter(binding => isHuman(binding) ? binding.membership !== 'joined' : binding.removed).map(binding => binding.participantId);
  return {
    tableSessionId: aggregate.tableSessionId, mode: aggregate.mode, options: projectTableOptions(aggregate), viewerParticipantId: participantId, ownerParticipantId: humanBindings(aggregate).find(binding => binding.userId === aggregate.ownerUserId)!.participantId,
    pokerRevision: aggregate.pokerRevision, sessionRevision: aggregate.sessionRevision,
    bindings: projectBindings(aggregate.bindings),
    trainerConfiguration: { referenceStrategy: projectStrategy(viewer.trainerConfiguration.referenceStrategy), liveAnalysis: viewer.trainerConfiguration.liveAnalysis },
    schedule: projectSchedule(aggregate.schedule), serverTime,
    pendingChanges: aggregate.pendingChanges.map(entry => ({ participantId: entry.participantId, change: entry.change })),
    ...(aggregate.mode === 'online' ? { connectedParticipantIds: [...connected] } : {}),
    ...(departed.length ? { departedParticipantIds: departed } : {}),
    inspection: { adminMode: inspectable, completedHands: inspectable ? game.getCompletedHands().map(hand => ({ handId: hand.handId, sequence: hand.sequence })) : [] },
    view: {
      configuration: projectConfiguration(view.configuration),
      state: projectState(view.state),
      history: view.history.map(h => ({ handId: h.handId, description: h.description,
        decisions: h.decisions.map(d => ({ decisionId: d.decisionId, state: projectState(d.state), action: { participantId: d.action.participantId, action: projectAction(d.action.action) } })),
        ...(h.result ? { result: projectState(h.result) } : {}),
      })),
    },
  };
}
export function projectTableUpdate(aggregate: PersistedTableSession, participantId: string, game: CashGame, serverTime: number, events: readonly CashGameEvent[] = [], adminMode = true, connected: readonly string[] = []): ObservableTableUpdate {
  // biome-ignore lint/suspicious/useIterableCallbackReturn: exhaustive switch over the event union; the compiler rejects a missing case.
  const presentationEvents = game.forParticipant(participantId).projectEvents(events).map((event): ObservablePresentationEvent => {
    switch (event.type) {
      case 'participant-joined': case 'participant-left': return { type: event.type, participantId: event.participantId };
      case 'participant-seated': return { type: event.type, participantId: event.participantId, seat: event.seat, buyIn: event.buyIn };
      case 'participant-stood-up': return { type: event.type, participantId: event.participantId, seat: event.seat, cashOut: event.cashOut };
      case 'participant-moved': return { type: event.type, participantId: event.participantId, fromSeat: event.fromSeat, seat: event.seat };
      case 'sitting-out-changed': return { type: event.type, participantId: event.participantId, sittingOut: event.sittingOut };
      case 'participant-topped-up': return { type: event.type, participantId: event.participantId, targetStack: event.targetStack, amount: event.amount };
      case 'button-set': return { type: event.type, seat: event.seat };
      case 'seat-changes-changed': return { type: event.type, allowSeatChanges: event.allowSeatChanges };
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
  return { type: 'table-update', ...projectTableSession(aggregate, participantId, game, serverTime, adminMode, connected), presentationEvents };
}
