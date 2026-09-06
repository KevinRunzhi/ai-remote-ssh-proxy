# Treat configuration as a verified transaction

Every mutating setup operation will first produce a Change Plan, record the prior Managed State, apply only changes approved through a matching Plan Token, and run Verification. If application or verification fails, the product attempts to restore the recorded state and reports Recovery Required whenever restoration cannot be proven. This costs more engineering effort than a sequence of setup commands but is necessary because the product edits configuration that can affect existing remote development sessions.

## Consequences

User-owned configuration is never replaced wholesale, and Rollback is limited to state attributable to a specific Configuration Transaction.

Each transaction has a stable identifier and an access-restricted, schema-versioned Transaction Record stored in the platform's per-user application data directory. It may contain recovery-critical sensitive identifiers and non-secret prior values, but never secret compensation data. Before every write and before Rollback, current state is compared with the recorded state; Configuration Drift, malformed configuration, ambiguous managed blocks, unsafe symbolic links, or a newly conflicting user-owned proxy value stop automatic mutation rather than risking later user changes. There is no force flag that bypasses drift protection. The default retention policy keeps the most recent ten settled records per Tunnel Profile while pinning unresolved recovery evidence. Repair is implemented as another planned transaction, while Unconfiguration removes current Managed State without pretending to restore a historical snapshot.

An interrupted transaction is either rolled back within a bounded period or recorded as Recovery-Required. A first cancellation during mutation appends a `cancellation_requested` event, lets the current smallest external operation reach a safe boundary, and begins Compensating Rollback; read-only work may stop immediately. A second interrupt may terminate recovery, but cannot erase evidence that the state remains uncertain. Later commands diagnose that record before starting unrelated mutation.

A Configuration Transaction is not an atomic commit across local and remote machines. Its guarantee is a durable journal, ordered mutation, postcondition evidence, mandatory Verification, and Compensating Rollback. User-facing documentation and outcomes must not describe an uncertain or merely attempted restoration as atomic success.
