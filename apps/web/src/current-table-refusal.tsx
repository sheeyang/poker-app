import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api } from '@poker/client';
import { Icon } from './icons.js';
import { useShell } from './app-shell.js';
import { currentTableRefusal } from './table-address.js';

/**
 * Why creating, joining or returning to an Online Table was refused: the Guest is already at another one, their
 * Current Table. It names that table when their saved tables list it, and links to it, where they can leave it.
 * Renders nothing for any other failure.
 */
export function CurrentTableRefusal({ error }: { error: unknown }) {
  const { identity } = useShell();
  const sessions = useQuery({ queryKey: ['table-sessions'], queryFn: api.listSessions, enabled: identity.isSuccess && !!currentTableRefusal(error, undefined) });
  const refusal = currentTableRefusal(error, sessions.data?.tables);
  if (!refusal) return null;
  return <div className="current-table-refusal" role="alert">
    <p className="current-table-refusal-title">Leave your <b>Current Table</b> first</p>
    <p>You’re already at an Online Table{refusal.table ? <>: <span className="numeric">{refusal.table}</span></> : ''}. You can be at one at a time, and Practice tables don’t count.</p>
    <Link className="text-button current-table-refusal-link" to="/online/$tableSessionId" params={{ tableSessionId: refusal.tableSessionId }}>Go to your Current Table<Icon name="arrow" size={15} /></Link>
  </div>;
}
