import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons.js';
import { browserBinding, DisplayNameForm, useDisplayName } from './display-name.js';

const initialOf = (name: string | undefined) => name?.trim()[0]?.toUpperCase();

/**
 * The Guest's profile: the name they sit down with. Reachable from every page, so it opens
 * from the header; Table options holds only what is about one table.
 */
export function MySettings() {
  const [open, setOpen] = useState(false);
  const { displayName } = useDisplayName();
  const box = useRef<HTMLSpanElement>(null), trigger = useRef<HTMLButtonElement>(null);
  // A popover under its button, not a modal: a click outside or Escape closes it, and focus goes back to the button.
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    const onEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('mousedown', outside); document.addEventListener('keydown', onEscape);
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', onEscape); };
  }, [open]);
  return <span className="profile-anchor" ref={box}>
    <button type="button" ref={trigger} className="identity-avatar" aria-haspopup="dialog" aria-expanded={open} aria-label={`Profile, ${displayName ?? 'name not set'}`} title={displayName ?? 'Set your name'} onClick={() => setOpen(!open)}>{initialOf(displayName) ?? '?'}</button>
    {open && <ProfilePopover displayName={displayName} close={() => { setOpen(false); trigger.current?.focus(); }} />}
  </span>;
}

function ProfilePopover({ displayName, close }: { displayName: string | undefined; close: () => void }) {
  return <div className="profile-pop" role="dialog" aria-labelledby="profile-title">
    <div className="profile-pop-heading"><h2 id="profile-title">Profile</h2><button type="button" className="icon-button" aria-label="Close Profile" onClick={close}><Icon name="close" /></button></div>
    <div className="profile-hero">
      <span className="profile-avatar" aria-hidden="true">{initialOf(displayName) ?? '?'}</span>
      <div><DisplayNameForm current={displayName} autoFocus /></div>
    </div>
    <p className="muted profile-note">Your name applies to tables you create or join from now on, not to tables you are already at.</p>
    {!displayName && <p className="muted profile-note">{browserBinding}</p>}
  </div>;
}
