import { AttemptRecovery } from './recovery.js';
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { baselinePlayingStrategy, highestProbabilityPlayingStrategy, type ObservableTableSession, type ParticipantBinding, type TableRuntimeStatus } from '@poker/contracts';
import { api, RequestFailure } from './api.js';
import { usePlayground, type PendingController } from './store.js';

export const baselineOptions = [
  { value: 'seeded-sampling', label: 'Uniform Choice + Probability Selector · v1' },
  { value: 'highest-probability', label: 'Uniform Choice + Highest Probability Selector · v1' },
] as const;
export function BotControls({ table, status }: { table: ObservableTableSession; status?: TableRuntimeStatus['status'] }) {
  const bots = table.bindings.filter(binding => binding.controller.kind === 'bot');
  if (!bots.length) return null;
  return <section className="bot-controls" aria-labelledby="bots-heading">
    <h3 id="bots-heading">Bot Playing Strategies</h3>
    <p className="help">Uniform Choice gives equal probability to legal actions and minimum/maximum sizes. It is a testing baseline with no claim of poker expertise.</p>
    {bots.map(binding => <BotStrategy key={binding.participantId} table={table} binding={binding} status={status?.phase === 'recovering' || status?.participantId === binding.participantId ? status : undefined} />)}
  </section>;
}
function BotStrategy({ table, binding, status }: { table: ObservableTableSession; binding: ParticipantBinding; status?: TableRuntimeStatus['status'] }) {
  const selector = binding.controller.kind === 'bot' ? binding.controller.playingStrategy.selector.id : 'seeded-sampling';
  const [selected, setSelected] = useState(selector);
  useEffect(() => { setSelected(selector); }, [selector]);
  const queryClient = useQueryClient();
  const pending = usePlayground(state => state.pendingController);
  const setPending = usePlayground(state => state.setPendingController);
  const ownPending = pending?.tableSessionId === table.tableSessionId && pending.request.participantId === binding.participantId ? pending : null;
  const mutation = useMutation({
    mutationFn: (attempt: PendingController) => attempt.kind === 'retry-bot' ? api.retryBot(attempt.tableSessionId, attempt.request) : api.setPlayingStrategy(attempt.tableSessionId, attempt.request),
    retry: false,
    onSuccess: async (_result, attempt) => { setPending(null); await queryClient.invalidateQueries({ queryKey: ['table-session', attempt.tableSessionId] }); },
    onError: async (error, attempt) => { if (error instanceof RequestFailure && error.definitive) setPending(null); await queryClient.invalidateQueries({ queryKey: ['table-session', attempt.tableSessionId] }); },
  });
  function submit(kind: PendingController['kind']) {
    const metadata = { requestId: crypto.randomUUID(), expectedSessionRevision: table.sessionRevision, participantId: binding.participantId };
    const attempt: PendingController = kind === 'retry-bot' ? { tableSessionId: table.tableSessionId, kind, request: metadata } : { tableSessionId: table.tableSessionId, kind, request: { ...metadata, playingStrategy: selected === 'highest-probability' ? highestProbabilityPlayingStrategy : baselinePlayingStrategy } };
    setPending(attempt); mutation.mutate(attempt);
  }
  const current = table.view.state.actorId === binding.participantId;
  const paused = status?.phase === 'recovering' || mutation.error instanceof RequestFailure && ['commit-outcome-unknown', 'session-recovering'].includes(mutation.error.code);
  return <div className="bot-strategy">
    <form className="bot-strategy-fields" onSubmit={event => { event.preventDefault(); submit('set-playing-strategy'); }}>
      <label>{binding.name} Playing Strategy<select name={'strategy-' + binding.participantId} value={selected} onChange={event => setSelected(event.target.value)} disabled={mutation.isPending || !!pending || paused}>
        {baselineOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select></label>
      <button type="submit" disabled={selected === selector || mutation.isPending || !!pending || paused}>Save Playing Strategy</button>
    </form>
    {status?.phase === 'thinking' && current && <p role="status">{binding.name} is thinking…</p>}
    {status?.phase === 'failed' && current && <div className="bot-failure">
      <p role="alert" className="error">{binding.name} could not act. {status.message}</p>
      <button disabled={mutation.isPending || !!pending || paused} onClick={() => submit('retry-bot')}>Retry {binding.name} decision</button>
    </div>}
    {mutation.isPending && <p role="status">{mutation.variables?.kind === 'retry-bot' ? 'Requesting this Bot decision again…' : 'Saving Playing Strategy…'}</p>}
    {mutation.isSuccess && <p role="status" className="success">{mutation.variables?.kind === 'retry-bot' ? 'Bot retry accepted.' : 'Playing Strategy saved.'}</p>}
    {mutation.error && <p role="alert" className="error">{mutation.error instanceof RequestFailure && mutation.error.code === 'commit-not-applied' ? 'Attempt did not commit. ' : mutation.error instanceof RequestFailure && mutation.error.definitive ? 'Controller request rejected. ' : 'Controller request awaiting confirmation. '}{mutation.error.message}</p>}
    {ownPending && !mutation.isPending && <AttemptRecovery error={mutation.error} check={() => mutation.mutate(ownPending)} dismiss={() => { setPending(null); mutation.reset(); }} />}
  </div>;
}
