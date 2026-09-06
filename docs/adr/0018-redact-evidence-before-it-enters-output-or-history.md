# Redact evidence before it enters output or history

One deep Redaction module classifies evidence at its source and transforms it before it can enter TTY output, JSON, NDJSON, application logs, or a Support Report. The access-restricted Transaction Journal is operational recovery state rather than user-facing history: it may retain recovery-critical sensitive identifiers, but the same classification boundary prevents secrets from entering it. Per-output regular expressions would allow new fields and raw OpenSSH or tool errors to leak through whichever renderer was not updated, while suppressing all evidence would make recovery and support ineffective.

## Consequences

Structured evidence is classified as public, user-identifying, sensitive, or secret. Secrets are excluded from durable operational state and removed from output; identities and paths receive report-local aliases when rendered outside the Journal; unstructured external text receives conservative fallback cleaning. Production callers have no direct output path for raw adapter evidence, and the same sensitive fixtures exercise every output form plus the Journal's stricter no-secret admission rule.
