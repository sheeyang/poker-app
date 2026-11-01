import { CashGame } from '@poker/engine';
import type { Pool } from 'pg';

/**
 * Stand-in for Automatic Dealing, which a later ticket adds: Online Tables reject Deal, so tests that need a
 * Hand start one in the stored record. Call it while the server is stopped, then restart the server.
 */
export async function startStoredHand(administration: Pool, schema: string, tableSessionId: string) {
  const aggregate = (await administration.query(`SELECT aggregate FROM "${schema}".table_sessions WHERE id = $1`, [tableSessionId])).rows[0].aggregate;
  const restored = CashGame.fromRecord(aggregate.pokerRecord);
  if (!restored.ok) throw new Error(restored.rejection.message);
  const started = restored.game.startHand();
  if (!started.ok) throw new Error(started.rejection.message);
  const next = { ...aggregate, pokerRecord: restored.game.toRecord(), pokerRevision: aggregate.pokerRevision + 1, sessionRevision: aggregate.sessionRevision + 1 };
  await administration.query(`UPDATE "${schema}".table_sessions SET aggregate = $1 WHERE id = $2`, [JSON.stringify(next), tableSessionId]);
}
