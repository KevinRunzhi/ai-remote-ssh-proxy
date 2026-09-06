# Provide final JSON and streaming NDJSON

The CLI exposes one final JSON document for ordinary automation and a separate versioned NDJSON event stream for future VS Code progress and cancellation UX. A final-only protocol would leave long apply and recovery operations opaque, while bidirectional JSON-RPC would duplicate the Plan Token approval flow and turn the CLI into a session host.

## Consequences

Every stream event carries a schema version, run identifier, monotonic sequence, coarse phase, stable message code, and redacted payload; the completed Outcome and categorized process exit status remain authoritative. Slow or disconnected event consumers do not alter execution. Plans and approvals cross process boundaries through Plan Tokens, not interactive stream prompts.

The read-only machine handshake reports supported Outcome, event-stream, Plan, and command capability versions independently of the CLI product version. Machine clients negotiate before mutation, while every Outcome and NDJSON run remains self-describing so captured results can be interpreted without relying on a prior handshake.

Expected problems use a stable layered taxonomy covering invalid input, unsupported capability, required interaction, environmental blockers, conflicts, Configuration Drift, cancellation, apply failure, Verification failure, Rollback failure, Recovery Required, unknown external failure, and internal error. The stable `cancelled` problem code describes the requested outcome; it does not imply that Compensating Rollback succeeded, so the final transaction state and recovery actions remain explicit. Classification prefers structured preconditions and process results over stderr patterns, and unrecognized external output remains `external_unknown` with redacted evidence rather than being guessed into a more actionable category.
