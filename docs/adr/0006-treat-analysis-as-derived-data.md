# Treat Analysis as Derived Data

Table Session Records retain authoritative replay inputs, while Policy recommendations, Decision Scores, and related analysis are versioned derived results. Analysis may be cached using the hand, decision, Reference Strategy implementation versions, configurations, and scoring method as its identity, but it can always be discarded and recomputed with a newly selected reference without rewriting poker history.

A hand, session, or history summary displays its final arithmetic-mean scores only after all required decision analyses have succeeded. Pending or running required analysis is represented by `Analyzing`, and failed required analysis by `Error`; missing, running, and failed results never contribute zero or produce a partial summary score.
