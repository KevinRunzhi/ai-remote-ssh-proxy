# Version public and persisted contracts independently

The JSON and NDJSON envelope, Workflow Outcome, Change Plan and Plan Token, Tunnel Profile, Transaction Journal, and internal Tool contribution formats each carry their own compatibility version. A single global schema or application version would couple the future VS Code integration to unrelated storage migrations and make staged Adapter delivery unnecessarily disruptive.

## Consequences

Known older persisted formats migrate explicitly, while an unknown newer format is read-only and blocks mutation. Unknown newer machine protocols are rejected with an upgrade action. Additive optional fields may remain compatible, but removing, renaming, or changing field meaning advances that contract's incompatible version. Plan Tokens bind every contract version needed to interpret them.

Compatibility is negotiated through a read-only machine handshake that advertises contract versions and named capabilities rather than treating the application version as a protocol version. Machine clients must reject a missing required capability or incompatible contract before requesting mutation.
