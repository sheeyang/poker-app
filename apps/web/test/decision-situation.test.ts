import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { baselinePlayingStrategy, defaultConfiguration, defaultTrainerConfiguration, type ObservableCashGameState, type ObservableTableSession } from '@poker/contracts';
import { AnalysisPanel } from '../src/analysis-panel.js';
import { DecisionSituation } from '../src/decision-situation.js';

const bindings: ObservableTableSession['bindings'] = [
  { participantId: 'you', name: 'You', controller: { kind: 'human' } },
  { participantId: 'bot', name: 'Bot 1', controller: { kind: 'bot', playingStrategy: baselinePlayingStrategy } },
];
const decision: ObservableCashGameState = {
  status: 'active-hand', handId: 'hand-1', street: 'flop', buttonSeat: 6,
  actorId: 'you', amountToCall: 75, legalActions: [{ type: 'call' }],
  smallBlindParticipantId: 'you', bigBlindParticipantId: 'bot', board: ['2c', '3d', '4h'],
  participants: [
    { participantId: 'you', seat: 6, handSeat: 6, stack: 750, sittingOut: false, inHand: true, contribution: 125, wager: 25, holeCards: ['As', 'Kh'] },
    { participantId: 'bot', seat: 2, handSeat: 2, stack: 825, sittingOut: false, inHand: true, contribution: 175, wager: 100 },
    { participantId: 'away', seat: 4, stack: 999, sittingOut: true },
  ],
  pots: [{ amount: 200, eligibleParticipantIds: ['you', 'bot'] }],
};

describe('decision situation', () => {
  it('lists only human decisions as expandable actions, with the street inside the selected detail', () => {
    const accepted = [
      { decisionId: 'd1', handId: 'hand-1', handNumber: 1, state: decision, action: { type: 'call' as const } },
      { decisionId: 'd2', handId: 'hand-1', handNumber: 1, state: { ...decision, street: 'river' as const }, action: { type: 'check' as const } },
    ];
    const table: ObservableTableSession = { tableSessionId: 'table', pokerRevision: 2, sessionRevision: 2, bindings, trainerConfiguration: defaultTrainerConfiguration, inspection: { adminMode: false, completedHands: [] }, view: { configuration: defaultConfiguration, state: decision, history: [] } };
    type Props = ComponentProps<typeof AnalysisPanel>;
    const html = renderToStaticMarkup(createElement(AnalysisPanel, { table, analysis: { acceptedDecisions: accepted, selectedDecisionId: 'd1', pinned: true } as Props['analysis'], command: { busy: false } as Props['command'], close: () => {} }));
    expect(html).toContain('<ol aria-label="Your decisions in this hand"');
    const actionSummaries = [...html.matchAll(/<summary[^>]*>([\s\S]*?)<\/summary>/g)].map(match => match[1].replace(/<[^>]*>/g, '')).filter(text => text.startsWith('You'));
    expect(actionSummaries).toEqual(['YouCall', 'YouCheck']);
    expect(html).toContain('At your flop decision');
    expect(html).not.toContain('At your river decision');
  });

  it('keeps a pinned decision tied to its saved pot, stacks and seats as the live table advances', () => {
    const table: ObservableTableSession = {
      tableSessionId: 'table', pokerRevision: 20, sessionRevision: 20, bindings,
      trainerConfiguration: defaultTrainerConfiguration, inspection: { adminMode: false, completedHands: [] },
      view: {
        configuration: defaultConfiguration,
        state: { ...decision, handId: 'hand-2', board: [], buttonSeat: 4, amountToCall: 900, participants: decision.participants.map(p => ({ ...p, seat: 4, handSeat: 4, stack: 9000, contribution: 5000 })) },
        history: [],
      },
    };
    type Props = ComponentProps<typeof AnalysisPanel>;
    const analysis = { acceptedDecisions: [{ decisionId: 'd1', handId: 'hand-1', handNumber: 1, state: decision, action: { type: 'call' } }], selectedDecisionId: 'd1', pinned: true } as Props['analysis'];
    const html = renderToStaticMarkup(createElement(AnalysisPanel, { table, analysis, command: { busy: false } as Props['command'], close: () => {} }));
    expect(html).toContain('Total pot</dt><dd>300</dd>');
    expect(html).toContain('To call</dt><dd>75</dd>');
    expect(html).toContain('Your stack</dt><dd>750</dd>');
    expect(html).toContain('Your position</dt><dd>Seat 6');
    expect(html).toContain('825 behind');
    expect(html).not.toContain('9,000');
    expect(html).not.toContain('999 behind');
  });

  it('shows the prior participant action on the mini table without later actions or revealed cards', () => {
    const table: ObservableTableSession = {
      tableSessionId: 'table', pokerRevision: 8, sessionRevision: 8, bindings,
      trainerConfiguration: defaultTrainerConfiguration, inspection: { adminMode: false, completedHands: [] },
      view: { configuration: defaultConfiguration, state: { ...decision, street: 'river', board: ['2c', '3d', '4h', 'Qs', 'Qh'] }, history: [{ handId: 'hand-1', description: 'Hand 1', decisions: [
        { decisionId: 'before', state: { ...decision, street: 'preflop' }, action: { participantId: 'bot', action: { type: 'raise', raiseTo: 175 } } },
        { decisionId: 'd1', state: decision, action: { participantId: 'you', action: { type: 'call' } } },
        { decisionId: 'after', state: { ...decision, street: 'river' }, action: { participantId: 'bot', action: { type: 'raise', raiseTo: 900 } } },
      ] }] },
    };
    type Props = ComponentProps<typeof AnalysisPanel>;
    const analysis = { acceptedDecisions: [{ decisionId: 'd1', handId: 'hand-1', handNumber: 1, state: decision, action: { type: 'call' } }], selectedDecisionId: 'd1', pinned: true } as Props['analysis'];
    const html = renderToStaticMarkup(createElement(AnalysisPanel, { table, analysis, command: { busy: false } as Props['command'], close: () => {} }));
    expect(html).toContain('aria-label="Poker table before your flop decision"');
    expect(html).toContain('Raise-to 175');
    expect(html).toContain('preflop');
    expect(html).toContain('Earlier actions');
    expect(html).not.toContain('Raise-to 900');
    expect(html).not.toContain('Q of spades');
    expect(html).not.toContain('Q of hearts');
  });

  it('distinguishes a free check, heads-up dealer/blind roles and an all-in opponent', () => {
    const state = { ...decision, amountToCall: 0, participants: decision.participants.map(p => p.participantId === 'bot' ? { ...p, stack: 0, allIn: true } : p) };
    const html = renderToStaticMarkup(createElement(DecisionSituation, { state, humanId: 'you', bindings }));
    expect(html).toContain('No bet to call');
    expect(html).toContain('Dealer · Small blind');
    expect(html).toContain('seat 2, 0 chips');
    expect(html).toContain('All-in');
    expect(html).toContain('0 behind');
  });

  it('does not present another participant’s turn as the human’s decision situation', () => {
    const html = renderToStaticMarkup(createElement(DecisionSituation, { state: { ...decision, actorId: 'bot', amountToCall: undefined }, humanId: 'you', bindings }));
    expect(html).toBe('');
  });
});
