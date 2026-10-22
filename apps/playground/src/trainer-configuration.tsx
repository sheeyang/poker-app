import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { baselinePlayingStrategy, highestProbabilityPlayingStrategy, type ObservableTableSession } from '@poker/contracts';
import { baselineOptions } from './bots.js';
import { api, RequestFailure } from './api.js';
import { AttemptRecovery } from './recovery.js';
import { usePlayground, type PendingTrainerConfiguration } from './store.js';

export function TrainerConfigurationControls({ table }: { table: ObservableTableSession }) {
  const configuration = table.trainerConfiguration;
  const selector = configuration.referenceStrategy.selector.id;
  const [selected, setSelected] = useState(selector);
  const [liveAnalysis, setLiveAnalysis] = useState(configuration.liveAnalysis);
  useEffect(() => { setSelected(selector); setLiveAnalysis(configuration.liveAnalysis); }, [selector, configuration.liveAnalysis]);
  const queryClient = useQueryClient();
  const pending = usePlayground(state => state.pendingTrainerConfiguration);
  const setPending = usePlayground(state => state.setPendingTrainerConfiguration);
  const ownPending = pending?.tableSessionId === table.tableSessionId ? pending : null;
  const mutation = useMutation({
    mutationFn: (attempt: PendingTrainerConfiguration) => api.setTrainerConfiguration(attempt.tableSessionId, attempt.request),
    retry: false,
    onSuccess: async (_result, attempt) => { setPending(null); await queryClient.invalidateQueries({ queryKey: ['table-session', attempt.tableSessionId] }); },
    onError: async (error, attempt) => { if (error instanceof RequestFailure && error.definitive) setPending(null); await queryClient.invalidateQueries({ queryKey: ['table-session', attempt.tableSessionId] }); },
  });
  const paused = table.runtimeStatus?.phase === 'recovering' || mutation.error instanceof RequestFailure && ['commit-outcome-unknown', 'session-recovering'].includes(mutation.error.code);
  const disabled = mutation.isPending || !!pending || paused;
  const committedStrategy = baselineOptions.find(option => option.value === selector)?.label ?? `${configuration.referenceStrategy.policy.id} + ${selector}`;
  return <section className="trainer-configuration" aria-labelledby="trainer-configuration-heading">
    <h3 id="trainer-configuration-heading">Reference Strategy and Live Analysis</h3>
    <p className="help">These settings apply to this Table Session and synchronize across your tabs.</p>
    <p>Committed Reference Strategy: {committedStrategy}. Live Analysis: {configuration.liveAnalysis ? 'On' : 'Off'}.</p>
    <form onSubmit={event => {
      event.preventDefault();
      const attempt: PendingTrainerConfiguration = { tableSessionId: table.tableSessionId, request: {
        requestId: crypto.randomUUID(), expectedSessionRevision: table.sessionRevision,
        trainerConfiguration: { referenceStrategy: selected === 'highest-probability' ? highestProbabilityPlayingStrategy : baselinePlayingStrategy, liveAnalysis },
      } };
      setPending(attempt); mutation.mutate(attempt);
    }}>
      <fieldset disabled={disabled}>
        <label>Reference Strategy<select name="referenceStrategy" value={selected} onChange={event => setSelected(event.target.value)}>
          {baselineOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select></label>
        <label className="checkbox"><input name="liveAnalysis" type="checkbox" checked={liveAnalysis} onChange={event => setLiveAnalysis(event.target.checked)} />Live Analysis</label>
        <button type="submit" disabled={selected === selector && liveAnalysis === configuration.liveAnalysis}>Save analysis settings</button>
      </fieldset>
    </form>
    {mutation.isPending && <p role="status">Saving analysis settings…</p>}
    {mutation.isSuccess && <p role="status" className="success">Analysis settings saved.</p>}
    {mutation.error && <p role="alert" className="error">{mutation.error instanceof RequestFailure && mutation.error.code === 'commit-not-applied' ? 'Analysis settings did not commit. ' : mutation.error instanceof RequestFailure && mutation.error.definitive ? 'Analysis settings rejected. ' : 'Analysis settings awaiting confirmation. '}{mutation.error.message}</p>}
    {ownPending && !mutation.isPending && <AttemptRecovery error={mutation.error} check={() => mutation.mutate(ownPending)} dismiss={() => { setPending(null); mutation.reset(); }} />}
  </section>;
}
