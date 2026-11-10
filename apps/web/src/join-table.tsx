import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, RequestFailure } from '@poker/client';
import { onlineTableCapacity, type JoinLinkPreview, type ObservableTableSession, type OpenJoinLinkPreview } from '@poker/contracts';
import { Dialog } from './dialog.js';
import { Icon } from './icons.js';
import { FeltPreview, type SeatMark } from './felt.js';
import { Skeleton } from './loading-skeleton.js';
import { usePageTitle, useShell } from './app-shell.js';
import { currentTableRefusal, joinLink } from './table-address.js';
import { CurrentTableRefusal } from './current-table-refusal.js';
import { chips, tableFormat } from './table-model.js';
import { joinProblem, joinRequest, type JoinProblemField } from './join-form.js';
import { PasswordField } from './password-input.js';

/**
 * The join form an Online Table's address shows a Guest who is not at the table: the table as its Join Link
 * describes it on the left, and on the right their name, then Join. A Guest who left returns as the same
 * Participant, under the name they had. Joining keeps the address: it becomes their table.
 *
 * Behind a Table Password the left pane shows only whose table it is, and the form asks for the password with the
 * name, as one step. A wrong password keeps everything typed, explains itself under the password, and lets the Guest
 * try again. The password lives only in this form's memory.
 */
export function JoinTable({ tableSessionId, preview, joined }: { tableSessionId: string; preview: JoinLinkPreview; joined: () => void }) {
  const queryClient = useQueryClient();
  const { identity } = useShell();
  usePageTitle({ page: 'join', ownerName: preview.ownerName });
  const [typed, setTyped] = useState<string>();
  const [tablePassword, setTablePassword] = useState('');
  const stored = identity.data?.displayName ?? '';
  const value = typed ?? stored;
  const locked = !!preview.passwordRequired;
  const returning = preview.passwordRequired ? undefined : preview.returningAs;
  const alreadyJoined = !preview.passwordRequired && preview.alreadyJoined;
  // A Guest already at the table, or coming back to it, keeps the name they had there.
  const named = !returning && !alreadyJoined;
  const nameField = useRef<HTMLInputElement>(null), passwordField = useRef<HTMLInputElement>(null);
  const join = useMutation({
    mutationFn: async () => {
      // The name is the Guest's own; saving it first lets the join see it. Each attempt is a fresh request.
      if (named && value.trim() !== stored) {
        const saved = await api.setDisplayName(value.trim());
        queryClient.setQueryData(['identity'], { ok: true, displayName: saved.displayName });
      }
      return api.joinTable(tableSessionId, joinRequest(crypto.randomUUID(), { passwordRequired: locked, tablePassword }));
    },
    onSuccess: joined,
    onError: error => {
      if (!(error instanceof RequestFailure)) return;
      // The owner set a password since this link was opened: show the form that asks for it.
      if (error.code === 'table-password-required' && !locked) void queryClient.invalidateQueries({ queryKey: ['join-preview', tableSessionId] });
      // Ready to retype: the wrong password is selected, the name is untouched.
      if (error.code === 'wrong-table-password') requestAnimationFrame(() => { passwordField.current?.focus(); passwordField.current?.select(); });
    },
  });
  // At another Online Table already: what to do about it is shown on its own, with a way to that table.
  const problem = join.error && !currentTableRefusal(join.error, undefined) ? joinProblem(join.error instanceof RequestFailure ? { code: join.error.code, message: join.error.message } : undefined, preview.ownerName) : undefined;
  const fieldProblem = (field: JoinProblemField) => problem?.field === field ? problem.message : undefined;
  const nameProblem = fieldProblem('displayName'), passwordProblem = fieldProblem('tablePassword'), formProblem = fieldProblem('form');
  const edited = () => { if (join.error) join.reset(); };
  const address = joinLink(window.location.host, tableSessionId);
  return <main id="main-table" className="join-page">
    <div className="join-card">
      <section className="join-table" aria-labelledby="join-title">
        <p className="join-address"><Icon name="link" size={15} /><span>{address}</span></p>
        <h1 id="join-title">{preview.ownerName}’s table</h1>
        {preview.passwordRequired
          ? <>
            <FeltPreview seats={[]} label="A table protected by a Table Password"><span className="felt-locked"><Icon name="lock" size={15} />Password required</span></FeltPreview>
            <p className="join-protected">Protected by a Table Password. The table’s details appear once you join.</p>
          </>
          : <OpenTable preview={preview} />}
      </section>
      <form className="join-form" aria-labelledby="join-form-title" noValidate onSubmit={e => {
        e.preventDefault();
        if (join.isPending) return;
        if (named && !value.trim()) { nameField.current?.focus(); return; }
        if (locked && !tablePassword) { passwordField.current?.focus(); return; }
        join.mutate();
      }}>
        <h2 id="join-form-title">{alreadyJoined ? 'You’re at this table' : returning ? `Return as ${returning}` : 'Join as a Guest'}</h2>
        {named
          ? <label>Your name at this table<input ref={nameField} name="displayName" value={value} maxLength={20} autoComplete="nickname" required aria-describedby={nameProblem ? 'join-name-problem' : 'join-name-hint'} aria-invalid={!!nameProblem} onChange={e => { setTyped(e.target.value); edited(); }} />
            {nameProblem ? <small id="join-name-problem" className="field-problem" role="alert">{nameProblem}</small> : <small id="join-name-hint" className="muted">Fixed for this table once you join.</small>}</label>
          : <p className="muted">{alreadyJoined ? 'You keep your seat, stack and history.' : `You come back as ${returning}, with your history from before. Take a seat again when you’re ready.`}</p>}
        {locked && <PasswordField ref={passwordField} id="join-table-password" label="Table password" name="tablePassword" value={tablePassword} autoComplete="current-password" required aria-describedby={passwordProblem ? 'join-password-problem' : undefined} aria-invalid={!!passwordProblem} onChange={e => { setTablePassword(e.target.value); edited(); }}
          note={passwordProblem && <small id="join-password-problem" className="field-problem" role="alert">{passwordProblem}</small>} />}
        {!preview.passwordRequired && named && <RoomNote placesTaken={preview.placesTaken} />}
        {formProblem && <p className="notice-error" role="alert">{formProblem}</p>}
        <CurrentTableRefusal error={join.error} />
        <button type="submit" className="primary start-practice" disabled={join.isPending}>{join.isPending ? 'Joining…' : alreadyJoined ? 'Open table' : returning ? 'Return to table' : 'Join table'}<Icon name="arrow" size={19} /></button>
        {named && <p className="muted join-note">You’ll watch first, then take an open seat when you’re ready.</p>}
      </form>
    </div>
  </main>;
}

