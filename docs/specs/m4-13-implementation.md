# M4-13 implementation evidence

Study stays private at an Online Table, and the Table Owner can disallow Live Analysis for everyone.

**Allow Live Analysis.** It is an Online Table option, on by default and part of every Participant's view (`options.allowLiveAnalysis`). The owner changes it between Hands with `POST /api/table-sessions/:id/set-table-options { requestId, expectedSessionRevision, options: { allowLiveAnalysis } }`. This is the `allowLiveAnalysis` branch of the table-options mutation that M4-12 completes. Other Participants get 403 `table-owner-required`, a Practice Table gives 403 `unavailable-at-practice-tables`, and during a Hand, until its payout phase ends, the request gets 400 `active-hand`. Each human Action Window captures the value as it opens. A window opened while Live Analysis was disallowed carries `liveAnalysisDisallowed: true` in the persisted and projected schedule. Analysis of that decision before it is accepted is Live Analysis, with or without `live: true`, and the server refuses it with 403 `live-analysis-disallowed`. A change therefore applies from the next decision. Post-action analysis is unaffected: every accepted decision, Timeout Actions included, is analyzed automatically, scored and summarized. See the [server protocol reference](../server-protocol.md#allow-live-analysis).

**Trainer.** `apps/web/src/live-analysis.ts` decides whether Live Analysis is allowed for the viewer. For their own open decision it uses what the window captured; otherwise it uses the table's setting. When Live Analysis is disallowed, the analysis panel says so in the Live tab and the mode line, the Live Analysis switch is disabled, and no Live Analysis request is sent. The viewer's own setting is kept for when it is allowed again. At an Online Table the analysis settings show the table's setting to everyone.

**Tests.** `apps/server/test/online-study.test.ts` uses a `ManualClock` and real Guests and sockets. It covers:
- the option's default, visibility, owner-only change, validation, idempotency and between-Hands rule;
- a refused Live Analysis that stays refused across a restart, with post-action scoring continuing and re-allowing applying from the next Hand;
- two humans in one Hand checking down to a showdown, then playing a later Hand. Fresh analyses with new Reference Strategies see exactly the view each human had at each decision, with no later street and no opponent cards. Neither human can capture, read or retry the other's analysis or receive its notifications, and responses carry no cards, deck or game view;
- an Online Timeout Action scored as the human's own decision, in both summaries;
- held analysis jobs that never delay an action, an Action Deadline's Timeout Action, or the next Hand's countdown and deal.

`apps/web/test/live-analysis.test.ts` covers the pure rules and the panel's disabled state.

No browser check was recorded. The ticket does not ask for one, and the owner's control for the option belongs to M4-12.
