import { useEffect, useRef } from 'react';
import { api } from '@poker/client';
import type { ObservableTableSession } from '@poker/contracts';
import { useSession, type Command } from './session.js';
import { practiceStep } from './practice-plan.js';

/** Start practice authorizes seating and the first explicit Start Hand.
 * Each operation retains durable, same-request-ID recovery semantics. */
export function usePracticeSetup(table: ObservableTableSession | undefined, command: Command) {
  const setup = useSession(s => s.setup);
  const running = useRef(false);
  useEffect(() => {
    if (!setup?.tableId || setup.paused || setup.tableId !== table?.tableSessionId || command.busy || running.current) return;
    const tableId = setup.tableId;
    running.current = true;
    void (async () => {
      try {
        for (;;) {
          if (useSession.getState().setup?.tableId !== tableId) return;
          const latest = await api.readSession(tableId);
          const step = practiceStep(latest, setup.afterHandId, crypto.randomUUID());
          if (!step) break;
          await command.run(step);
          if (step.kind === 'start') break;
        }
        useSession.getState().setSetup(null);
      } catch (error) {
        if (useSession.getState().setup?.tableId === tableId) useSession.getState().setSetup({ ...setup, paused: error instanceof Error ? error.message : 'Setup paused. Your seated players are saved.' });
      } finally { running.current = false; }
    })();
  }, [setup, table?.tableSessionId, table?.pokerRevision, command.busy]);
  return setup;
}
