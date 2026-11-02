import type { ObservableTableSession } from '@poker/contracts';

type LiveAnalysisTable = Pick<ObservableTableSession, 'mode' | 'options' | 'schedule' | 'viewerParticipantId' | 'trainerConfiguration'>;

/**
 * Whether the table lets the viewer use Live Analysis. For the viewer's own decision this is what its Action Window
 * captured when it opened, which is what the server enforces; otherwise it is the table's current Allow Live Analysis,
 * which the viewer's next decision will capture.
 */
export function liveAnalysisAllowed(table: Pick<LiveAnalysisTable, 'options' | 'schedule' | 'viewerParticipantId'>): boolean {
  const window = table.schedule.actionWindow;
  return window?.participantId === table.viewerParticipantId ? !window.liveAnalysisDisallowed : table.options.allowLiveAnalysis;
}

/** Whether Live Analysis runs: the viewer has it on in their own Trainer configuration, and the table allows it. */
export function liveAnalysisOn(table: Pick<LiveAnalysisTable, 'options' | 'schedule' | 'viewerParticipantId' | 'trainerConfiguration'>): boolean {
  return table.trainerConfiguration.liveAnalysis && liveAnalysisAllowed(table);
}

/** The table's Allow Live Analysis as everyone at an Online Table sees it. A Practice Table has no such setting. */
export function tableLiveAnalysisNote(table: Pick<LiveAnalysisTable, 'mode' | 'options' | 'schedule' | 'viewerParticipantId'>): string | undefined {
  if (table.mode !== 'online') return undefined;
  return liveAnalysisAllowed(table) ? 'This table allows Live Analysis.' : 'The Table Owner has turned off Live Analysis at this table. Your decisions are still analyzed and scored after you act.';
}
