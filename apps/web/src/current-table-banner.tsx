import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';
import { api, retainNewestTable } from '@poker/client';
import { Icon } from './icons.js';
import { ParticipantDialog } from './participant-dialogs.js';
import { usePresentation } from './use-presentation.js';
import { currentTableBanner } from './current-table.js';
import type { Command } from './session.js';

/**
 * The live strip under the header: the Guest's Current Table, on every page but its own. The shell's live
 * subscription to that table keeps its read current, so the strip changes as the table does, and goes once the
 * Guest's Leave Table or Removal takes effect.
 */
export function CurrentTableBanner({ tableSessionId, command }: { tableSessionId: string; command: Command }) {
  const pathname = useRouterState({ select: state => state.location.pathname });
  const read = useQuery({ queryKey: ['table-session', tableSessionId], queryFn: ({ signal }) => api.readSession(tableSessionId, signal), structuralSharing: retainNewestTable });
  const table = read.data;
  const presentation = usePresentation(table, table?.viewerParticipantId);
  const [leaving, setLeaving] = useState(false);
  const banner = table && presentation && currentTableBanner(table, pathname, presentation.serverNow);
  if (!table || !banner) return null;
  return <aside className={`live-strip${banner.yourTurn ? ' is-turn' : ''}${banner.pending ? ' is-leaving' : ''}`} aria-label="Your Current Table">
    <span className="live-strip-dot" aria-hidden="true" />
    <p className="live-strip-facts">
      <strong aria-live="polite">{banner.heading}</strong>
      <span>{banner.format}</span>
      {banner.pending ? <span className="live-strip-tag" role="status">{banner.pending}</span> : <span className="live-strip-hand">{banner.hand}</span>}
      <span className="live-strip-stack numeric">{banner.stack}</span>
    </p>
    <div className="live-strip-actions">
      {banner.leave !== 'unavailable' && <button type="button" className="live-strip-leave" aria-haspopup="dialog" onClick={() => setLeaving(true)}>Leave game</button>}
      <Link className="live-strip-back" to="/online/$tableSessionId" params={{ tableSessionId }}>Back to game<Icon name="arrow" size={16} /></Link>
    </div>
    {leaving && <ParticipantDialog table={table} participantId={table.viewerParticipantId} task="leave" command={command} handOpen={banner.handOpen} close={() => setLeaving(false)} />}
  </aside>;
}
