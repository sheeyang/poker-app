import { useEffect, useRef, useState } from 'react';
import type { ObservableTableSession } from '@poker/contracts';
import { ContextMenu, type ContextMenuItem } from './context-menu.js';
import { participantActions, seatActions, type ParticipantAction, type SeatAction } from './participant-actions.js';
import { AddBotDialog, ParticipantDialog, type ParticipantTask } from './participant-dialogs.js';
import { TakeSeatDialog } from './take-seat.js';
import { openSeats } from './owner-controls.js';
import { playerName } from './table-model.js';
import type { Command } from './session.js';

type Menu = { kind: 'seat'; seat: number; anchor: HTMLElement } | { kind: 'participant'; participantId: string; anchor: HTMLElement };
type Task = { kind: 'take-seat'; seat: number; participantId: string } | { kind: 'add-bot'; seat: number } | { kind: ParticipantTask; participantId: string };

export function useTableInteractions(table: ObservableTableSession | undefined, command: Command, handOpen: boolean) {
  const [menu, setMenu] = useState<Menu | null>(null), [task, setTask] = useState<Task | null>(null);
  const [choosing, setChoosing] = useState<string | null>(null);
  const previousTable = useRef(table?.tableSessionId), trigger = useRef<HTMLElement | null>(null);
  useEffect(() => { if (previousTable.current !== table?.tableSessionId) { setMenu(null); setTask(null); setChoosing(null); previousTable.current = table?.tableSessionId; } }, [table?.tableSessionId]);
  const focusTrigger = () => requestAnimationFrame(() => { if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true }); else document.getElementById('main-table')?.focus({ preventScroll: true }); });
  const closeMenu = (restore = true) => { setMenu(null); if (restore) focusTrigger(); };
  const closeTask = () => { setTask(null); focusTrigger(); };
  const chooseSeats = (participantId = table?.viewerParticipantId) => {
    if (!table || !participantId) return;
    setMenu(null); setTask(null); setChoosing(participantId);
    const first = openSeats(table)[0];
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-table-seat="${first}"] .empty-seat`)?.focus());
  };
  const openSeat = (seat: number, anchor: HTMLElement) => { trigger.current = anchor; setMenu({ kind: 'seat', seat, anchor }); };
  const openParticipant = (participantId: string, anchor: HTMLElement) => { trigger.current = anchor; setMenu({ kind: 'participant', participantId, anchor }); };
  const rebuy = () => { if (table) { trigger.current = document.activeElement as HTMLElement; setTask({ kind: 'stack', participantId: table.viewerParticipantId }); } };
  const leave = () => { if (table) { trigger.current = document.activeElement as HTMLElement; selectParticipantAction('leave', table.viewerParticipantId); } };
  const blocked = command.busy || table?.runtimeStatus?.phase === 'recovering';
  function manage(participantId: string, operation: 'set-sitting-out' | 'stand-up-participant' | 'move-participant', fields: { sittingOut?: boolean; seat?: number } = {}) {
    if (!table || blocked) return;
    command.submit({ tableId: table.tableSessionId, kind: 'manage', operation, body: { requestId: crypto.randomUUID(), expectedPokerRevision: table.pokerRevision, participantId, ...fields } });
    setMenu(null); setChoosing(null);
  }
  function selectParticipantAction(action: ParticipantAction, participantId: string) {
    if (!table || blocked || !participantActions(table, participantId, handOpen).some(item => item.id === action && item.timing !== 'unavailable')) return;
    if (action === 'choose-seat' || action === 'move') { chooseSeats(participantId); return; }
    if (action === 'sit-out' || action === 'resume') { manage(participantId, 'set-sitting-out', { sittingOut: action === 'sit-out' }); return; }
    if (action === 'stand-up') { manage(participantId, 'stand-up-participant'); return; }
    setMenu(null); setTask({ kind: action, participantId });
  }
  function selectSeatAction(action: SeatAction, seat: number) {
    if (!table || blocked) return;
    const participantId = choosing ?? table.viewerParticipantId;
    if (!seatActions(table, seat, handOpen, participantId).some(item => item.id === action && item.timing !== 'unavailable')) return;
    if (action === 'move') manage(participantId, 'move-participant', { seat });
    else { setMenu(null); setTask(action === 'add-bot' ? { kind: 'add-bot', seat } : { kind: 'take-seat', participantId, seat }); setChoosing(null); }
  }
  let items: ContextMenuItem[] = [], title = '';
  if (table && menu) {
    if (menu.kind === 'seat') { title = `Seat ${menu.seat}`; items = seatActions(table, menu.seat, handOpen, choosing ?? undefined).map(action => ({ ...action, disabled: blocked || action.timing === 'unavailable', action: () => selectSeatAction(action.id, menu.seat) })); }
    else { const binding = table.bindings.find(b => b.participantId === menu.participantId); title = binding ? playerName(table, binding) : 'Participant'; items = participantActions(table, menu.participantId, handOpen).map(action => ({ ...action, disabled: blocked || action.timing === 'unavailable', action: () => selectParticipantAction(action.id, menu.participantId) })); }
  }
  const overlays = table && <>
    {menu && <ContextMenu key={`${menu.kind}-${menu.kind === 'seat' ? menu.seat : menu.participantId}`} anchor={menu.anchor} title={title} items={items} close={closeMenu} />}
    {task?.kind === 'take-seat' && <TakeSeatDialog key={`seat-${task.participantId}-${task.seat}`} table={table} seat={task.seat} participantId={task.participantId} command={command} handOpen={handOpen} close={closeTask} chooseAgain={() => chooseSeats(task.participantId)} />}
    {task?.kind === 'add-bot' && <AddBotDialog key={`bot-${task.seat}`} table={table} seat={task.seat} command={command} handOpen={handOpen} close={closeTask} chooseAgain={() => chooseSeats()} />}
    {task && task.kind !== 'take-seat' && task.kind !== 'add-bot' && <ParticipantDialog key={`${task.kind}-${task.participantId}`} table={table} participantId={task.participantId} task={task.kind} command={command} handOpen={handOpen} close={closeTask} />}
  </>;
  return { openSeat, openParticipant, chooseSeats, rebuy, leave, choosing, cancelChoosing: () => setChoosing(null), overlays };
}
