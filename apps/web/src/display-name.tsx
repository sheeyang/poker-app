import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, RequestFailure } from '@poker/client';
import { Dialog } from './dialog.js';

/** The Guest's stored display name; undefined until they choose one. */
export function useDisplayName() {
  const identity = useQuery({ queryKey: ['identity'], queryFn: api.establishIdentity });
  return { displayName: identity.data?.displayName, identity };
}

function useSaveDisplayName(onSaved?: (name: string) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.setDisplayName,
    onSuccess: async result => {
      queryClient.setQueryData(['identity'], { ok: true, displayName: result.displayName });
      onSaved?.(result.displayName);
    },
  });
}

const hint = 'Up to 20 letters, digits, spaces or basic punctuation.';

/** `autoFocus`: the form is the point of the dialog it sits in, so the name field takes focus when it opens. */
export function DisplayNameForm({ current, submitLabel = 'Save name', onSaved, autoFocus = false }: { current?: string; submitLabel?: string; onSaved?: (name: string) => void; autoFocus?: boolean }) {
  const [value, setValue] = useState(current ?? '');
  const save = useSaveDisplayName(onSaved);
  const reason = save.error instanceof RequestFailure ? save.error.message : save.error ? 'Couldn’t save your name. Try again.' : undefined;
  const id = useId();
  return <form className="name-form" onSubmit={e => { e.preventDefault(); save.mutate(value); }}>
    <label htmlFor={`${id}-name`}>Display name</label>
    <input id={`${id}-name`} name="displayName" value={value} maxLength={40} autoComplete="nickname" required aria-describedby={`${id}-hint`} aria-invalid={!!reason} data-autofocus={autoFocus || undefined} onChange={e => { setValue(e.target.value); if (save.error) save.reset(); }} />
    <button className="primary" disabled={save.isPending || !value.trim()}>{save.isPending ? 'Saving…' : submitLabel}</button>
    <p id={`${id}-hint`} className={reason ? 'notice-error' : 'muted'} role={reason ? 'alert' : undefined}>{reason ?? hint}</p>
  </form>;
}

/** Shown before a Guest's first table creation. */
export function DisplayNamePrompt({ onSaved, close }: { onSaved: (name: string) => void; close: () => void }) {
  return <Dialog title="What should we call you?" close={close}>
    <div className="dialog-stack">
      <p className="muted">Everyone at your tables sees this name. You can change it later for future tables.</p>
      <DisplayNameForm submitLabel="Save and start" onSaved={onSaved} autoFocus />
    </div>
  </Dialog>;
}
