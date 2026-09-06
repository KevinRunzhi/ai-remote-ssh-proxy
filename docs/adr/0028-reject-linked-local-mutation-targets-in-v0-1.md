# Reject linked local mutation targets in v0.1

The first release refuses to mutate symbolic links, Windows reparse points, or product-owned files reached through them. Safely preserving a dotfiles-managed SSH link would require every link and ancestor identity, ownership, and permission to be planned and revalidated across two host platforms; simply resolving the path once would reopen a check-to-use race.

## Consequences

Diagnosis reports the resolved regular-file target and the user may explicitly choose that real file through the custom SSH configuration option. Product-owned state never accepts linked targets. A future link-aware implementation can live behind the Local Managed Files interface without changing the Configuration Workflow.
