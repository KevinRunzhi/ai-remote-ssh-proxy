# AI Remote SSH Proxy

This context describes how a proxy available on a user's local computer becomes safely usable by developer tools running on a remote machine reached through SSH.

## Language

**Local Proxy**:
The HTTP-compatible proxy endpoint already running on the user's local computer.
_Avoid_: VPN, local tunnel, proxy software

**SSH Target**:
A remote machine identified by an existing OpenSSH host name or alias that the user can already connect to.
_Avoid_: Server profile, remote account, connection

**Remote Proxy Endpoint**:
A loopback-only proxy endpoint on an SSH Target that carries traffic back to the Local Proxy.
_Avoid_: Remote proxy server, public proxy port, relay

**Tunnel Profile**:
The stable identity and desired association among one SSH Target locator, one Local Proxy, and one Remote Proxy Endpoint.
_Avoid_: SSH config, connection profile, server

**SSH Target Locator**:
The changeable pair of a normalized OpenSSH configuration entry path and host alias used to reach the SSH Target associated with a Tunnel Profile.
_Avoid_: Profile ID, server identity, connection string

**Active Tunnel Profile**:
The single Tunnel Profile currently selected to provide a Remote Proxy Endpoint for an SSH Target.
_Avoid_: Default profile, running tunnel, current connection

**Tool Adapter**:
The product knowledge required to make one remote developer tool use a Remote Proxy Endpoint and to verify that tool's resulting network state.
_Avoid_: Plugin, integration script, provider

**Desired State Contribution**:
A Tool Adapter's declarative description of tool-specific Managed State and Verification requirements, without commands or authority to apply them.
_Avoid_: Setup script, mutation callback, tool transaction

**Operation Plan**:
The Plan Compiler's deterministic ordered sequence of typed mutations and Verification barriers derived from approved Desired State Contributions.
_Avoid_: Adapter script, dependency graph, command list

**Configured-Unverified Tool**:
A selected developer tool whose proxy Managed State exists but whose installation or runtime evidence is unavailable for Verification.
_Avoid_: Working tool, missing tool, successful adapter

**Supported Tool Capability**:
A developer-tool behavior that its Tool Adapter has positively detected and knows how to configure or verify without assuming a particular version string.
_Avoid_: Supported version, available command, compatibility guess

**Managed State**:
Configuration owned by this product and distinguishable from configuration owned by the user or another tool.
_Avoid_: User config, generated files

**Ownership Descriptor**:
The versioned identity linking a piece of Managed State to its resource, Tunnel Profile, and product-owned representation.
_Avoid_: Comment marker, sidecar, checksum

**External Forward**:
A user-owned SSH reverse-forwarding mapping equivalent to the one required by a Tunnel Profile but outside Managed State.
_Avoid_: Imported profile, managed tunnel, conflict

**Change Plan**:
A reviewable description of the Managed State that would be created, changed, or removed without applying those changes.
_Avoid_: Dry run, preview output

**Plan Token**:
A short-lived, opaque reference that binds an approved Change Plan to the observations and explicit risk confirmations on which it was based.
_Avoid_: Confirmation flag, serialized plan, transaction ID

**Configuration Transaction**:
A durable, compensating configuration workflow that verifies its approved changes together and records uncertainty when prior state cannot be proven restored.
_Avoid_: Atomic transaction, setup script, batch edit

**Recovery-Required Transaction**:
An interrupted or failed Configuration Transaction for which the product cannot prove either successful Verification or complete Rollback.
_Avoid_: Failed setup, partial success, recovered transaction

**Recovery Reconciliation**:
Evidence that every resource affected by a Recovery-Required Transaction has returned to a coherent known state, allowing that transaction to be linked to its resolving Repair or Rollback Transaction.
_Avoid_: Force unlock, abandon recovery, clear error

**Transaction Record**:
A local, access-restricted record that identifies one Configuration Transaction, its approved Change Plan, and the non-secret prior Managed State required for safe Rollback.
_Avoid_: Log, full backup, audit trail

**Transaction Journal**:
The ordered, durable and access-restricted operational evidence of Configuration Transaction stages, completed mutations, Verification, and compensation outcomes. It may retain recovery-critical sensitive identifiers, but never secrets.
_Avoid_: Application log, mutable status file, event-sourced product state

**Cancellation Requested**:
A durable request to stop a Configuration Transaction at its next safe operation boundary and begin Compensating Rollback.
_Avoid_: Immediate termination, transaction state, force kill

**Configuration Drift**:
A difference between current Managed State and the state last written or observed by the product, indicating that another actor may have changed it.
_Avoid_: Corruption, conflict, user error

**Verification**:
Evidence that the SSH Target exposes the expected Remote Proxy Endpoint and that each selected developer tool can use it.
_Avoid_: Connectivity guess, successful write

**Probe Policy**:
A Tool Adapter's versioned interpretation of which no-model-call observations establish tool network reachability, authentication state, or insufficient evidence.
_Avoid_: Endpoint list, health check URL, model test

**Configuration Verification**:
Evidence that the effective OpenSSH configuration and a short-lived isolated connection can establish and use the intended Remote Proxy Endpoint.
_Avoid_: Active tunnel, completed setup, session health

**Active Endpoint Verification**:
Evidence that a Remote Proxy Endpoint is usable without the verifying connection creating that forwarding itself. This proves availability, not which process or configuration owns the endpoint.
_Avoid_: Temporary tunnel check, configuration check, port-open guess

**Reconnect Required**:
A successful configuration outcome indicating that an existing SSH or VS Code session has not yet been proven to carry the newly configured forwarding.
_Avoid_: Verification failure, active proxy, restart required

**Remote Environment**:
The product-owned proxy environment shared by selected remote tools, supported shells, and optionally the VS Code Server.
_Avoid_: Codex environment, shell config, global proxy

**Environment Carrier**:
An explicitly selected and independently verified mechanism through which the Remote Environment reaches a developer tool, such as an interactive Bash/Zsh startup or the VS Code Server environment.
_Avoid_: Shell support, global environment, adapter configuration

**Rollback**:
Restoration of the state recorded before a Configuration Transaction, limited to Managed State.
_Avoid_: Reset, uninstall, overwrite

**Compensating Rollback**:
Restoration attempted within a failing Configuration Transaction before that transaction can be reported as safely rolled back.
_Avoid_: User rollback, undo command, new transaction

**Rollback Transaction**:
A new Configuration Transaction requested by a user to restore the prior Managed State recorded by another transaction.
_Avoid_: Compensating rollback, status rewrite, unconfiguration

**Repair**:
A new Configuration Transaction intended to reconcile unhealthy or drift-free Managed State with an approved Change Plan.
_Avoid_: Silent fix, retry, forced overwrite

**Unconfiguration**:
The planned removal of current Managed State for an SSH Target without removing equivalent user-owned configuration.
_Avoid_: Rollback, uninstall, reset

**Support Report**:
A user-controlled, redacted document containing diagnostic evidence and suggested actions for troubleshooting.
_Avoid_: Telemetry, crash upload, raw logs
