# Delegate SSH trust and authentication to OpenSSH

The product will not maintain SSH credentials, weaken host-key checking, or edit known-host records. Interactive authentication and first-use host verification remain visible OpenSSH behavior, while non-interactive operations use BatchMode and report that user interaction is required. The default system client or an explicitly selected absolute binary must pass capability probes for the required OpenSSH behavior; command strings, PuTTY, Plink, and clients with unknown behavior are outside the first release. The product does not claim that it can reliably distinguish every wrapper or shim. This avoids creating a second SSH security model merely to automate proxy configuration.

## Consequences

Verification uses a short-lived connection isolated from ControlMaster reuse so it can prove that a new connection can establish the requested forward. Existing SSH masters and VS Code sessions are never closed or modified by the product.
