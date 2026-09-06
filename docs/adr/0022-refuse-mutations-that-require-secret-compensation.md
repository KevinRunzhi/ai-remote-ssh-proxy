# Refuse mutations that require secret compensation

The first release rejects any Change Plan whose exact Rollback would require persisting an existing credential, token, authenticated proxy URL, or other secret. Explicit approval can authorize replacement of a non-secret user-owned proxy conflict, but cannot waive this boundary. Adding Keychain and Windows Credential Manager support would expand the secret lifecycle and cross-platform recovery surface beyond the unauthenticated loopback-proxy goal.

## Consequences

Users encountering a secret-bearing prior proxy value must migrate or remove it themselves before the product can manage that scope. Ordinary unauthenticated conflicts remain reviewable and reversible. Transaction Records and Journals may retain recovery-critical sensitive identifiers under restrictive permissions, but never secret compensation values; there is no force flag that bypasses this rule.
