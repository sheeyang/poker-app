import { useState } from 'react';
import { Dialog } from './dialog.js';
import { DisplayNameForm, useDisplayName } from './display-name.js';
import { useSession } from './session.js';

/**
 * Settings that belong to the Guest, not to a table: how cards animate, and the name they sit down with.
 * Reachable from every page; Table options holds only what is about one table.
 */
export function MySettings() {
  const [open, setOpen] = useState(false);
  const { displayName } = useDisplayName();
  const animations = useSession(s => s.animations), setAnimations = useSession(s => s.setAnimations);
  return <>
    <button type="button" className="quiet-button identity-button" aria-haspopup="dialog" onClick={() => setOpen(true)}>{displayName && <span className="identity-initial" aria-hidden="true">{displayName.trim()[0]?.toUpperCase()}</span>}<span>{displayName || 'My settings'}</span></button>
    {open && <Dialog title="My settings" close={() => setOpen(false)}>
      <section className="settings-section"><h3>Presentation</h3><label className="check-label"><input type="checkbox" checked={animations} onChange={event => setAnimations(event.target.checked)} />Card animations</label></section>
      <section className="settings-section"><h3>Your name</h3><p className="muted">Applies to tables you create or join from now on, not to tables you are already at.</p><DisplayNameForm current={displayName} /></section>
    </Dialog>}
  </>;
}
