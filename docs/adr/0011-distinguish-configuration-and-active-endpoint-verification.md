# Distinguish configuration and active endpoint verification

A short-lived SSH connection proves Configuration Verification but does not prove that an existing VS Code or SSH session carries the new forwarding after the probe exits. The product therefore reports Reconnect Required after successful configuration until a connection with forwarding disabled can perform Active Endpoint Verification against an endpoint that the verifier did not create.

## Consequences

Configuration Verification is sufficient to commit an otherwise successful Configuration Transaction, but its outcome cannot be presented as an active session. Active Endpoint Verification uses an isolated connection with forwarding cleared so that the probe cannot create the endpoint it claims to verify. The product does not keep a temporary background SSH process alive to bridge the gap.

An Active Endpoint Verification result may show that the endpoint is expected and usable, but it does not establish which process or configuration owns that endpoint. Until ownership is independently established through Managed State, the result is reported as `expected_but_unproven`. The product never terminates an endpoint merely because it occupies the expected port.
