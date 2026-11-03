import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { defaultConfiguration, defaultTrainerConfiguration, type ActionWindow, type ObservableTableSession, type TableMode } from '@poker/contracts';
import { liveAnalysisAllowed, liveAnalysisOn, tableLiveAnalysisNote } from '../src/live-analysis.js';
import { AnalysisPanel } from '../src/analysis-panel.js';

function table({ mode = 'online', allowLiveAnalysis = true, liveAnalysis = true, actionWindow = null }: { mode?: TableMode; allowLiveAnalysis?: boolean; liveAnalysis?: boolean; actionWindow?: ActionWindow | null } = {}): ObservableTableSession {
  return {
    tableSessionId: 'table', mode, options: { actionTimeLimitSeconds: 30, allowLiveAnalysis }, viewerParticipantId: 'you', ownerParticipantId: 'owner', pokerRevision: 3, sessionRevision: 5,
    bindings: [{ participantId: 'you', name: 'You', controller: { kind: 'human' } }, { participantId: 'owner', name: 'Ann', controller: { kind: 'human' } }],
    trainerConfiguration: { ...defaultTrainerConfiguration, liveAnalysis }, inspection: { adminMode: false, completedHands: [] },
    schedule: { phases: [], actionWindow }, serverTime: 0, pendingChanges: [],
    view: { configuration: defaultConfiguration, state: { status: 'active-hand', handId: 'hand-2', street: 'preflop', buttonSeat: 1, actorId: actionWindow?.participantId ?? null, decisionId: actionWindow?.decisionId ?? null, legalActions: actionWindow?.participantId === 'you' ? [{ type: 'fold' }, { type: 'call' }] : [], board: [], pots: [], participants: [] }, history: [] },
  };
}
const yours = (window: Partial<ActionWindow> = {}): ActionWindow => ({ participantId: 'you', decisionId: 'hand-2/decision-1', opensAt: 1500, deadlineAt: 31_500, ...window });

test('the table allows Live Analysis unless its owner disallowed it', () => {
  expect(liveAnalysisAllowed(table())).toBe(true);
  expect(liveAnalysisAllowed(table({ allowLiveAnalysis: false }))).toBe(false);
  // Someone else's turn: the table's setting is what the viewer's next decision captures.
  expect(liveAnalysisAllowed(table({ allowLiveAnalysis: false, actionWindow: yours({ participantId: 'owner' }) }))).toBe(false);
});

test('for the viewer’s own decision, what its Action Window captured when it opened decides', () => {
  expect(liveAnalysisAllowed(table({ actionWindow: yours({ liveAnalysisDisallowed: true }) }))).toBe(false);
  expect(liveAnalysisAllowed(table({ allowLiveAnalysis: false, actionWindow: yours() }))).toBe(true);
});

test('Live Analysis runs only while the viewer has it on and the table allows it', () => {
  expect(liveAnalysisOn(table({ actionWindow: yours() }))).toBe(true);
  expect(liveAnalysisOn(table({ liveAnalysis: false, actionWindow: yours() }))).toBe(false);
  expect(liveAnalysisOn(table({ actionWindow: yours({ liveAnalysisDisallowed: true }) }))).toBe(false);
});

test('everyone at an Online Table is told the table’s setting; a Practice Table has none to tell', () => {
  expect(tableLiveAnalysisNote(table())).toBe('This table allows Live Analysis.');
  expect(tableLiveAnalysisNote(table({ allowLiveAnalysis: false }))).toBe('The Table Owner has turned off Live Analysis at this table. Your decisions are still analyzed and scored after you act.');
  expect(tableLiveAnalysisNote(table({ mode: 'practice' }))).toBeUndefined();
});

test('when the table disallows it, the analysis panel shows that and disables the Live Analysis switch', () => {
  type Props = ComponentProps<typeof AnalysisPanel>;
  const render = (current: ObservableTableSession) => renderToStaticMarkup(createElement(AnalysisPanel, { table: current, analysis: { view: 'live', acceptedDecisions: [], selectedDecisionId: '' } as unknown as Props['analysis'], summary: { handId: 'hand-2' } as Props['summary'], sessionSummary: {} as Props['sessionSummary'], command: { busy: false } as Props['command'], close: () => {} }));
  const disallowed = render(table({ actionWindow: yours({ liveAnalysisDisallowed: true }) }));
  expect(disallowed).toContain('Live Analysis isn’t allowed at this table.');
  expect(disallowed).toContain('The Table Owner has turned off Live Analysis at this table.');
  expect(disallowed).toMatch(/<input type="checkbox" role="switch" disabled=""/);
  expect(disallowed).not.toContain('Enable Live Analysis');
  const allowed = render(table({ actionWindow: yours() }));
  expect(allowed).not.toContain('isn’t allowed');
  expect(allowed).toMatch(/<input type="checkbox" role="switch" checked=""/);
});
