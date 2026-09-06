# Use system OpenSSH without a daemon

The first product path will reuse the user's existing, working OpenSSH host name or alias instead of installing a local daemon, maintaining a separate SSH credential store, or deploying a helper binary to the remote machine. This gives up automatic session ownership and advanced transports in exchange for a smaller trust boundary, easier auditing, and a setup that fits existing VS Code Remote SSH users.

## Consequences

The product configures the tunnel but does not own the lifetime of an SSH session. It accepts advanced topology such as ProxyJump when a capability-verified system OpenSSH client can resolve and use it, but does not rewrite that topology. Verification may create a short-lived SSH session with `ExitOnForwardFailure=yes`; it never leaves a background `ssh -N` process. The first release targets macOS 13 or later and Windows 10 22H2 or Windows 11 with Microsoft OpenSSH Client, connecting to a Linux target with POSIX sh, a writable home directory, and SSH TCP forwarding. It treats automatic system-component installation, daemon-based routing, remote Windows, WSL-specific networking, and clients lacking the required OpenSSH behavior as outside its scope.
