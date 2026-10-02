# Treat Analysis as Derived Data

Table Session Records retain authoritative replay inputs, while Policy recommendations, Decision Scores, and related analysis are versioned derived results. Analysis may be cached using the Table Session, Participant, Hand, Decision, frozen input fingerprint, Reference Strategy implementation versions, configurations, effective evaluation and selection seeds, and scoring method as its identity, but it can always be discarded and recomputed with a newly selected reference without rewriting poker history.

A hand, session, or history summary displays its final arithmetic-mean scores only after all required decision analyses have succeeded. Pending or running required analysis is represented by `Analyzing`, and failed required analysis by `Error`; missing, running, and failed results never contribute zero or produce a partial summary score.

`Error` takes precedence when any required analysis has failed, even if other jobs are running; an explicit Retry must succeed before a final score can appear. Requesting a summary schedules missing analyses through JobRunner and reuses matching successful cached results, while selecting a new Reference Strategy or configuration establishes a new analysis request. A summary with no human decisions shows `—` and `No decisions` without assigning a score or scheduling jobs.
