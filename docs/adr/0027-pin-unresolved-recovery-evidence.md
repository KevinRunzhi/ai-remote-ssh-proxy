# Pin unresolved recovery evidence

The normal retention policy keeps the most recent ten settled Configuration Transactions per Tunnel Profile, while every unresolved Recovery-Required Transaction and the records required to interpret or resolve it are exempt from rotation. A global last-ten policy could erase one profile's rollback history or the only evidence that another profile remains uncertain.

## Consequences

A later Repair or Rollback Transaction may establish Recovery Reconciliation and append a `resolved_by` link to the original Journal. Only then do the linked records become eligible for ordinary rotation. Users receive a manual recovery runbook, but no force or acknowledgement path can discard uncertainty without proving a coherent known state.
