# Limit ExitOnForwardFailure to verification

The persistent managed SSH configuration leaves `ExitOnForwardFailure` at the user's effective default, while the isolated Configuration Verification connection explicitly sets `ExitOnForwardFailure=yes`. Setting it permanently would make a second ordinary SSH or VS Code session fail when an existing session already owns the configured remote loopback port; using a dynamic remote port would make the Remote Proxy Endpoint unstable and invalidate tool configuration.

## Consequences

The verification connection fails immediately when it cannot establish the requested forwarding, giving Configuration Verification strong bind evidence. Ordinary sessions are not blocked solely by a duplicate bind, but may connect without owning the forwarding; Active Endpoint Verification therefore proves endpoint usability separately and reports ownership as unproven unless Managed State supplies independent evidence. The product never treats port occupancy as authority to terminate another process.
