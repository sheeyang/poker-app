import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { api, RequestFailure } from '@poker/client';
import { onlineTableCapacity, type ObservableTableSession } from '@poker/contracts';
import { CommandFeedback } from './controls.js';
import { Dialog } from './dialog.js';
import { Icon } from './icons.js';
import { joinLink } from './join-link.js';
import { useSession, type Command } from './session.js';
import { chips } from './table-model.js';

const hint = 'Up to 20 letters, digits, spaces or basic punctuation. It is fixed for this table once you join.';

/** The page a Join Link opens: confirm a display name, join unseated, then land at the table. */
export function JoinTable({ token }: { token: string }) {
  const queryClient = useQueryClient(), navigate = useNavigate(), select = useSession(s => s.select);
  const identity = useQuery({ queryKey: ['identity'], queryFn: api.establishIdentity });
  const preview = useQuery({ queryKey: ['join-link', token], queryFn: ({ signal }) => api.previewJoinLink(token, signal), enabled: identity.isSuccess });
  const [typed, setTyped] = useState<string>();
  const stored = identity.data?.displayName ?? '';
  const value = typed ?? stored;
  const autoOpened = useRef<string | null>(null);
  const join = useMutation({
    mutationFn: async () => {
      // The name is the Guest's own; saving it first lets the join see it. Each attempt is a fresh request.
      if (!returning && !preview.data?.alreadyJoined && value.trim() !== stored) {
        const saved = await api.setDisplayName(value.trim());
        queryClient.setQueryData(['identity'], { ok: true, displayName: saved.displayName });
      }
      return api.joinTable(token, { requestId: crypto.randomUUID() });
    },
    onSuccess: async result => {
      select(result.tableSessionId);
      await queryClient.invalidateQueries({ queryKey: ['table-sessions'] });
      await navigate({ to: '/', replace: true });
    },
  });
  const returning = !!preview.data?.returningAs;
  const failure = join.error instanceof RequestFailure ? join.error.message : join.error ? 'Couldn’t join this table. Check your connection and try again.' : undefined;
  const data = preview.data;
  useEffect(() => {
    if (data?.alreadyJoined && autoOpened.current !== token) { autoOpened.current = token; join.mutate(); }
  }, [data?.alreadyJoined, token, join.mutate]);
  // A replaced link and a removal are final: trying again changes nothing.
  const dead = preview.error instanceof RequestFailure && ['invalid-join-link', 'guest-removed'].includes(preview.error.code);
  const removed = preview.error instanceof RequestFailure && preview.error.code === 'guest-removed';
  return <main id="main-table" className="join-page">
    <div className="join-card">
      <span className="brand-mark"><Icon name="spade" size={23} /></span>
      {(identity.isPending || preview.isPending && identity.isSuccess) && <p className="muted" role="status">Opening your invitation…</p>}
      {identity.isError && <div className="notice-error" role="alert"><p>Couldn’t connect to the poker server.</p><button onClick={() => void identity.refetch()}>Retry connection</button></div>}
      {preview.isError && (dead
        ? <><h1>{removed ? 'You can’t join this table.' : 'This link doesn’t work.'}</h1><p className="notice-error" role="alert">{preview.error.message}</p><button className="primary" onClick={() => void navigate({ to: '/' })}>Go to my tables</button></>
        : <div className="notice-error" role="alert"><p>{preview.error instanceof RequestFailure ? preview.error.message : 'Couldn’t open this table.'}</p><button onClick={() => void preview.refetch()}>Try again</button></div>)}
      {data?.alreadyJoined ? <div className="dialog-stack"><p role="status" className="muted">Opening your table…</p>{failure && <div className="notice-error" role="alert"><p>{failure}</p><button className="primary" disabled={join.isPending} onClick={() => join.mutate()}>Try opening again</button></div>}</div> : data && <>
        <h1>{data.alreadyJoined ? 'You’re already at this table.' : returning ? `Return to ${data.ownerName}’s table` : `Join ${data.ownerName}’s table`}</h1>
        <dl className="join-facts">
          <div><dt>Blinds</dt><dd>{chips(data.configuration.smallBlind)} / {chips(data.configuration.bigBlind)}</dd></div>
          <div><dt>Seats</dt><dd>{data.configuration.seatCount}</dd></div>
          {data.options.actionTimeLimitSeconds && <div><dt>Time to act</dt><dd>{data.options.actionTimeLimitSeconds}s</dd></div>}
          <div><dt>Buy-in</dt><dd>{chips(data.configuration.minimumBuyIn)}–{chips(data.configuration.maximumBuyIn)}</dd></div>
        </dl>
        {/* Places count everyone at the table, seated or watching, Bots included; only nearness to the limit matters to a newcomer. */}
        {!data.alreadyJoined && !returning && onlineTableCapacity - data.placesTaken <= 3 && <p className="muted">{onlineTableCapacity - data.placesTaken <= 0 ? 'This table is full.' : `Only ${onlineTableCapacity - data.placesTaken} ${onlineTableCapacity - data.placesTaken === 1 ? 'place is' : 'places are'} left at this table.`}</p>}
        <form onSubmit={e => { e.preventDefault(); if (!join.isPending && (returning || value.trim())) join.mutate(); }}>
          {data.alreadyJoined ? <p className="muted">You keep your seat, stack and history.</p> : returning ? <p className="muted">You’ll come back as {data.returningAs}, with your history from before. You stand up when you leave, so choose a seat again when you’re ready.</p> : <label>Your name at this table<input name="displayName" value={value} maxLength={40} autoComplete="nickname" required aria-describedby="join-name-hint" aria-invalid={!!failure} onChange={e => { setTyped(e.target.value); if (join.error) join.reset(); }} /><small id="join-name-hint" className="muted">{hint}</small></label>}
          {failure && <p className="notice-error" role="alert">{failure}</p>}
          <button className="primary" disabled={join.isPending || !returning && !value.trim()}>{join.isPending ? 'Joining…' : data.alreadyJoined ? 'Open table' : returning ? 'Return to table' : 'Join table'}<Icon name="arrow" size={19} /></button>
        </form>
        {!data.alreadyJoined && !returning && <p className="muted">You’ll watch the table first and can take an open seat whenever you’re ready.</p>}
      </>}
    </div>
  </main>;
}

