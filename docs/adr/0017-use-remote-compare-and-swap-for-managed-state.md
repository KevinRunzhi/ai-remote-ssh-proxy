# Use remote compare-and-swap for managed state

Remote Managed State is changed through a fixed POSIX sh compare-and-swap protocol owned by the OpenSSH module. Reading a file in one SSH operation and overwriting it in another would leave a large Configuration Drift race, while a deployed locking helper would violate the first-release trust boundary.

## Consequences

The protocol validates the path and symlink policy, compares the current digest with the planned precondition, writes a permission-restricted temporary file in the target directory, verifies its content, preserves an existing file's mode, renames within the same filesystem, and returns postcondition evidence. Compensating Rollback uses the same protocol. This is a best-effort compare-and-swap rather than a claim of exclusion against unrelated writers; any uncertain or mismatched evidence becomes Configuration Drift or Recovery Required.
