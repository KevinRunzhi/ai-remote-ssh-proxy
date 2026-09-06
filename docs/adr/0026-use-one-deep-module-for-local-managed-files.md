# Use one deep module for local managed files

All local application state and SSH configuration mutation goes through a deep Local Managed Files module rather than raw filesystem calls in the Configuration Workflow, transaction code, or OpenSSH module. Centralizing ownership checks, permissions, compare-and-swap replacement, durability, and managed-edit removal keeps platform behavior and crash safety from leaking into business logic.

## Consequences

On POSIX hosts the application state directory is created as `0700`, new Transaction Records, Journals, Plan Token records, summaries, and managed SSH Include files are created as `0600`, and an existing main SSH configuration retains its mode but is rejected if writable by another user. Windows applies an equivalent owner-restricted DACL in which the current user and SYSTEM are the intended writers; administrator takeover remains outside the local threat model.

Writes use a restrictive same-directory temporary file, no-follow and ownership validation, precondition comparison, data flush, atomic replacement, parent-directory flush where supported, and postcondition evidence. Removing the main-config Include edit requires the exact Ownership Descriptor, expected applied-state digest, and inserted bytes to agree; any mismatch is Configuration Drift.

v0.1 does not mutate a symbolic link, junction, or other reparse point, including an intentionally linked SSH main configuration. Diagnosis reports the resolved target so the user may explicitly select the real regular file as a custom SSH configuration path. Supporting a stable, fully revalidated link chain is deferred behind this module's existing interface.
