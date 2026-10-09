// Evaluate with reopening-browser.ts on 3009 and Playground's proxy on 5179.
(async (options = {}) => {
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
  const setup = async price => {
    const previous = document.querySelector('.session-id')?.textContent;
    for (const [name, value] of [['seatCount', 5], ['minimumBuyIn', 1], ['defaultBuyIn', 1000], ['maximumBuyIn', 1000], ['botCount', 4]]) await fill(name, value);
    await click('Create Table Session'); await wait(() => document.querySelector('.session-id')?.textContent && document.querySelector('.session-id').textContent !== previous);
    const created = await read(); const ids = created.bindings.map(b => b.participantId);
    for (const [index, seat, stack] of [[0, 2, 1000], [1, 3, 170], [2, 4, 1000], [3, 5, price + 20], [4, 1, 1000]]) {
      await fill('participantId', ids[index]); await fill('seat', seat); await fill('buyIn', stack); await click('Seat Participant');
      await wait(() => document.querySelector('.table-facts').textContent.includes('Poker ' + (index + 1) + ' ·'));
    }
    await click('Start Hand'); await click('Call 10 chips');
    await wait(() => button('Bet-to') && !button('Bet-to').disabled);
    await fill('betTo', 100); await click('Bet-to');
    await wait(() => button('Call ' + (price - 100) + ' chips') && !button('Call ' + (price - 100) + ' chips').disabled);
    return { ids, before: await read() };
  };
  const play = async (price, pause = false) => {
    const { ids, before } = await setup(price); const minimum = price + 100;
    check(before.view.state.actorId === ids[0] && before.view.state.amountToCall === price - 100, 'Incorrect reopened human Call cost');
    check(before.view.state.participants.filter(p => p.allIn).length === 2, 'Short all-ins missing');
    check(before.view.state.participants.filter(p => p.holeCards).length === 1, 'Hidden cards leaked');
    if (price === 199) {
      check(!document.querySelector('[name="raiseTo"]') && !button('Raise-to'), 'Closed betting exposed Raise controls');
    } else {
      const input = document.querySelector('[name="raiseTo"]');
      check(input.min === String(minimum) && input.max === '980', 'Reopened inclusive bounds mismatch');
      await fill('raiseTo', minimum - 1); check(!input.checkValidity(), 'Below minimum native validation accepted');
      await fill('raiseTo', minimum);
    }
    // Ordinary same-origin HTTP checks complement the real controls; browser
    // never submits a Bot action or receives hidden controller authority.
    const request = { requestId: crypto.randomUUID(), expectedPokerRevision: before.pokerRevision, participantId: ids[0], action: { type: 'raise', raiseTo: price === 199 ? 299 : minimum - 1 } };
    const endpoint = '/api/table-sessions/' + before.tableSessionId + '/act';
    const post = body => fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    check((await post(request)).status === 400, 'Closed/below minimum Raise was accepted');
    check((await post({ ...request, requestId: crypto.randomUUID(), expectedPokerRevision: before.pokerRevision - 1 })).status === 409, 'Stale Raise was accepted');
    check(JSON.stringify(await read()) === JSON.stringify(before), 'Rejected command altered committed view');
    check((await post(request)).status === 400, 'Rejected retry changed outcome');
    if (pause) return { paused: true, tableSessionId: before.tableSessionId, pokerRevision: before.pokerRevision, call: price - 100, minimum: price === 199 ? null : minimum };
    if (price === 199) await click('Call 99 chips');
    else {
      await click('Raise-to'); await wait(() => button('Call 100 chips') && !button('Call 100 chips').disabled);
      check(document.querySelector('[name="raiseTo"]').min === String(price + 300), 'Next full-raise minimum reset incorrectly');
      await click('Call 100 chips');
    }
    for (const street of ['turn', 'river']) {
      await wait(() => button('Check') && !button('Check').disabled && document.querySelector('.hand-controls').textContent.includes(street));
      await click('Check');
    }
    await wait(() => document.querySelector('.hand-controls').textContent.includes('Hand completed'));
    const done = await read(); const state = done.view.state;
    check(state.handId === 'hand-1' && state.actorId === null, 'Unexpected automatic next Hand');
    check(state.board.join(' ') === 'Qh Qc Ad 9c 6c', 'Independent board vector mismatch');
    check(state.participants.reduce((sum, p) => sum + p.stack, 0) === 3190 + price, 'Chip conservation failed');
    check(state.participants.map(p => p.stack).join(',') === (price === 199 ? '1278,350,781,0,980' : price === 200 ? '1480,350,580,0,980' : '1482,350,579,0,980'), 'Independent tied main/side payouts mismatch');
    check(done.view.history[0].decisions.every(d => d.state.participants.filter(p => p.holeCards).length === 1), 'Historical visibility changed');
    return { price, tableSessionId: done.tableSessionId, pokerRevision: done.pokerRevision, sessionRevision: done.sessionRevision, call: price - 100, minimum: price === 199 ? null : minimum, board: state.board, stacks: state.participants.map(p => p.stack) };
  };
  await wait(() => document.body.textContent.includes('Local identity ready'));
  if (button('Start a new creation attempt')) await click('Start a new creation attempt');
  if (options.pausePrice) return await play(options.pausePrice, true);
  const results = [];
  for (const price of [199, 200, 201]) results.push(await play(price));
  await click('Disconnect live updates'); await wait(() => document.body.textContent.includes('Live updates disconnected'));
  await click('Reconnect live updates'); await wait(() => document.body.textContent.includes('Live updates connected'));
  check((await read()).pokerRevision === results[2].pokerRevision, 'Reconnect altered accepted play');
  window.reopeningBrowser = { setup: price => play(price, true), results };
  return { passed: true, results, cases: ['closed Call 99', 'equality Call 100/Raise-to 300', 'above Call 101/Raise-to 301', 'full raise reset', 'atomic rejection', 'stale revision', 'rejected retry', 'normal street closure', 'independent board/payouts', 'history privacy', 'conservation', 'reconnect'] };
})
