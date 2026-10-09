import { RequestFailure } from './api.js';

export function AttemptRecovery({ error, check, dismiss }: { error: Error | null; check: () => void; dismiss: () => void }) {
  const code = error instanceof RequestFailure ? error.code : undefined;
  const noncommit = code === 'commit-not-applied';
  const recovering = code === 'commit-outcome-unknown' || code === 'session-recovering';
  return <div className="pending-attempt">
    <p>{noncommit ? 'The table shows confirmed state. Start a new attempt when ready.' : recovering ? 'The outcome is still being resolved. The table shows only confirmed state. Check this attempt to retrieve its result.' : 'The outcome is unconfirmed. Check this same attempt before continuing.'}</p>
    <button onClick={noncommit ? dismiss : check}>{noncommit ? 'Start a new attempt' : recovering ? 'Check attempt outcome' : 'Retry same attempt'}</button>
  </div>;
}
