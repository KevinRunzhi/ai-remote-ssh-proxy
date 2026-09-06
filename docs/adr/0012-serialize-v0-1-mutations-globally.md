# Serialize v0.1 mutations globally

All v0.1 configure, repair, rollback, and unconfigure operations share one global mutation lock, while read-only inspection may continue concurrently. A lock keyed only by SSH Target cannot protect a shared SSH Include, local state store, or remote files reached through multiple aliases; resource-level locking would address that precisely but adds identity, ordering, and deadlock complexity before parallel mutation is needed.

## Consequences

Two unrelated SSH Targets cannot be mutated concurrently in v0.1. Resource-level locking may replace the global lock later without changing the Configuration Workflow interface.

An unresolved Recovery-Required Transaction globally blocks every new mutation in v0.1, including mutations for another Tunnel Profile. Read-only inspection and preparation of a dedicated recovery or rollback plan remain available. Narrowing this gate requires resource identity and resource-level locking to be proven together in a later version.

The preferred implementation is a cross-platform operating-system advisory lock so process termination releases ownership without PID guessing. Its packaging and signing compatibility must be proved early; if that introduces unacceptable native-runtime risk, an atomic lock directory with an instance identifier and Transaction Journal evidence is the fallback. Releasing or replacing a stale lock never resolves an unfinished transaction by itself.
