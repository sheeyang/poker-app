// Use all-in-browser.ts with BROWSER_POT_BOUNDARIES=1 and Playground on 5178.
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
  const play = async live => {
    const oldId = document.querySelector('.session-id')?.textContent;
    for (const [name, value] of [['seatCount', 5], ['smallBlind', 1], ['bigBlind', 1], ['ante', 1], ['minimumBuyIn', 1], ['defaultBuyIn', live ? 1 : 10], ['maximumBuyIn', 100], ['botCount', 4]]) await fill(name, value);
    await click('Create Table Session'); await wait(() => document.querySelector('.session-id')?.textContent && document.querySelector('.session-id').textContent !== oldId);
    const created = await read(); const ids = created.bindings.map(b => b.participantId);
    for (const [index, seat, stack] of [[0, 2, 10], [1, 3, 10], [2, 5, live ? 2 : 10], [3, 1, live ? 1 : 10], [4, 4, live ? 1 : 10]]) {
      await fill('participantId', ids[index]); await fill('seat', seat); await fill('buyIn', stack); await click('Seat Participant');
      await wait(() => document.querySelector('.table-facts').textContent.includes('Poker ' + (index + 1) + ' ·'));
    }
    await click('Start Hand');
    for (const street of ['preflop', 'flop', 'turn', 'river']) {
      await wait(() => button('Check') && !button('Check').disabled && document.querySelector('.hand-controls').textContent.includes(street));
      const decision = await read();
      check(decision.view.state.participants.filter(p => p.holeCards).length === 1, 'Future showdown exposed at ' + street);
      if (live) check(decision.view.state.participants.filter(p => p.allIn).length === 3, 'Live short all-ins missing');
      await click('Check');
    }
    await wait(() => document.querySelector('.hand-controls').textContent.includes('Hand completed'));
    const done = await read(); const state = done.view.state;
    check(state.handId === 'hand-1' && state.actorId === null, 'Unexpected automatic next Hand');
    check(done.view.history[0].decisions.every(d => d.state.participants.filter(p => p.holeCards).length === 1), 'Historical cards changed');
    const pots = state.pots.map(p => p.amount); const payouts = state.payouts.map(p => p.amount); const layers = [...document.querySelectorAll('.pot-layers li')].map(p => p.textContent);
    if (live) {
      check(pots.join(',') === '5,3' && payouts.join(',') === '3,2,2,1', 'Genuine odd pots incorrectly merged');
      check(state.pots[0].eligibleParticipantIds.join(',') === ids.join(',') && state.pots[1].eligibleParticipantIds.join(',') === ids.slice(0, 3).join(','), 'Unequal live eligibility changed');
      check(state.participants.map(p => p.stack).join(',') === '13,11,0,0,0', 'Independent odd-chip payouts changed');
      check(layers.length === 2 && layers[0].includes('You, Bot 1, Bot 2, Bot 3, Bot 4') && layers[1].includes('You, Bot 1, Bot 2') && !layers[1].includes('Bot 3'), 'Genuine pot eligibility display incorrect');
      check(state.participants.every(p => p.holeCards.length === 2), 'Required live short hands missing');
    } else {
      check(pots.join(',') === '8' && payouts.join(',') === '4,4', 'Folded caps created false odd pots');
      check(state.participants.map(p => p.stack).join(',') === '12,12,8,9,9', 'Folded-pot equal split incorrect');
      check(layers.length === 1 && layers[0].includes('Main pot · 8 chips') && layers[0].includes('You, Bot 1'), 'Coalesced pot display incorrect');
      check(state.participants.filter(p => p.holeCards).length === 2, 'Folded cards exposed');
    }
    return { id: created.tableSessionId, pokerRevision: done.pokerRevision, board: state.board, pots, payouts, stacks: state.participants.map(p => p.stack) };
  };
  await wait(() => document.body.textContent.includes('Local identity ready'));
  const folded = await play(false); const live = await play(true);
  return { passed: true, folded, live, cases: ['folded caps form one pot', 'equal split 4/4', 'genuine live all-in boundaries', 'same winners in distinct pots', 'independent odd chips 5/3', 'safe prior decisions', 'required live reveal', 'no automatic next Hand'] };
})
