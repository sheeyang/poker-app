# M1-11 implementation evidence

The Playground receives complete participant-safe committed views over an
authorized WebSocket subscription. The server authenticates the opaque local
cookie, checks Table Ownership, and derives the bound human Participant itself.
It constructs a fresh participant facade over the promoted committed CashGame
for every initial or subsequent projection. Controller bindings and both durable
revisions belong to the wire envelope, outside the Observable Game View.

`createTableSessionMutations` owns subscription delivery at its common postcommit
promotion point. Matching retries and domain rejections publish no new gameplay
update. Confirmed rollback and a held transaction expose no working fork through
HTTP or WebSocket. Delivery failure cannot reinterpret a confirmed mutation as a
failed commit. `publishCommitted` also serves subsequent application-only changes;
`publishStatus` handles transient Bot/recovery status without a durable revision.
An unknown COMMIT acknowledgement sends recovery feedback while withholding the
proposed gameplay view and revisions.

The Playground uses one React Query structural-sharing guard for HTTP read
completion and WebSocket cache writes. It compares `sessionRevision`, ignores
older/duplicate views and their events, and accepts a newer complete view across
gaps. Transient status bypasses the gameplay revision guard. Table switching
closes the prior subscription and clears its presentation diagnostics. Closing a
connection invokes no mutation; HTTP human controls remain available. Unexpected
closure refreshes the committed view and reconnects with bounded backoff.

## Approved seam evidence

Validation on 7 October 2026 after integration of management and heads-up
progression through `implement/m1` commit `4b8a0f8`:

- `pnpm check` passed: 118 tests in 14 files, workspace type checks, server and
  Playground production builds, and dependency boundary checks. A subsequent
  `pnpm install --frozen-lockfile` also passed.
- The real HTTP/WebSocket/PostgreSQL tests cover authenticated ownership versus
  supplied observer identity, physical opponent-card and hidden-record omission,
  latest authorized initial views, held/failed real transactions, fresh promoted
  views and presentation events, idempotent/rejected commands publishing nothing,
  disconnect submitting no command, reconnect across missed revisions, and
  recovery feedback at unchanged gameplay revisions. All seven live tests pass.
- Integrated management tests receive every committed top-up, move, sitting-out,
  button, and leave event with its current full view. Integrated human Call and
  trusted controller Check use the same postcommit publication point. Community
  deals expose only public cards; all three burn events physically contain only
  type/street, and Bot hole cards appear only at Showdown.
- Isolated Chrome session `poker-m1-11` passed `scripts/smoke-live-browser.js`
  against the compiled Fastify production entry point, real PostgreSQL, and the
  local transport relay. The final Chrome error-console check had no messages.
  The ordinary UI created a one-Bot table, seated both Participants, used Start
  Hand and Fold, and displayed settlement at revisions 4/4 with stacks 990/1010.
- The relay dropped committed revision 2 while holding its acknowledgement. The
  browser accepted the complete revision-3 Hand with own cards, hidden Bot cards,
  and six received presentation events despite the gap. Disconnect/reconnect at
  that human decision changed no server revision and retained usable Fold.
- A real HTTP read captured revision 3 and was released after the revision-4
  WebSocket Fold update, while the mutation acknowledgement was held. The visible
  table remained completed at 4/4 with stacks 990/1010. Replaying captured frames
  4, 3, and 4 left both gameplay and the ten-event count unchanged.
- Thinking, failure, and idle transport status frames rendered independently of
  revision 4. Reconnect preserved current settlement without replayed events.
  Selecting a fresh table removed the old transport subscription; replaying its
  frames could not alter the new table. Reopening the completed table received
  its current complete view with zero replayed presentation events.

No private client reducer/helper tests or mock PostgreSQL implementation were
introduced. The transport relay changes real network delivery outside the
application; it is a standalone localhost test fixture and is excluded from the
server entry point and production build.

## Reproduce the browser transport smoke

Run these in separate PowerShell terminals from the repository root. The normal
Compose database must already be healthy. Use a fresh scoped Chrome profile with
no pending unconfirmed operation.

```powershell
$env:DATABASE_URL = 'postgres://poker:poker@127.0.0.1:54329/poker'
$env:PORT = '4011'
pnpm --filter @poker/server dev
```

```powershell
pnpm exec tsx apps/server/test/fixtures/live-transport.ts
```

```powershell
$env:POKER_API_TARGET = 'http://127.0.0.1:4012'
pnpm --filter @poker/playground dev --port 5181
```

```powershell
$env:CHROME_DEVTOOLS_AXI_SESSION = 'poker-m1-11'
npx -y chrome-devtools-axi open http://localhost:5181
$smokePath = (Resolve-Path scripts/smoke-live-browser.js).Path.Replace('\', '/')
$sourceUrl = '/@fs/' + $smokePath
$driver = 'async () => { const source = await fetch(' + (ConvertTo-Json $sourceUrl -Compress) + ').then(response => response.text()); return await (0,eval)(source)(); }'
npx -y chrome-devtools-axi eval $driver
npx -y chrome-devtools-axi console --type error
```

The driver returns `passed: true` and the independently asserted settlement facts.
It creates development Table Sessions through the browser's own identity. Stop
the three development processes with Ctrl+C and stop the scoped Chrome bridge
with `npx -y chrome-devtools-axi stop` in the same session environment.
