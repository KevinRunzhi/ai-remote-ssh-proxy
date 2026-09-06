# Use an inspect, prepare, and execute workflow interface

The Configuration Workflow is a deep module with three external entries: `inspect` for read-only diagnosis and Verification, `prepare` for producing a Change Plan from a mutating intent, and `execute` for applying an explicitly approved Plan Token. Per-command methods would make the module a shallow mirror of the CLI, while a single interactive run method would make cross-process approval and the future VS Code integration harder.

## Consequences

The CLI collects intent, presents Change Plans, obtains confirmation, and renders outcomes, but never orchestrates locks, writes, Verification, or Rollback. Profile queries, log removal, and version checks remain outside the Configuration Workflow rather than expanding its interface with unrelated operations.

Prepared changes are referenced by locally persisted, opaque Plan Tokens that expire after fifteen minutes and can be consumed only once. A token binds the schema and workflow versions, Change Plan digest, selected SSH Target and Tool Adapters, Local Proxy and port choices, observed state digests, and required risk confirmations. Expired, consumed, incompatible, or drifted tokens cannot execute, and their stored records contain no credentials.
