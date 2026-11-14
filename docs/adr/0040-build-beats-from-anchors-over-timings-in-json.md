---
status: accepted
---

# Build Beats from Anchors over Timings in JSON

[ADR-0039](0039-derive-presentation-phase-lengths-from-shared-choreography.md) put every table timing in one shared module, read by the server and the Trainer. To tune those timings by eye, a development-only motion panel replays scripted Hands, lets each timing be edited, and pulses exactly the beats an edited timing directly sets. That needs two things the plain constants and beat functions cannot give: an exact answer to "which beats does this timing directly set", and a lossless way to carry tuned values back into the code. So the timing numbers move to a JSON file, and every beat is built from an anchor over those timings, written as data.

## Decisions

- **Timings live in JSON.** Every table timing number (the four presenting phases, the Settles, the Next-Hand Countdown, and motion with no Presentation Phase) lives in one JSON file in the shared contracts package. Their descriptions live beside it in a typed notes map that must cover every key. The panel exports the whole file, so tuned values are pasted back exactly and a tuning commit is a numbers-only diff.
- **A beat is an anchor, a gap and a length, as data.** A beat follows the phase's start or its table event, the start or end of one other beat, or the end of the last of several beats. Its gap and length are sums of named timings, each optionally times a count, plus one room form for spacing that tightens (`min(gap, room / (count - 1))`). A small evaluator computes them. A timing directly sets a beat when it appears in that beat's own gap or length; a beat that only moves because something before it grew is not directly set.
- **One definition, two readings.** Each kind's anchor definition yields the plain beats the server and the Trainer consume, unchanged in shape, and, for the panel only, a description of each beat's anchor and formulas. Beat functions take a timings object that defaults to the committed JSON.
- **Motion with no Presentation Phase is anchored too.** Bets, folds, checks, seat changes and chips added to a stack are defined the same way in the contracts package, anchored to their table event, and played by the Trainer's choreography.

## Considered Options

- **Keep the TypeScript constants and copy a snippet of changed values.** Rejected: hand-applying edits across about 75 timings is error-prone, and the panel cannot round-trip the file.
- **Declare each beat's timings in a list beside its code, checked by a test.** Rejected: "directly" would rest on a hand-kept list that can drift from the arithmetic, and the panel could not show why a beat starts where it does.
- **Infer "directly" by comparing beats before and after an edit.** Rejected: a comparison cannot tell a beat a timing sets from one it merely pushes later.

## Consequences

- The beat functions the server's phase lengths depend on are restructured without changing any result: their outputs are recorded for every scenario before the restructure and compared after, so the server's phase lengths and the Trainer's motion stay as they were.
- Adding a beat means writing its anchor, gap and length as data, not arithmetic.
