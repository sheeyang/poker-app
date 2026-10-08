// Evaluate against all-in-browser.ts on 3008 and the Playground on 5178.
(async () => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const button = text => [...document.querySelectorAll('button')].find(element => element.textContent === text);
  const wait = async predicate => {
    const deadline = Date.now() + 10000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error('Browser condition timed out'); await new Promise(resolve => setTimeout(resolve, 25)); }
  };
  const click = async text => { await wait(() => button(text) && !button(text).disabled); button(text).click(); };
  const fill = async (name, value) => {
    const element = document.querySelector('[name="' + name + '"]'); check(element && !element.disabled, name + ' unavailable');
    Object.getOwnPropertyDescriptor(element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value').set.call(element, String(value));
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 50));
  };
  const read = async () => (await fetch('/api/table-sessions/' + document.querySelector('.session-id').textContent)).json();
  const create = async count => {
    const oldId = document.querySelector('.session-id')?.textContent;
    await fill('seatCount', count); await fill('minimumBuyIn', 1); await fill('defaultBuyIn', 300); await fill('maximumBuyIn', 2000); await fill('botCount', count - 1);
    await click('Create Table Session'); await wait(() => document.querySelector('.session-id')?.textContent && document.querySelector('.session-id').textContent !== oldId);
    return read();
  };
  const seat = async (id, number, amount, revision) => {
    await fill('participantId', id); await fill('seat', number); await fill('buyIn', amount); await click('Seat Participant');
    await wait(() => document.querySelector('.table-facts').textContent.includes('Poker ' + revision + ' ·'));
  };
  await wait(() => document.body.textContent.includes('Local identity ready'));
  const created = await create(3); const [human, bob, carol] = created.bindings.map(b => b.participantId);
  await seat(human, 1, 100, 1); await seat(bob, 2, 300, 2); await seat(carol, 3, 300, 3);
  await click('Start Hand'); await wait(() => document.querySelector('[name="raiseTo"]') && !document.querySelector('[name="raiseTo"]').disabled);
  check((await read()).view.state.participants.filter(p => p.holeCards).length === 1, 'Opponent cards exposed before all-in');
  await fill('raiseTo', 100); await click('Raise-to');
  await wait(() => document.querySelector('.hand-controls').textContent.includes('Hand completed'));
  const done = await read();
  check(done.pokerRevision === 7 && done.view.state.board.join(' ') === 'Td Qh 5c Ad 4s', 'Runout/revision mismatch');
  check(done.view.state.participants.map(p => p.stack).join(',') === '0,700,0', 'Layered settlement mismatch');
  const layers = [...document.querySelectorAll('.pot-layers li')].map(p => p.textContent);
  check(layers.length === 2 && layers[0].includes('Main pot') && layers[0].includes('300 chips') && layers[0].includes('You, Bot 1, Bot 2') && layers[1].includes('Side pot 1') && layers[1].includes('400 chips') && layers[1].includes('Bot 1, Bot 2') && !layers[1].includes('You'), 'Authoritative pot layers/eligibility missing');
  check(document.querySelector('.seats').textContent.includes('All-in'), 'All-in status missing');
  check(document.querySelector('.seats').textContent.includes('Rebuy to play the next Hand'), 'Zero-stack eligibility missing');
  check(button('Start Hand').disabled, 'Zero-stack table unexpectedly ready');
  check(done.view.history[0].decisions.every(d => d.state.participants.filter(p => p.holeCards).length === 1), 'Showdown leaked into historical decisions');
  await click('Disconnect live updates'); await wait(() => document.body.textContent.includes('Live updates disconnected'));
  await click('Reconnect live updates'); await wait(() => document.body.textContent.includes('Live updates connected'));
  check((await read()).pokerRevision === 7, 'Reconnect changed play');
  await fill('managedParticipantId', human); await fill('targetStack', 100); await click('Rebuy to target');
  await wait(() => button('Top up to target') && !button('Start Hand').disabled);
  const rebought = await read(); check(rebought.pokerRevision === 8 && rebought.view.state.handId === 'hand-1', 'Rebuy started a Hand automatically');
  await click('Start Hand'); await wait(() => document.querySelector('#hand-heading').textContent === 'Hand 2');
  const next = await read(); check(next.view.state.handId === 'hand-2' && next.view.state.participants.filter(p => p.inHand).length === 2 && !next.view.state.participants.find(p => p.participantId === carol).inHand, 'Zero stack included in next Hand');
  const returnedTable = await create(2); const [short, deep] = returnedTable.bindings.map(b => b.participantId);
  await seat(short, 2, 100, 1); await seat(deep, 1, 300, 2); await click('Start Hand');
  await wait(() => button('Call 80 chips') && !button('Call 80 chips').disabled);
  check(document.querySelector('.seats').textContent.includes('All-in'), 'Live all-in status missing');
  check((await read()).view.state.participants.filter(p => p.holeCards).length === 1, 'Outstanding Call revealed opponent early');
  await click('Call 80 chips'); await wait(() => document.querySelector('.hand-controls').textContent.includes('Hand completed'));
  const returned = await read();
  check(returned.view.state.pots.length === 1 && returned.view.state.pots[0].amount === 200, 'Unmatched excess became a side pot');
  check(document.querySelector('.hand-controls').textContent.includes('200 uncalled chips returned to Bot 1'), 'Returned chips missing');
  check(returned.view.state.participants.map(p => p.stack).join(',') === '0,400', 'Return settlement changed bankroll');
  return { passed: true, layeredTableId: created.tableSessionId, returnedTableId: returnedTable.tableSessionId, board: done.view.state.board, stacks: [0, 700, 0], pots: [300, 400], returned: 200, cases: ['legal Raise-to', 'outstanding capped Call', 'pot eligibility', 'all-in status', 'automatic runout', 'showdown privacy', 'zero-stack ineligibility', 'actual-play rebuy', 'explicit next Hand', 'reconnect', 'unmatched return'] };
})
