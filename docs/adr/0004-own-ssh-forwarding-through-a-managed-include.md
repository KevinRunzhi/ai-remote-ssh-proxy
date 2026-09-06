# Own SSH forwarding through a managed include

SSH reverse-forwarding directives will live in a product-owned Include file while the user's main SSH configuration receives, at most, the minimal Include directive needed to load it. Editing an existing Host block in place would look simpler, but nested Includes, Match blocks, and user formatting make precise mutation and Rollback unsafe; a separate file gives Managed State a clear ownership boundary.

## Consequences

The effective configuration is always checked with `ssh -G`. Target selection lists only explicit, non-pattern host names and a user-supplied alias must be a literal of 1–255 characters matching `[A-Za-z0-9][A-Za-z0-9._-]{0,254}`. Whitespace, line breaks, wildcard or negation tokens, percent expansion, path separators, `user@host` syntax, port syntax, and a leading option marker are rejected rather than escaped. Existing wildcard and Match rules may still participate in OpenSSH's resolution of that literal alias. Users may select an absolute custom SSH config path. A Tunnel Profile receives a stable random profile ID, while the normalized config path and alias form its changeable, unique SSH Target Locator. Transaction Records refer to the profile ID so moving a config or renaming an alias does not silently create a new identity.

The single managed Include directive is inserted at top level after existing global directives and immediately before the first top-level Host or Match section; it is never appended inside an existing context. Target and non-target effective configurations are checked after insertion and removal. An equivalent existing mapping is treated as an External Forward: it can be verified and used, but is never silently claimed, repaired, or removed. A conflicting mapping stops the Change Plan, and the product never deletes an existing user-owned RemoteForward.

Before and after a managed edit, the OpenSSH module compares the selected alias's effective connection identity and forwarding-relevant configuration. The accepted difference must be limited to the exact managed forwarding intended for that literal alias; unexpected changes to hostname, user, port, jump or proxy behavior, identity selection, or non-target observations fail Verification and trigger compensation.

Runtime port availability is proved by asking an isolated OpenSSH connection to bind the candidate Remote Proxy Endpoint, not by relying on optional remote process-listing tools. A later conflict is repaired through a new Change Plan that updates the tunnel and selected Tool Adapters together; the product never kills the process occupying a port.

The persistent managed Include does not set `ExitOnForwardFailure=yes`. A controlled Configuration Verification connection sets it explicitly so a failed bind makes that probe fail, while ordinary SSH and VS Code sessions retain OpenSSH's normal behavior and are not rejected merely because another session already owns the same remote loopback port.
