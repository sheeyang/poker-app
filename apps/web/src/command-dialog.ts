import { useEffect, useState } from 'react';
import type { Attempt, Command } from './session.js';

/** Close only after this exact request was accepted, including an explicit status check after lost confirmation. */
export function useCommandDialog(command: Command, close: () => void) {
  const [requestId, setRequestId] = useState<string>();
  useEffect(() => { if (requestId && command.confirmedRequestId === requestId) close(); }, [requestId, command.confirmedRequestId, close]);
  return (attempt: Attempt) => {
    if (command.busy) return;
    setRequestId(attempt.body.requestId);
    command.submit(attempt);
  };
}
