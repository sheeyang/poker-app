import { useEffect, useState } from 'react';
import type { TimingPath } from '@poker/contracts';
import { setEdit, type Edits } from './motion-lab-edits.js';
import { dropSaved, exportPreview, exportTimings, keepFlagged, reconcile, saveEdits, type FlaggedEdit, type Saved } from './motion-lab-saved.js';

/** The motion lab's saved edits in the browser (ADR-0040): the pure rules are in `motion-lab-saved.ts`. */

const KEY = 'poker-motion-lab-edits';

function load(): Saved {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed as Saved : {};
  } catch { return {}; }
}

export interface SavedEdits {
  readonly edits: Edits;
  readonly flagged: readonly FlaggedEdit[];
  /** Notices for saved edits dropped because their timing no longer exists. */
  readonly notices: readonly TimingPath[];
  readonly edit: (path: TimingPath, value: number) => void;
  readonly keep: (path: TimingPath) => void;
  readonly drop: (path: TimingPath) => void;
  readonly dismissNotices: () => void;
}

/** The edits, kept in the browser. A flagged edit is held back from the replay until kept. */
export function useSavedEdits(): SavedEdits {
  const [initial] = useState(() => reconcile(load()));
  const [saved, setSaved] = useState<Saved>(initial.saved);
  const [notices, setNotices] = useState<readonly TimingPath[]>(initial.removed);
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* storage unavailable: edits last for the session */ } }, [saved]);
  const { edits, flagged } = reconcile(saved);
  return {
    edits, flagged, notices,
    edit: (path, value) => setSaved(current => saveEdits(current, setEdit(reconcile(current).edits, path, value))),
    keep: path => setSaved(current => keepFlagged(current, path)),
    drop: path => setSaved(current => dropSaved(current, path)),
    dismissNotices: () => setNotices([]),
  };
}

/** Flagged edits, notices, and the copy action with its preview. */
export function SavedEditsSection({ saved }: { saved: SavedEdits }) {
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null);
  const [open, setOpen] = useState(false);
  const preview = exportPreview(saved.edits);
  useEffect(() => setCopied(null), [saved.edits]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(exportTimings(saved.edits)); setCopied('copied'); } catch { setCopied('failed'); }
  };
  return <section className="lab-saved" aria-label="Saved edits and export">
    {saved.notices.length > 0 && <div className="lab-notice" role="status">
      <p>Dropped {saved.notices.length === 1 ? 'an edit to a timing that no longer exists' : `${saved.notices.length} edits to timings that no longer exist`}: {saved.notices.join(', ')}.</p>
      <button type="button" onClick={saved.dismissNotices}>Dismiss</button>
    </div>}
    {saved.flagged.map(f => <div key={f.path} className="lab-flagged" role="group" aria-label={`${f.path} changed in the code`}>
      <p><strong>{f.path}</strong> changed in the code from {f.base} ms to {f.committed} ms since you set it to {f.value} ms.</p>
      <div><button type="button" onClick={() => saved.keep(f.path)}>Keep {f.value} ms</button> <button type="button" onClick={() => saved.drop(f.path)}>Use {f.committed} ms</button></div>
    </div>)}
    <div className="lab-export">
      <button type="button" className="primary" disabled={preview.length === 0} onClick={() => { setOpen(true); void copy(); }}>Copy timing file</button>
      <span className="lab-panel-meta" role="status">{preview.length === 0 ? 'No changes to export' : copied === 'copied' ? 'Copied. Paste over timings.json.' : copied === 'failed' ? 'Copy failed' : `${preview.length} changed`}</span>
      {preview.length > 0 && <button type="button" className="lab-clear" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide changes' : 'Review changes'}</button>}
    </div>
    {open && preview.length > 0 && <ul className="lab-changes">{preview.map(c => <li key={c.path}><span>{c.path}</span><span><s>{c.old}</s> {c.value} ms</span></li>)}</ul>}
  </section>;
}
