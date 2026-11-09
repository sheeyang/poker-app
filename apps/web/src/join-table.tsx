import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, RequestFailure } from '@poker/client';
import { onlineTableCapacity, type JoinLinkPreview, type ObservableTableSession } from '@poker/contracts';
import { Dialog } from './dialog.js';
import { Icon } from './icons.js';
import { FeltPreview, type SeatMark } from './felt.js';
import { Skeleton } from './loading-skeleton.js';
import { usePageTitle, useShell } from './app-shell.js';
import { joinLink } from './table-address.js';
import { chips, tableFormat } from './table-model.js';

/**
 * The join form an Online Table's address shows a Guest who is not at the table: the table as its Join Link
 * describes it on the left, and on the right their name, then Join. A Guest who left returns as the same
 * Participant, under the name they had. Joining keeps the address: it becomes their table.
 */
export function JoinTable({ tableSessionId, preview, joined }: { tableSessionId: string; preview: JoinLinkPreview; joined: () => void }) {
  const queryClient = useQueryClient();
  const { identity } = useShell();
  usePageTitle({ page: 'join', ownerName: preview.ownerName });
  const [typed, setTyped] = useState<string>();
  const stored = identity.data?.displayName ?? '';
  const value = typed ?? stored;
  const returning = preview.returningAs;
  // A Guest already at the table, or coming back to it, keeps the name they had there.
  const named = !returning && !preview.alreadyJoined;
  const join = useMutation({
    mutationFn: async () => {
      // The name is the Guest's own; saving it first lets the join see it. Each attempt is a fresh request.
      if (named && value.trim() !== stored) {
        const saved = await api.setDisplayName(value.trim());
        queryClient.setQueryData(['identity'], { ok: true, displayName: saved.displayName });
      }
      return api.joinTable(tableSessionId, { requestId: crypto.randomUUID() });
    },
    onSuccess: joined,
  });
  const failure = join.error instanceof RequestFailure ? join.error.message : join.error ? 'Couldn’t join this table. Check your connection and try again.' : undefined;
  const { configuration, options } = preview;
  const left = onlineTableCapacity - preview.placesTaken;
  // Places count everyone at the table, seated or watching, Bots included; only nearness to the limit matters to a newcomer.
  const room = named && left <= 3 ? left <= 0 ? 'This table is full. Ask the Table Owner to make room.' : `Only ${left} ${left === 1 ? 'place is' : 'places are'} left at this table.` : undefined;
  const seats = Array.from({ length: configuration.seatCount }, (): SeatMark => 'open');
  const format = tableFormat(configuration.seatCount);
  const timed = options.actionTimeLimitSeconds ? ` · ${options.actionTimeLimitSeconds}s to act` : '';
  const address = joinLink(window.location.host, tableSessionId);
  const field = useRef<HTMLInputElement>(null);
  return <main id="main-table" className="join-page">
    <div className="join-card">
      <section className="join-table" aria-labelledby="join-title">
        <p className="join-address"><Icon name="link" size={15} /><span>{address}</span></p>
        <h1 id="join-title">{preview.ownerName}’s table</h1>
        <FeltPreview seats={seats} label={`${format} table with ${configuration.seatCount} seats, blinds ${chips(configuration.smallBlind)} / ${chips(configuration.bigBlind)}${timed}`}>
          <strong className="numeric">{chips(configuration.smallBlind)} / {chips(configuration.bigBlind)}</strong>
          <span>{format}{timed}</span>
        </FeltPreview>
        <dl className="join-facts">
          <div><dt>Buy-in</dt><dd>{chips(configuration.minimumBuyIn)}–{chips(configuration.maximumBuyIn)}</dd></div>
          {configuration.ante > 0 && <div><dt>Ante</dt><dd>{chips(configuration.ante)}</dd></div>}
          <div><dt>Places taken</dt><dd>{preview.placesTaken} of {onlineTableCapacity}</dd></div>
        </dl>
      </section>
      <form className="join-form" aria-labelledby="join-form-title" onSubmit={e => { e.preventDefault(); if (join.isPending) return; if (named && !value.trim()) { field.current?.focus(); return; } join.mutate(); }}>
        <h2 id="join-form-title">{preview.alreadyJoined ? 'You’re at this table' : returning ? `Return as ${returning}` : 'Join as a Guest'}</h2>
        {named
          ? <label>Your name at this table<input ref={field} name="displayName" value={value} maxLength={20} autoComplete="nickname" required aria-describedby="join-name-hint" aria-invalid={!!failure} onChange={e => { setTyped(e.target.value); if (join.error) join.reset(); }} /><small id="join-name-hint" className="muted">Fixed for this table once you join.</small></label>
          : <p className="muted">{preview.alreadyJoined ? 'You keep your seat, stack and history.' : `You come back as ${returning}, with your history from before. Take a seat again when you’re ready.`}</p>}
        {room && <p className="join-room">{room}</p>}
        {failure && <p className="notice-error" role="alert">{failure}</p>}
        <button className="primary start-practice" disabled={join.isPending}>{join.isPending ? 'Joining…' : preview.alreadyJoined ? 'Open table' : returning ? 'Return to table' : 'Join table'}<Icon name="arrow" size={19} /></button>
        {named && <p className="muted join-note">You’ll watch first, then take an open seat when you’re ready.</p>}
      </form>
    </div>
  </main>;
}

/** The join form's shape while its Join Link is read: no fabricated table, only where its parts will be. */
export function JoinTableSkeleton() {
  return <main id="main-table" className="join-page">
    <div className="join-card" role="status" aria-label="Opening the Join Link">
      <div className="join-table" aria-hidden="true"><Skeleton className="skeleton-join-address" /><Skeleton className="skeleton-join-title" /><FeltPreview seats={[]} label="" /></div>
      <div className="join-form" aria-hidden="true"><Skeleton className="skeleton-join-heading" /><Skeleton className="skeleton-join-field" /><Skeleton className="skeleton-join-button" /></div>
    </div>
  </main>;
}

/**
 * The table's Join Link, for any Participant to pass on: its own address, with a manual fallback where the
 * clipboard is unavailable.
 */
export function JoinLinkDialog({ table, close }: { table: ObservableTableSession; close: () => void }) {
  const link = joinLink(window.location.origin, table.tableSessionId);
  const field = useRef<HTMLInputElement>(null);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'manual'>('idle');
  async function copyLink() {
    try { await navigator.clipboard.writeText(link); setCopy('copied'); }
    catch { field.current?.select(); setCopy('manual'); }
  }
  return <Dialog title="Join link" close={close}>
    <div className="dialog-stack">
      <p className="muted">This table’s address is its Join Link. Anyone you send it to can join, watch, and take an open seat.</p>
      <div className="link-field">
        <input aria-label="Join link" ref={field} readOnly value={link} onFocus={e => e.target.select()} />
        <button className="primary" data-autofocus onClick={() => void copyLink()}>{copy === 'copied' ? <><Icon name="check" size={18} />Copied</> : <><Icon name="link" size={18} />Copy link</>}</button>
        <p className="muted link-status" role="status">{copy === 'manual' ? 'Copying isn’t available here. The link is selected: copy it yourself.' : copy === 'copied' ? 'Copied. Paste it wherever your friends will see it.' : ''}</p>
      </div>
    </div>
  </Dialog>;
}
