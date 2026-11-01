import { useState } from 'react';
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

export function DisplayNameForm({ current, submitLabel = 'Save name', onSaved }: { current?: string; submitLabel?: string; onSaved?: (name: string) => void }) {
  const [value, setValue] = useState(current ?? '');
  const save = useSaveDisplayName(onSaved);
  const reason = save.error instanceof RequestFailure ? save.error.message : save.error ? 'Couldn’t save your name. Try again.' : undefined;
  return <form className="inline-form" onSubmit={e => { e.preventDefault(); save.mutate(value); }}>
    <label>Display name<input name="displayName" value={value} maxLength={40} autoComplete="nickname" required aria-describedby="display-name-hint" aria-invalid={!!reason} onChange={e => { setValue(e.target.value); if (save.error) save.reset(); }} /></label>
    <button className="primary" disabled={save.isPending || !value.trim()}>{save.isPending ? 'Saving…' : submitLabel}</button>
    <p id="display-name-hint" className={reason ? 'notice-error' : 'muted'} role={reason ? 'alert' : undefined}>{reason ?? hint}</p>
  </form>;
}

/** Shown before a Guest's first table creation. */
export function DisplayNamePrompt({ onSaved, close }: { onSaved: (name: string) => void; close: () => void }) {
  return <Dialog title="What should we call you?" close={close}>
    <p className="muted">Your name appears at the tables you create or join. You can change it later for future tables.</p>
    <DisplayNameForm submitLabel="Save and start" onSaved={onSaved} />
  </Dialog>;
}
