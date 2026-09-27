# Allow Record-Breaking Changes Before Release

Persisted records will carry schema and engine version fields from the beginning, with all initial formats identified as version 1. Until the product is released, correctness-driven changes may break existing records without migrations, version-specific replay implementations, or other backward-compatibility guarantees. A release-readiness decision must establish the compatibility policy before real user data is treated as durable.