/**
 * The owner's copy of the Join Link, with a manual fallback where the clipboard is unavailable, and the way to
 * replace it: the old link stops working at once, and everyone who has already joined stays.
 */
export function JoinLinkDialog({ table, command, close }: { table: ObservableTableSession; command: Command; close: () => void }) {
  const token = table.joinToken ?? '';
  const link = joinLink(window.location.origin, token);
  const field = useRef<HTMLInputElement>(null);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'manual'>('idle');
  const [replacing, setReplacing] = useState(false);
  // A replaced link is a new link to copy.
  useEffect(() => { setCopy('idle'); setReplacing(false); }, [token]);
  async function copyLink() {
    try { await navigator.clipboard.writeText(link); setCopy('copied'); }
    catch { field.current?.select(); setCopy('manual'); }
  }
  return <Dialog title="Join link" close={close}>
    <div className="dialog-stack">
      <CommandFeedback command={command} />
      <p className="muted">Anyone with this link can join your table, watch, and take a seat. Share it only with the people you want to play with.</p>
      <div className="link-field">
        <input aria-label="Join link" ref={field} readOnly value={link} onFocus={e => e.target.select()} />
        <button className="primary" data-autofocus onClick={() => void copyLink()}>{copy === 'copied' ? <><Icon name="check" size={18} />Copied</> : <><Icon name="link" size={18} />Copy link</>}</button>
        <p className="muted link-status" role="status">{copy === 'manual' ? 'Copying isn’t available here. The link is selected: copy it yourself.' : copy === 'copied' ? 'Copied. Paste it wherever your friends will see it.' : ''}</p>
      </div>
      <section className="replace-link"><h3>Link leaked?</h3>
        {replacing
          ? <><p className="muted">The current link stops working right away. Players who already joined stay at the table and don’t need the new link. You’ll have a new link to share.</p>
            <div className="button-row"><button className="leave-button" disabled={command.busy} onClick={() => { setReplacing(false); command.submit({ kind: 'replace-link', tableId: table.tableSessionId, body: { requestId: crypto.randomUUID(), expectedSessionRevision: table.sessionRevision } }); }}>Replace link</button><button onClick={() => setReplacing(false)}>Keep current link</button></div></>
          : <><p className="muted">Replace the link to shut out anyone who shouldn’t have it. Players who already joined are not affected.</p>
            <div className="button-row"><button className="leave-button" disabled={command.busy} onClick={() => setReplacing(true)}>Replace link…</button></div></>}
      </section>
    </div>
  </Dialog>;
}
