# Hide system SSH behind a deep OpenSSH module

System OpenSSH is accessed through a deep internal module that exposes typed target inspection, constrained remote Managed State access, isolated forwarding probes, and Active Endpoint probes. Sharing a generic command runner across the tunnel core, transactions, and Tool Adapters would spread argument construction, platform differences, error classification, and shell-injection risk throughout the codebase; replacing OpenSSH with a library would forfeit compatibility with users' existing SSH configuration.

## Consequences

The OpenSSH module owns argv construction, `ssh -G`, BatchMode, forwarding isolation, timeouts, cancellation, output decoding, redaction, and a versioned fixed POSIX sh protocol with strictly encoded parameters. Local processes are always launched by argv without a local shell. Remote operations are allowlisted and typed, scripts are fixed, payload data travels through stdin rather than command text, and unknown operations or protocol versions fail closed. Its process and host-platform dependencies are internal seams. Tool Adapters and the CLI receive no arbitrary SSH or remote-shell execution interface.

Support is determined by capability probes rather than an unverifiable claim about executable identity. Symlinks and packaging shims may be accepted when behavior is known, while missing or unknown required behavior fails closed.

Effective-configuration inspection deliberately uses OpenSSH itself, so `ssh -G` may evaluate a user's `Match exec` rules. Inspection is deferred until the user has selected an SSH Target, discloses that nominally read-only inspection can execute commands already authorized by the user's SSH configuration, applies bounded timeouts and output redaction, and lets the user stop before inspection. Reimplementing or partially parsing OpenSSH matching semantics is outside the module.

Remote Environment shell integration is exposed through typed syntax-check and isolated interactive-shell Verification operations, not arbitrary shell execution. The Remote Environment module owns fixed generated content and value serialization; the OpenSSH module only transports the allowlisted files and observations through its constrained protocol.
