# Restrict managed SSH aliases to literals

A user-supplied SSH alias must be 1–255 characters matching `[A-Za-z0-9][A-Za-z0-9._-]{0,254}`. OpenSSH Host values are patterns rather than safely escaped literals, so accepting wildcard, negation, whitespace, expansion, path, user, port, or option syntax could broaden a managed reverse forward or inject configuration.

## Consequences

Existing user wildcard and Match rules may still contribute to the effective configuration of an accepted literal alias. The product compares `ssh -G` observations before and after mutation and accepts only the intended forwarding difference for that alias; unexpected transport, identity, proxy, or non-target changes fail Verification. Broader OpenSSH pattern management is not a future compatibility promise.
