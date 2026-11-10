import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons.js';
import { DisplayNameForm, useDisplayName } from './display-name.js';
import { useSession } from './session.js';

const initialOf = (name: string | undefined) => name?.trim()[0]?.toUpperCase();

/**
 * The Guest's profile: the name they sit down with and how cards animate. Reachable from every page, so it opens
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
    <button type="button" ref={trigger} className="identity-avatar" aria-haspopup="dialog" aria-expanded={open} aria-label={`Profile, ${displayName ?? 'name not set'}. Progress saved automatically.`} title={`${displayName ?? 'Set your name'} · Progress saved automatically`} onClick={() => setOpen(!open)}>{initialOf(displayName) ?? '?'}</button>
    {open && <ProfilePopover displayName={displayName} close={() => { setOpen(false); trigger.current?.focus(); }} />}
  </span>;
}

function ProfilePopover({ displayName, close }: { displayName: string | undefined; close: () => void }) {
  const animations = useSession(s => s.animations), setAnimations = useSession(s => s.setAnimations);
  // Each click on the card, or on the switch, replays the deal so the switch shows what it does.
  const [plays, setPlays] = useState(0);
  return <div className="profile-pop" role="dialog" aria-labelledby="profile-title">
    <div className="profile-pop-heading"><h2 id="profile-title">Profile</h2><button type="button" className="icon-button" aria-label="Close Profile" onClick={close}><Icon name="close" /></button></div>
    <div className="profile-hero">
      <span className="profile-avatar" aria-hidden="true">{initialOf(displayName) ?? '?'}</span>
      <div><DisplayNameForm current={displayName} autoFocus /></div>
    </div>
    <p className="muted profile-note">Your name applies to tables you create or join from now on, not to tables you are already at.</p>
    <section className="settings-section">
      <h3>Cards</h3>
      <div className="profile-preview">
        <button type="button" key={plays} className={`profile-card${animations ? ' is-animated' : ''}`} aria-label="Preview the card animation" onClick={() => setPlays(plays + 1)}><span>A♠</span></button>
        <label className="live-toggle"><span><strong>Card animations</strong><small>{animations ? 'Cards deal and flip. Click the card to preview.' : 'Cards appear at once.'}</small></span><input type="checkbox" role="switch" checked={animations} onChange={event => { setAnimations(event.target.checked); setPlays(plays + 1); }} /></label>
      </div>
    </section>
    <p className="muted profile-foot">Progress is saved automatically on this device.</p>
  </div>;
}
