// Evaluate after seating You at 7, Bot 1 at 9, Bot 2 at 2 and starting with button 7.
// Use the sizing-browser.ts trusted fixture on 3007 and Playground on 5177.
(async () => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const button = text => [...document.querySelectorAll('button')].find(element => element.textContent === text);
  const click = text => { const element = button(text); check(element && !element.disabled, text + ' unavailable'); element.click(); };
  const wait = async predicate => {
    const deadline = Date.now() + 10000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error('Browser condition timed out'); await new Promise(resolve => setTimeout(resolve, 25)); }
  };
  const id = document.querySelector('.session-id').textContent;
  const read = async () => (await fetch('/api/table-sessions/' + id)).json();
  const initial = await read();
  check(initial.pokerRevision === 5 && initial.bindings.length === 3, 'Expected first sparse human decision');
  check(document.querySelectorAll('.seats > li').length === 9, 'Configured seats missing');
  check(initial.view.state.participants.map(p => p.seat).join(',') === '7,9,2', 'Sparse seating mismatch');
  check(initial.view.state.participants.every(p => p.anteContribution === 5), 'Public ante contributions missing');
  check(button('Call 20 chips') && initial.view.state.amountToCall === 20, 'Ante incorrectly reduces the blind Call');
  check(initial.view.state.participants.filter(p => p.holeCards).length === 1, 'Opponent cards exposed');
  check([...document.querySelectorAll('.seats > li')].find(li => li.textContent.includes('Seat 9')).textContent.includes('Small blind'), 'Small blind marker missing');
  check([...document.querySelectorAll('.seats > li')].find(li => li.textContent.includes('Seat 2')).textContent.includes('Big blind'), 'Big blind marker missing');
  click('Call 20 chips');
  for (const [index, street] of ['flop', 'turn', 'river'].entries()) {
    await wait(() => button('Check') && !button('Check').disabled && document.querySelector('.hand-controls').textContent.includes(street));
    const view = await read();
    check(view.pokerRevision === 10 + index * 3 && view.view.state.board.length === index + 3, 'Multiway street or action order mismatch');
    check(view.view.state.participants.every(p => p.stack === 975 && p.contribution === 25 && p.wager === 0), 'Street wagers include antes or failed to reset');
    check(view.view.state.participants.filter(p => p.holeCards).length === 1, 'Cards exposed before showdown');
    click('Check');
  }
  await wait(() => document.querySelector('.hand-controls').textContent.includes('Hand completed') && !button('Start Hand').disabled);
  const completed = await read();
  check(completed.pokerRevision === 17 && completed.sessionRevision === 17, 'Unexpected final revisions');
  check(completed.view.state.participants.every(p => p.holeCards.length === 2), 'Required showdown cards missing');
  check(completed.view.state.participants.reduce((sum, p) => sum + p.stack, 0) === 3000, 'Bankroll changed');
  check(completed.view.state.payouts.reduce((sum, p) => sum + p.amount, 0) === 75, 'Ante-inclusive settlement mismatch');
  check(completed.view.history[0].decisions[0].state.participants.filter(p => p.holeCards).length === 1, 'Showdown leaked into prior decision');
  click('Disconnect live updates'); await wait(() => document.body.textContent.includes('Live updates disconnected'));
  click('Reconnect live updates'); await wait(() => document.body.textContent.includes('Live updates connected'));
  check((await read()).pokerRevision === 17, 'Reconnect changed accepted play');
  return { passed: true, tableSessionId: id, pokerRevision: 17, sessionRevision: 17, board: completed.view.state.board, stacks: completed.view.state.participants.map(p => p.stack), pot: 75, cases: ['nine visible seats', 'sparse position', 'capped ante facts', 'Call excludes ante', 'all streets', 'hidden cards', 'showdown', 'conservation', 'historical privacy', 'reconnect'] };
})
