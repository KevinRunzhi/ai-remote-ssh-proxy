# Bind the remote proxy to IPv4 loopback only

Every Remote Proxy Endpoint in the first release binds explicitly to `127.0.0.1`. Allowing a wildcard or remote-network address would make the user's Local Proxy reachable by other users or hosts depending on server-side GatewayPorts policy, turning a convenience feature into a network exposure tool. IPv6 and non-loopback binding are excluded rather than hidden behind an advanced flag.

## Consequences

The product neither enables nor depends on GatewayPorts. Scenarios that require sharing a forwarded proxy with containers, other server users, or neighboring machines are outside the first-release security boundary.

Loopback binding does not isolate processes or users on the SSH Target itself: any process able to connect to that host's `127.0.0.1` may use the unauthenticated Remote Proxy Endpoint. v0.1 therefore does not claim privacy on an untrusted multi-user SSH Target. The first Change Plan for each Tunnel Profile requires an explicit residual-risk confirmation, and `doctor`, the README, and `SECURITY.md` continue to disclose it rather than attempting unreliable multi-user detection.

Unix-domain-socket remote forwarding was considered but does not directly satisfy the standard TCP proxy URL consumed by Codex and Claude Code without adding a remote bridge or helper. An authenticated remote relay may be reconsidered later, but is outside the daemonless v0.1 architecture.
