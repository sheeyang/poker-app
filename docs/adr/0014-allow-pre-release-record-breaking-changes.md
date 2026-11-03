# Allow Record-Breaking Changes Before Release

**Amended by [ADR-0032](0032-extend-table-sessions-for-shared-online-play.md):** M4 chose to upgrade version-1 Table Session Records and Persisted Table Sessions when they are loaded, rather than break them. This keeps local and current hosted tables working. Each schema version still names exactly one format, and this decision still governs everything else before release.

Persisted records will carry schema and engine version fields from the beginning, with all initial formats identified as version 1. Until the product is released, correctness-driven changes may break existing records without migrations, version-specific replay implementations, or other backward-compatibility guarantees. A release-readiness decision must establish the compatibility policy before real user data is treated as durable.
