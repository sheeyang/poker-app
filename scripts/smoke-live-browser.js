// Pass this function to chrome-devtools-axi eval against the Playground behind live-transport.ts.
(async () => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const wait = async predicate => {
    const end = Date.now() + 10000;
    while (!await predicate()) { if (Date.now() > end) throw new Error('Browser condition timed out'); await new Promise(resolve => setTimeout(resolve, 25)); }
  };
  const button = text => [...document.querySelectorAll('button')].find(element => element.textContent === text);
  const click = text => { const element = button(text); check(element && !element.matches(':disabled'), text + ' unavailable'); element.click(); };
  const revision = () => [...document.querySelectorAll('dt')].find(element => element.textContent === 'Committed revisions')?.nextElementSibling?.textContent;
  const events = () => document.querySelector('.presentation-events summary')?.textContent;
  const request = async (path, body) => {
    const response = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
    const data = await response.json(); check(response.ok, JSON.stringify(data)); return data;
  };
  const transport = body => request('/api/__transport', body);
  const setInput = (name, value) => {
    const input = document.querySelector('input[name="' + name + '"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  await wait(() => document.querySelector('input[name="botCount"]') && button('Create Table Session') && !button('Create Table Session').matches(':disabled'));
  setInput('botCount', '1');
  await new Promise(resolve => setTimeout(resolve, 50));
  const createFresh = async () => {
    const previous = document.querySelector('.session-id')?.textContent;
    click('Create Table Session');
    await wait(() => document.querySelector('.session-id')?.textContent && document.querySelector('.session-id').textContent !== previous && document.body.textContent.includes('Live updates connected'));
    return document.querySelector('.session-id').textContent;
  };
  // First exercise the ordinary UI wiring, including Start Hand and Fold buttons.
  await createFresh();
  click('Seat Participant');
  await wait(() => revision() === 'Poker 1 · Session 1' && !button('Seat Participant').matches(':disabled'));
  click('Seat Participant');
  await wait(() => revision() === 'Poker 2 · Session 2' && !button('Start Hand').matches(':disabled'));
  click('Start Hand');
  await wait(() => revision() === 'Poker 3 · Session 3' && button('Fold') && !button('Fold').matches(':disabled'));
  click('Fold');
  await wait(() => revision() === 'Poker 4 · Session 4' && document.body.textContent.includes('Hand completed') && !document.body.textContent.includes('Saving the Hand command'));
  check(document.querySelector('.seats').textContent.includes('990 chips') && document.querySelector('.seats').textContent.includes('1010 chips'), 'Ordinary UI Fold settlement did not render');
  const id = await createFresh();
  const path = '/api/table-sessions/' + id;
  const initial = await request(path);
  check(initial.bindings.length === 2, 'Expected a human and one Bot');
  click('Seat Participant');
  await wait(() => revision() === 'Poker 1 · Session 1' && !button('Seat Participant').matches(':disabled'));
  check(events() === 'Presentation events received: 1', 'Human seating event missing');
  await transport({ kind: 'drop', tableSessionId: id, revision: 2 });
  await transport({ kind: 'hold', tableSessionId: id, responseKind: 'seat-participant' });
  click('Seat Participant');
  await wait(() => button('Seat Participant').matches(':disabled'));
  // The real server accepts Bot seating, but this transport withholds its update and acknowledgement.
  await wait(() => document.body.textContent.includes('Saving seat and buy-in'));
  await wait(async () => (await transport()).held.includes(id + ':seat-participant'));
  const committed = await request(path);
  check(committed.sessionRevision === 2 && revision() === 'Poker 1 · Session 1', 'Revision 2 was not withheld');
  await request(path + '/start-hand', { requestId: crypto.randomUUID(), expectedPokerRevision: 2 });
  await wait(() => revision() === 'Poker 3 · Session 3');
  check(document.querySelectorAll('[aria-label="Hole cards"]').length === 1 && document.querySelector('.seats').textContent.includes('2 hidden cards'), 'Participant privacy was lost');
  check(events() === 'Presentation events received: 6', 'A newer complete view did not cross the missing revision');
  await transport({ kind: 'release', tableSessionId: id, responseKind: 'seat-participant' });
  await wait(() => button('Fold') && !button('Fold').matches(':disabled'));
  click('Disconnect live updates');
  await wait(() => document.body.textContent.includes('Live updates disconnected'));
  check((await request(path)).sessionRevision === 3 && revision() === 'Poker 3 · Session 3', 'Disconnect submitted a command');
  check(!button('Fold').matches(':disabled'), 'Disconnect removed valid human action access');
  click('Reconnect live updates');
  await wait(() => document.body.textContent.includes('Live updates connected'));
  check(events() === 'Presentation events received: 6', 'Reconnect replayed presentation events');
  await transport({ kind: 'hold', tableSessionId: id, responseKind: 'read' });
  await transport({ kind: 'hold', tableSessionId: id, responseKind: 'act' });
  click('Refresh view');
  // Confirm the old read has reached the real server and been captured before submitting Fold.
  let held;
  for (let attempt = 0; attempt < 100; attempt++) { held = await transport(); if (held.held.includes(id + ':read')) break; await new Promise(resolve => setTimeout(resolve, 25)); }
  check(held.held.includes(id + ':read'), 'Old HTTP view was not captured');
  click('Fold');
  await wait(() => revision() === 'Poker 4 · Session 4' && document.body.textContent.includes('Hand completed'));
  await transport({ kind: 'release', tableSessionId: id, responseKind: 'read' });
  await wait(() => !document.body.textContent.includes('Loading Table Session'));
  check(revision() === 'Poker 4 · Session 4' && document.body.textContent.includes('Hand completed'), 'Old HTTP view overwrote the newer WebSocket view');
  await transport({ kind: 'release', tableSessionId: id, responseKind: 'act' });
  await wait(() => !document.body.textContent.includes('Saving the Hand command'));
  check(document.querySelector('.seats').textContent.includes('990 chips') && document.querySelector('.seats').textContent.includes('1010 chips'), 'Fold settlement did not render');
  check(events() === 'Presentation events received: 10', 'Fold presentation events missing');
  for (const frameRevision of [4, 3, 4]) await transport({ kind: 'replay', tableSessionId: id, revision: frameRevision });
  await new Promise(resolve => setTimeout(resolve, 100));
  check(revision() === 'Poker 4 · Session 4' && events() === 'Presentation events received: 10' && document.body.textContent.includes('Hand completed'), 'Duplicate or older live views/events were reapplied');
  await transport({ kind: 'status', tableSessionId: id, status: { phase: 'recovering', message: 'Transport fixture recovery' } });
  await wait(() => document.body.textContent.includes('Transport fixture recovery'));
  await transport({ kind: 'status', tableSessionId: id, status: { phase: 'idle' } });
  await wait(() => !document.body.textContent.includes('Transport fixture recovery'));
  check(revision() === 'Poker 4 · Session 4', 'Transient status changed gameplay revisions');
  click('Disconnect live updates');
  await wait(() => document.body.textContent.includes('Live updates disconnected'));
  click('Reconnect live updates');
  await wait(() => document.body.textContent.includes('Live updates connected'));
  check(revision() === 'Poker 4 · Session 4' && document.body.textContent.includes('Hand completed'), 'Reconnect did not preserve current settlement');
  click('Create Table Session');
  await wait(() => document.querySelector('.session-id')?.textContent !== id && revision() === 'Poker 0 · Session 0' && document.body.textContent.includes('Live updates connected'));
  const otherId = document.querySelector('.session-id').textContent;
  await transport({ kind: 'replay', tableSessionId: id, revision: 4 });
  check(document.querySelector('.session-id').textContent === otherId && revision() === 'Poker 0 · Session 0', 'Old subscription altered a different selected table');
  const subscription = await transport();
  check(!subscription.sockets.includes(id) && subscription.sockets.includes(otherId), 'Switching tables retained the old subscription');
  click(id);
  await wait(() => document.querySelector('.session-id')?.textContent === id && document.body.textContent.includes('Live updates connected'));
  check(revision() === 'Poker 4 · Session 4' && events() === 'Presentation events received: 0', 'Reopening replayed old events');
  await wait(() => button('Reveal Hidden Information'));
  click('Reveal Hidden Information');
  await wait(() => document.body.textContent.includes('Revealed Hand 1'));
  return { passed: true, tableSessionId: id, pokerRevision: 4, sessionRevision: 4, stacks: [990, 1010], cases: ['UI creation/seating/start/Fold', 'real transport gap', 'duplicate and reordered frames', 'held older HTTP read after newer WS', 'own-card privacy', 'disconnect submits no action', 'reconnect latest view', 'transient status independent of revisions', 'switch unsubscribes'] };
})
