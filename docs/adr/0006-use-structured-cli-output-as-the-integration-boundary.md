# Use structured CLI output as the integration boundary

The CLI is both the first user interface and the future execution seam for the VS Code extension. Every command therefore provides stable JSON results, phase codes, evidence, suggested actions, and categorized exit statuses in addition to localized terminal output. This avoids duplicating privileged configuration behavior in the extension and prevents it from parsing human-facing Chinese or English text.

## Consequences

Future interfaces orchestrate the CLI contract instead of reimplementing configuration logic. The first command surface covers doctor, plan, configure, verify, repair, rollback, unconfigure, profile inspection, version checks, and local log removal. Only the user-facing `ai-remote-proxy` package is public in the first release; core and adapter workspace packages remain private until their interfaces have proved stable. Human wording may evolve independently, while breaking changes to the machine contract require explicit versioning.

A read-only machine handshake, available through the version command, reports the CLI version, supported machine-contract versions, command and capability identifiers, and minimum compatible client requirements. A future VS Code extension performs this handshake before mutation and refuses unsupported combinations with a structured upgrade action rather than inferring compatibility from the product version alone.

`--json` writes exactly one final Outcome document to stdout for scripts. `--json-stream` writes versioned newline-delimited events for interactive hosts and ends with the authoritative Outcome; events are ordered by run-local sequence, remain coarse-grained, and cannot block or control a Configuration Transaction. Machine modes never mix localized prose into stdout. SSH authentication requiring a terminal is reported as `interaction_required` rather than transported through the machine protocol.

When a Tunnel Profile first enables a TCP Remote Proxy Endpoint, its Change Plan carries a stable high-risk notice that any process on the SSH Target may use the endpoint. Execution requires an explicit confirmation bound into the Plan Token; the warning is machine-readable so future interfaces cannot omit it.
