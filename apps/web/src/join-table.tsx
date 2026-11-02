import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { api, RequestFailure } from '@poker/client';
import { onlineTableCapacity } from '@poker/contracts';
import { Dialog } from './dialog.js';
import { Icon } from './icons.js';
import { joinLink } from './join-link.js';
import { useSession } from './session.js';
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
  const join = useMutation({
    mutationFn: async () => {
      // The name is the Guest's own; saving it first lets the join see it. Each attempt is a fresh request.
      if (!returning && value.trim() !== stored) {
        const saved = await api.setDisplayName(value.trim());
        queryClient.setQueryData(['identity'], { ok: true, displayName: saved.displayName });
      }
      return api.joinTable(token, { requestId: crypto.randomUUID() });
    },
    onSuccess: async result => {
      select(result.tableSessionId);
      await queryClient.invalidateQueries({ queryKey: ['table-sessions'] });
      await navigate({ to: '/' });
    },
  });
  const returning = !!preview.data?.returningAs;
  const failure = join.error instanceof RequestFailure ? join.error.message : join.error ? 'Couldn’t join this table. Check your connection and try again.' : undefined;
  const data = preview.data;
  const dead = preview.error instanceof RequestFailure && preview.error.code === 'invalid-join-link';
  return <main id="main-table" className="join-page">
    <div className="join-card">
      <span className="brand-mark"><Icon name="spade" size={23} /></span>
      {(identity.isPending || preview.isPending && identity.isSuccess) && <p className="muted" role="status">Opening your invitation…</p>}
      {identity.isError && <div className="notice-error" role="alert"><p>Couldn’t connect to the poker server.</p><button onClick={() => void identity.refetch()}>Retry connection</button></div>}
      {preview.isError && (dead
        ? <><h1>This link doesn’t work.</h1><p className="notice-error" role="alert">{preview.error.message}</p><button className="primary" onClick={() => void navigate({ to: '/' })}>Go to my tables</button></>
        : <div className="notice-error" role="alert"><p>{preview.error instanceof RequestFailure ? preview.error.message : 'Couldn’t open this table.'}</p><button onClick={() => void preview.refetch()}>Try again</button></div>)}
      {data && <>
        <h1>{data.alreadyJoined ? 'You’re already at this table.' : returning ? `Return to ${data.ownerName}’s table` : `Join ${data.ownerName}’s table`}</h1>
        <p className="join-facts">No-limit Hold’em · {chips(data.configuration.smallBlind)} / {chips(data.configuration.bigBlind)} chips · {data.configuration.seatCount} seats{data.options.actionTimeLimitSeconds ? ` · ${data.options.actionTimeLimitSeconds} seconds to act` : ''}<br />{data.joinedCount} of {onlineTableCapacity} players have joined.</p>
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

/** The owner's copy of the Join Link, with a manual fallback where the clipboard is unavailable. */
export function JoinLinkDialog({ token, close }: { token: string; close: () => void }) {
  const link = joinLink(window.location.origin, token);
  const field = useRef<HTMLInputElement>(null);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'manual'>('idle');
  async function copyLink() {
    try { await navigator.clipboard.writeText(link); setCopy('copied'); }
    catch { field.current?.select(); setCopy('manual'); }
  }
  return <Dialog title="Join link" close={close}>
    <p className="muted">Anyone with this link can join your table, watch, and take a seat. Share it only with the people you want to play with.</p>
    <label>Join link<input ref={field} readOnly value={link} onFocus={e => e.target.select()} /></label>
    <div className="button-row"><button className="primary" onClick={() => void copyLink()}>{copy === 'copied' ? 'Copied' : 'Copy link'}</button><button onClick={close}>Done</button></div>
    <p className="muted" role="status">{copy === 'manual' ? 'Copying isn’t available here. The link is selected: copy it yourself.' : ''}</p>
  </Dialog>;
}
