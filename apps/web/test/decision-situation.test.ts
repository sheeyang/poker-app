import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { baselinePlayingStrategy, defaultConfiguration, defaultTrainerConfiguration, highestProbabilityPlayingStrategy, type ObservableCashGameState, type ObservableTableSession } from '@poker/contracts';
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
  it('identifies both the reference Policy and Action Selector in the panel caption', () => {
    type Props = ComponentProps<typeof AnalysisPanel>;
    for (const [selector, expected] of [
      [defaultTrainerConfiguration.referenceStrategy.selector, 'Simple Heuristic · Probability Selector'],
      [highestProbabilityPlayingStrategy.selector, 'Simple Heuristic · Highest Probability'],
    ] as const) {
      const table: ObservableTableSession = { tableSessionId: 'table', pokerRevision: 2, sessionRevision: 2, bindings, trainerConfiguration: { ...defaultTrainerConfiguration, referenceStrategy: { ...defaultTrainerConfiguration.referenceStrategy, selector } }, inspection: { adminMode: false, completedHands: [] }, view: { configuration: defaultConfiguration, state: decision, history: [] } };
      const html = renderToStaticMarkup(createElement(AnalysisPanel, { table, analysis: { acceptedDecisions: [], selectedDecisionId: '' } as unknown as Props['analysis'], command: { busy: false } as Props['command'], close: () => {} }));
      const caption = html.match(/<div class="analysis-meta">([\s\S]*?)<\/div>/)![1].replace(/<[^>]*>/g, '');
      expect(caption).toContain(expected);
      expect(html).toContain(`>${expected}</option>`);
    }
  });

  it('shows live reference actions without duplicating the table, while keeping completed decision snapshots', () => {
    type Props = ComponentProps<typeof AnalysisPanel>;
    const table: ObservableTableSession = { tableSessionId: 'table', pokerRevision: 2, sessionRevision: 2, bindings, trainerConfiguration: { ...defaultTrainerConfiguration, liveAnalysis: true }, inspection: { adminMode: false, completedHands: [] }, view: { configuration: defaultConfiguration, state: { ...decision, decisionId: 'live' }, history: [] } };
    const data = { decisionId: 'live', status: 'complete', referenceStrategy: defaultTrainerConfiguration.referenceStrategy, evaluation: { actionProbabilities: [{ type: 'call', probability: 1 }], policyResult: { choices: [{ action: { type: 'call' }, probability: 1 }] }, selectedAction: { type: 'call' } } };
    const render = (review: boolean) => renderToStaticMarkup(createElement(AnalysisPanel, { table, analysis: { view: review ? 'hand' : 'live', acceptedDecisions: [{ decisionId: 'd1', handId: 'hand-1', handNumber: 1, state: decision, action: { type: 'call' } }], selectedDecisionId: 'd1', display: { data: { ...data, decisionId: review ? 'd1' : 'live' } } } as unknown as Props['analysis'], command: { busy: false } as Props['command'], close: () => {} }));
    const live = render(false);
    expect(live).toContain('Reference actions');
    expect(live).toContain('1.00');
    expect(live).toContain('role="tablist" aria-label="Analysis view"');
    expect(live).toContain('id="analysis-live-tab" role="tab" aria-selected="true"');
    expect(live).toContain('Live · Flop · Your turn');
    expect(live).not.toContain('Review your flop Call');
    expect(live).not.toContain('Current table state');
    expect(live).not.toContain('Poker table before your');
    expect(live).not.toContain('750 behind');
    const review = render(true);
    expect(review).toContain('Flop · Before your action');
    expect(review).toContain('Poker table before your flop decision');
    expect(review).toContain('750 behind');
    expect(review).toContain('Reference actions');
    expect(review).toContain('id="analysis-hand-tab" role="tab" aria-selected="true"');
    expect(review).not.toContain('Current decision');
    expect(review).not.toContain('Reviewing this hand');
    expect(review).not.toContain('class="analysis-mode-line"');
  });

  it('shows separate scores for collapsed decisions', () => {
    const table: ObservableTableSession = { tableSessionId: 'table', pokerRevision: 2, sessionRevision: 2, bindings, trainerConfiguration: defaultTrainerConfiguration, inspection: { adminMode: false, completedHands: [] }, view: { configuration: defaultConfiguration, state: decision, history: [] } };
    type Props = ComponentProps<typeof AnalysisPanel>;
    const analysis = {
      acceptedDecisions: ['d1', 'd2', 'd3'].map(decisionId => ({ decisionId, handId: 'hand-1', handNumber: 1, state: decision, action: { type: 'call' } })),
      selectedDecisionId: 'd1', expandedDecisionId: '', pinned: true,
      rowAnalyses: { d1: { status: 'complete', scores: { decisionScore: .72, actionRankScore: .8 } }, d2: { status: 'complete', scores: { decisionScore: .35, actionRankScore: .5 } } },
    } as unknown as Props['analysis'];
    const html = renderToStaticMarkup(createElement(AnalysisPanel, { table, analysis, command: { busy: false } as Props['command'], close: () => {} }));
    const summaries = [...html.matchAll(/<summary(?=[^>]*aria-label="Review your)[^>]*>([\s\S]*?)<\/summary>/g)].map(match => match[1].replace(/<[^>]*>/g, ''));
    expect(summaries).toEqual(['CallDecision Score72.0/100Action Rank Score80.0/100', 'CallDecision Score35.0/100Action Rank Score50.0/100', 'CallScores pending']);
  });
  it('lists only human decisions as expandable actions, with the street inside the selected detail', () => {
    const accepted = [
      { decisionId: 'd1', handId: 'hand-1', handNumber: 1, state: decision, action: { type: 'call' as const } },
      { decisionId: 'd2', handId: 'hand-1', handNumber: 1, state: { ...decision, street: 'river' as const }, action: { type: 'check' as const } },
    ];
    const table: ObservableTableSession = { tableSessionId: 'table', pokerRevision: 2, sessionRevision: 2, bindings, trainerConfiguration: defaultTrainerConfiguration, inspection: { adminMode: false, completedHands: [] }, view: { configuration: defaultConfiguration, state: decision, history: [] } };
    type Props = ComponentProps<typeof AnalysisPanel>;
    const html = renderToStaticMarkup(createElement(AnalysisPanel, { table, analysis: { acceptedDecisions: accepted, selectedDecisionId: 'd1', pinned: true } as Props['analysis'], command: { busy: false } as Props['command'], close: () => {} }));
    expect(html).toContain('<ol aria-label="Your decisions in this hand"');
    const actionSummaries = [...html.matchAll(/<summary(?=[^>]*aria-label="Review your)[^>]*>([\s\S]*?)<\/summary>/g)].map(match => match[1].replace(/<[^>]*>/g, ''));
    expect(actionSummaries).toEqual(['CallScores pending', 'CheckScores pending']);
    expect(html).toContain('id="decision-scores-d1" aria-hidden="true"');
    expect(html).toContain('Flop · Before your action');
    expect(html).not.toContain('River · Before your action');
  });

  it('shows large scores inside the expanded detail without repeating them in its header', () => {
    const table: ObservableTableSession = { tableSessionId: 'table', pokerRevision: 2, sessionRevision: 2, bindings, trainerConfiguration: defaultTrainerConfiguration, inspection: { adminMode: false, completedHands: [] }, view: { configuration: defaultConfiguration, state: decision, history: [] } };
    type Props = ComponentProps<typeof AnalysisPanel>;
    const data = { decisionId: 'd1', status: 'complete', referenceStrategy: defaultTrainerConfiguration.referenceStrategy, scoredDecision: { acceptedAction: { type: 'call' } }, scores: { decisionScore: .72, actionRankScore: .8 }, evaluation: { actionProbabilities: [{ type: 'call', probability: .6 }, { type: 'raise', probability: .4 }], policyResult: { choices: [{ action: { type: 'call' }, probability: .6 }, { action: { type: 'raise', raiseTo: 150 }, probability: .4 }] }, selectedAction: { type: 'call' } } };
    const analysis = { acceptedDecisions: [{ decisionId: 'd1', handId: 'hand-1', handNumber: 1, state: decision, action: { type: 'call' } }], selectedDecisionId: 'd1', expandedDecisionId: 'd1', pinned: true, display: { data }, rowAnalyses: { d1: data } } as unknown as Props['analysis'];
    const html = renderToStaticMarkup(createElement(AnalysisPanel, { table, analysis, command: { busy: false } as Props['command'], close: () => {} }));
    const header = html.match(/<summary(?=[^>]*aria-label="Review your)[^>]*>([\s\S]*?)<\/summary>/)![1];
    expect(header).toContain('class="review-row-action">Call</strong>');
    expect(header).toContain('aria-hidden="true"');
    expect(header).toContain('review-row-scores');
    expect(html).toContain('class="decision-scores"');
    expect(html.indexOf('class="decision-scores"')).toBeLessThan(html.indexOf('class="decision-context"'));
    expect(html.indexOf('class="decision-scores"')).toBeLessThan(html.indexOf('Reference actions'));
    expect(html.indexOf('Reference actions')).toBeLessThan(html.indexOf('class="decision-context"'));
    expect(html).toContain('72.0<small>/100</small>');
    expect(html).toContain('80.0<small>/100</small>');
    for (const removed of ['Your accepted action', 'Each seat shows', 'Total pot</dt>', 'Your stack</dt>', 'Return to latest decision', '>Latest decision<']) expect(html).not.toContain(removed);
    expect(html).toContain('aria-label="Analysis settings"');
    expect(html).toContain('About these scores');
    expect(html).toContain('Reference actions');
    expect(html).toContain('Raise-to 150');
    expect(html).toContain('0.40');
    expect(html).toContain('Sampled action');
    expect(html).toContain('Analysis details');
    expect(html.indexOf('Reference actions')).toBeLessThan(html.indexOf('Earlier actions'));
    const cachedHtml = renderToStaticMarkup(createElement(AnalysisPanel, { table, analysis: { ...analysis, display: undefined }, command: { busy: false } as Props['command'], close: () => {} }));
    expect(cachedHtml).toContain('class="decision-scores"');
    expect(cachedHtml).toContain('72.0<small>/100</small>');
    expect(cachedHtml).not.toContain('Loading reference actions');
  });

  it('offers Latest decision only for older reviews, with Live available as a separate view', () => {
    type Props = ComponentProps<typeof AnalysisPanel>;
    const table: ObservableTableSession = { tableSessionId: 'table', pokerRevision: 2, sessionRevision: 2, bindings, trainerConfiguration: defaultTrainerConfiguration, inspection: { adminMode: false, completedHands: [] }, view: { configuration: defaultConfiguration, state: decision, history: [] } };
    const accepted = { decisionId: 'd1', handId: 'hand-1', handNumber: 1, state: decision, action: { type: 'call' } };
    const render = (acceptedDecisions = [accepted], live = false) => renderToStaticMarkup(createElement(AnalysisPanel, { table: live ? { ...table, trainerConfiguration: { ...defaultTrainerConfiguration, liveAnalysis: true }, view: { ...table.view, state: { ...decision, decisionId: 'current' } } } : table, analysis: { acceptedDecisions, selectedDecisionId: 'd1', expandedDecisionId: '', pinned: true } as Props['analysis'], command: { busy: false } as Props['command'], close: () => {} }));
    expect(render()).not.toContain('>Latest decision');
    expect(render([accepted, { ...accepted, decisionId: 'd2' }])).toContain('>Latest decision');
    expect(render([accepted], true)).not.toContain('>Live decision');
    expect(render([accepted], true)).toContain('id="analysis-live-tab"');
  });

  it('shows the current hand instead of a pinned review from the previous hand', () => {
    const table: ObservableTableSession = {
      tableSessionId: 'table', pokerRevision: 20, sessionRevision: 20, bindings,
      trainerConfiguration: defaultTrainerConfiguration, inspection: { adminMode: false, completedHands: [] },
      view: {
        configuration: defaultConfiguration,
        state: { ...decision, handId: 'hand-2', board: [], buttonSeat: 4, amountToCall: 900, participants: decision.participants.map(p => ({ ...p, seat: 4, handSeat: 4, stack: 9000, contribution: 5000 })) },
        history: [{ handId: 'hand-1', description: 'Hand 1', decisions: [] }, { handId: 'hand-2', description: 'Hand 2', decisions: [] }],
      },
    };
    type Props = ComponentProps<typeof AnalysisPanel>;
    const analysis = { acceptedDecisions: [{ decisionId: 'd1', handId: 'hand-1', handNumber: 1, state: decision, action: { type: 'call' } }], selectedDecisionId: 'd1', pinned: true } as Props['analysis'];
    const html = renderToStaticMarkup(createElement(AnalysisPanel, { table, analysis, command: { busy: false } as Props['command'], close: () => {} }));
    expect(html).toContain('Hand 2 analysis');
    expect(html).not.toContain('Hand 1 analysis');
    expect(html).not.toContain('Review your flop Call');
    expect(html).not.toContain('750 behind');
    expect(html).not.toContain('825 behind');
    expect(html).toContain('Play first. Explore after.');
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