/** The table a Join Link without a Table Password describes: its stakes on the felt, then its buy-in and places. */
function OpenTable({ preview }: { preview: OpenJoinLinkPreview }) {
  const { configuration, options } = preview;
  const seats = Array.from({ length: configuration.seatCount }, (): SeatMark => 'open');
  const format = tableFormat(configuration.seatCount);
  const timed = options.actionTimeLimitSeconds ? ` · ${options.actionTimeLimitSeconds}s to act` : '';
  return <>
    <FeltPreview seats={seats} label={`${format} table with ${configuration.seatCount} seats, blinds ${chips(configuration.smallBlind)} / ${chips(configuration.bigBlind)}${timed}`}>
      <strong className="numeric">{chips(configuration.smallBlind)} / {chips(configuration.bigBlind)}</strong>
      <span>{format}{timed}</span>
    </FeltPreview>
    <dl className="join-facts">
      <div><dt>Buy-in</dt><dd>{chips(configuration.minimumBuyIn)}–{chips(configuration.maximumBuyIn)}</dd></div>
      {configuration.ante > 0 && <div><dt>Ante</dt><dd>{chips(configuration.ante)}</dd></div>}
      <div><dt>Places taken</dt><dd>{preview.placesTaken} of {onlineTableCapacity}</dd></div>
    </dl>
  </>;
}

/** Places count everyone at the table, seated or watching, Bots included; only nearness to the limit matters to a newcomer. */
function RoomNote({ placesTaken }: { placesTaken: number }) {
  const left = onlineTableCapacity - placesTaken;
  if (left > 3) return null;
  return <p className="join-room">{left <= 0 ? 'This table is full. Ask the Table Owner to make room.' : `Only ${left} ${left === 1 ? 'place is' : 'places are'} left at this table.`}</p>;
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
      <p className="muted">{table.options.hasTablePassword
        ? 'This table’s address is its Join Link. Anyone you send it to can join with the Table Password, then watch and take an open seat.'
        : 'This table’s address is its Join Link. Anyone you send it to can join, watch, and take an open seat.'}</p>
      <div className="link-field">
        <input aria-label="Join link" ref={field} readOnly value={link} onFocus={e => e.target.select()} />
        <button className="primary" data-autofocus onClick={() => void copyLink()}>{copy === 'copied' ? <><Icon name="check" size={18} />Copied</> : <><Icon name="link" size={18} />Copy link</>}</button>
        <p className="muted link-status" role="status">{copy === 'manual' ? 'Copying isn’t available here. The link is selected: copy it yourself.' : copy === 'copied' ? 'Copied. Paste it wherever your friends will see it.' : ''}</p>
      </div>
    </div>
  </Dialog>;
}
