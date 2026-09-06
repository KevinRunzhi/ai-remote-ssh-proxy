# Disclose remote loopback as a shared-host risk

A TCP Remote Proxy Endpoint bound to `127.0.0.1` is isolated from other hosts but remains reachable by every process on the SSH Target. v0.1 accepts that residual risk for trusted single-user or equivalently trusted targets, explicitly warns that untrusted multi-user targets are unsupported, and binds a first-use high-risk confirmation into each Tunnel Profile's approved Plan Token. Attempting to infer whether a host is shared would create false assurance.

## Consequences

The risk is repeated in `doctor`, Change Plans, the README, and `SECURITY.md`. Unix-domain-socket forwarding does not directly serve the standard TCP proxy URL expected by the first-party tools without a remote bridge, so it is not a v0.1 fallback. A future authenticated relay or helper requires a separate threat model and architecture decision.
