import { forwardRef, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { tablePasswordLength } from '@poker/contracts';

type PasswordFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'id'> & {
  readonly id: string;
  readonly label: ReactNode;
  /** What sits under the field: a hint or the reason it was turned down, already given its own id. */
  readonly note?: ReactNode;
};

/**
 * A Table Password field: its label, the input, hidden as it is typed, with a Show control inside its right edge, and
 * an optional note under it. The password is case-sensitive and usually read out or pasted from a message, so the
 * Guest can check what they typed. The label names only the input, never the control. The value lives only in its
 * form's memory; nothing here reaches browser storage.
 */
export const PasswordField = forwardRef<HTMLInputElement, PasswordFieldProps>(function PasswordField({ id, label, note, className, ...input }, ref) {
  const [shown, setShown] = useState(false);
  return <div className={['password-row', className].filter(Boolean).join(' ')}>
    <label htmlFor={id}>{label}</label>
    <span className="password-field">
      <input ref={ref} id={id} {...input} type={shown ? 'text' : 'password'} maxLength={tablePasswordLength.maximum} spellCheck={false} autoCapitalize="off" autoCorrect="off" />
      <button type="button" className="password-toggle" aria-controls={id} disabled={input.disabled} onClick={() => setShown(!shown)}>{shown ? 'Hide' : 'Show'}<span className="visually-hidden"> password</span></button>
    </span>
    {note}
  </div>;
});
