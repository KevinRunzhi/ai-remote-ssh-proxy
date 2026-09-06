# Concentrate host platform behavior behind internal seams

Windows and macOS differences are concentrated behind internal Host Environment, Filesystem, Process, and Operation Lock seams rather than branching throughout the Configuration Workflow, Configuration Transaction, CLI, or Tool Adapters. Separate full platform implementations would duplicate safety semantics, while scattered operating-system checks would destroy Locality.

## Consequences

These internal modules expose safe capabilities such as locating application state, replacing Managed State, preserving platform permissions, and running a constrained process; they do not mirror low-level operating-system calls. A deep Local Managed Files module owns access-restricted creation, compare-and-swap replacement, durability, ownership checks, and exact managed-edit removal for local state and SSH configuration. Windows ACLs, path and process behavior and macOS permissions are verified through adapter contract tests, while business outcomes remain platform-neutral.
