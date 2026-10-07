// Evaluate this function in the Playground after seating a human and one Bot and starting a Hand.
// The API target must be apps/server/test/fixtures/sizing-browser.ts.
(async () => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const button = text => [...document.querySelectorAll('button')].find(element => element.textContent === text);
  const click = text => { const element = button(text); check(element && !element.disabled, text + ' unavailable'); element.click(); };
  const wait = async predicate => {
    const deadline = Date.now() + 10000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error('Browser condition timed out'); await new Promise(resolve => setTimeout(resolve, 25)); }
  };
  const input = () => document.querySelector('.sized-action input');
  const setSize = async value => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 50));
  };
  const id = document.querySelector('.session-id').textContent;
  const read = async () => (await fetch('/api/table-sessions/' + id)).json();
  const initial = await read();
  check(initial.pokerRevision === 3 && initial.bindings.length === 2, 'Expected the first human preflop decision');
  check(input().min === '40' && input().max === '1000', 'Raise-to bounds mismatch');
  check(document.querySelector('.sized-action label').textContent === 'Raise-to total (chips)', 'Raise-to label missing');
  check(document.querySelector('.seats').textContent.includes('2 hidden cards'), 'Opponent is exposed before showdown');
  await setSize('53'); click('Raise-to');
  await wait(() => button('Bet-to') && !button('Bet-to').disabled);
  const flop = await read();
  check(flop.pokerRevision === 6 && flop.view.state.street === 'flop', 'Raise did not resolve through the Bot Call and Check');
  check(flop.view.state.participants.every(p => p.stack === 947 && p.contribution === 53 && p.wager === 0), 'Raise-to was interpreted as additional chips');
  check(input().min === '20' && input().max === '947', 'Bet-to street reset bounds mismatch');
  await setSize('19');
  check(!input().checkValidity(), 'Native size field accepted a below-minimum total');
  await setSize('37'); click('Bet-to');
  await wait(() => button('Check') && !button('Check').disabled && document.querySelector('.hand-controls').textContent.includes('turn'));
  const turn = await read();
  check(turn.pokerRevision === 9 && turn.view.state.street === 'turn', 'Bet did not advance through the Bot Call and Check');
  check(turn.view.state.participants.every(p => p.stack === 910 && p.contribution === 90 && p.wager === 0), 'Bet-to total or street reset mismatch');
  click('Check');
  await wait(() => button('Check') && !button('Check').disabled && document.querySelector('.hand-controls').textContent.includes('river'));
  click('Check');
  await wait(() => document.querySelector('.hand-controls').textContent.includes('Hand completed') && !button('Start Hand').disabled);
  const completed = await read();
  check(completed.pokerRevision === 12 && completed.sessionRevision === 12, 'Unexpected final revisions');
  check(completed.view.state.board.length === 5 && completed.view.state.participants.every(p => p.holeCards.length === 2), 'Showdown cards missing');
  check(completed.view.state.participants.reduce((sum, p) => sum + p.stack, 0) === 2000, 'Bankroll changed');
  check(completed.view.state.payouts.reduce((sum, p) => sum + p.amount, 0) === 180, 'Pot settlement mismatch');
  click('Disconnect live updates');
  await wait(() => document.body.textContent.includes('Live updates disconnected'));
  click('Reconnect live updates');
  await wait(() => document.body.textContent.includes('Live updates connected'));
  check((await read()).pokerRevision === 12, 'Reconnect changed accepted play');
  return { passed: true, tableSessionId: id, pokerRevision: 12, sessionRevision: 12, board: completed.view.state.board, stacks: completed.view.state.participants.map(p => p.stack), pot: 180, cases: ['Raise-to interior total', 'Bet-to interior total', 'server bounds', 'street reset', 'native integer bounds', 'showdown', 'conservation', 'reconnect'] };
})
