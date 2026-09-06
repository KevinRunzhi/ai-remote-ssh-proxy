# Security

AI Remote SSH Proxy is currently in the design phase and has no supported release. This document states the security boundary that the first implementation must preserve.

## Trust model

The product trusts the local user account and the operating-system security of the local computer. It does not defend against malware, another process already running as the same user, or an administrator who can take ownership of that user's files. Plan Tokens prevent stale, mismatched, or accidental execution; they are not credentials that defend against a malicious local process.

The network path and remote network are not trusted. SSH authentication, host-key verification, encryption, ProxyJump behavior, and credentials remain owned by system OpenSSH. The product never weakens those controls or stores SSH credentials.

The SSH Target is expected to be a trusted Linux environment. A Remote Proxy Endpoint bound to `127.0.0.1` is reachable by every process on that target, including other local users. Do not use v0.1 on an untrusted multi-user host: those processes could use the forwarded local proxy as an outbound or data-exfiltration channel. Loopback prevents access from neighboring hosts, not from processes on the same host.

## Security invariants

- Remote Proxy Endpoints bind only to `127.0.0.1`; GatewayPorts and non-loopback exposure are unsupported.
- v0.1 accepts only unauthenticated local HTTP proxy endpoints on `127.0.0.1` or `localhost` and never persists secret compensation data.
- SSH credentials, known-host decisions, authentication prompts, and SSH-agent behavior remain under OpenSSH control.
- Managed local state is owner-restricted and changed through durable compare-and-swap operations.
- Managed remote state is changed through allowlisted operations and a fixed POSIX sh compare-and-swap protocol.
- User-owned state is never silently claimed, overwritten, or removed. Drift and ambiguous ownership fail closed.
- Unresolved Recovery-Required evidence is pinned until a later transaction proves reconciliation.
- All user-facing diagnostic channels are redacted before output and Support Reports are never uploaded automatically.

## Explicit non-goals for v0.1

- Privacy from other users or processes on a shared SSH Target
- Authenticated, non-loopback, or externally reachable proxies
- Remote Windows, WSL-specific networking, IPv6 forwarding, PuTTY, or Plink
- Installing OpenSSH, deploying a remote helper, or keeping a product-owned SSH daemon or background tunnel
- Protecting approved changes from malicious software already running as the same local user

## Reporting a vulnerability

There is no released implementation yet. Before the first public executable is published, GitHub Private Vulnerability Reporting must be enabled for this repository and its private advisory URL added here as a release gate. Do not place credentials, private host details, or exploit material in a public issue.
