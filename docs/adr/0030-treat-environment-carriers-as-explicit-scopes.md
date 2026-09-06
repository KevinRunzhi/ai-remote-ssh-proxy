# Treat environment carriers as explicit scopes

Interactive Bash/Zsh startup and the VS Code Server environment are separate, explicitly selected Environment Carriers. Treating a successful shell edit as proof for every remote launch path would make Codex appear configured when its actual process never inherited the proxy, while abandoning automatic shell integration would defeat the first-release one-click goal.

## Consequences

The Bash/Zsh carrier uses a fixed non-fatal loading block and an allowlisted environment file serialized with strict POSIX quoting. NUL, newline, and control characters fail closed; candidate files pass shell syntax-only checks before mutation and an isolated interactive shell verifies the final variables. Fish, tcsh, and unknown shells return `unsupported` for that scope without mutation. Tunnel-only remains valid, and a tool is healthy only when an applicable selected carrier is independently verified.
