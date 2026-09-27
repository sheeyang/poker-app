# Treat Analysis as Derived Data

Hand Records remain immutable authoritative gameplay data, while Policy recommendations, Decision Scores, and related analysis are versioned derived results. Analysis may be cached using the hand, decision, Reference Strategy implementation versions, configurations, and scoring method as its identity, but it can always be discarded and recomputed with a newly selected reference without rewriting the Hand.
