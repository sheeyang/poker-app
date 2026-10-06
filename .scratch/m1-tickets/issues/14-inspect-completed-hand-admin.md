# M1-14: Inspect completed-Hand hidden information in Admin Mode

## What to build

An authorized Table Owner in Admin Mode chooses a completed Hand in the Playground and explicitly reveals hidden information useful for validating its deal and payout. Research reconstructs private facts server-side through JobRunner and returns a purpose-built browser DTO. Normal participant views and Strategy inputs keep their original information boundaries.

M1 scope; apply accepted ADRs 0001, 0013, 0015, 0017–0019, 0021, 0022. This is a vertical slice of the playable foundation, not an invitation to implement later Trainer, product UX, replay tooling, Solver, or simulation milestones.

## Acceptance criteria

- [ ] Provide a completed-Hand selection and explicit Reveal Hidden Information control in the Playground. Admin Mode is enabled by default for M1, and disabling it removes backend access as well as the control.
- [ ] The server authenticates and authorizes Table Ownership/Admin Mode and checks the requested Hand is completed, including direct requests bypassing the UI. Reject active-Hand reveal even for an Admin Mode user.
- [ ] Research is a server-only layer, loads permitted durable poker inputs, restores an isolated CashGame, and reads immutable authoritative completed-Hand facts through engine APIs rather than a privileged replay adapter or arbitrary state access.
- [ ] Inspection work runs through the same JobRunner, receives declared permitted inputs, returns plain results, and never mutates the active/committed Table Session.
- [ ] Authorized completed-Hand DTOs may include all hole cards, burns, reconstructed shuffled deck/deal trace and payout facts where useful; they never expose the master seed, unrestricted game objects, mutable private state, or a live hidden-information stream.
- [ ] Reveal is read-only: accepted commands and both revisions are unchanged. A completed Hand may be inspected while a later Hand is active only if the response is strictly confined to the completed Hand.
- [ ] Earlier ParticipantCashGame decision snapshots and normal Bot/Policy inputs remain exactly the originally observable information, even after showdown/inspection. Do not introduce participant-facing replay, reanalysis, scoring, counterfactuals, Range Visualizer, or equity tools.
- [ ] Real authorized server/JobRunner/PostgreSQL tests and a browser smoke verify completed-Hand inspection correctness, disabled Admin Mode, unauthenticated/non-owner/direct active-Hand rejection, master-seed omission, read-only revisions/record, historical visibility, and isolation from any later active Hand.

## Blocked by

- Draft ticket 12: Play baseline Bots through the server JobRunner.

