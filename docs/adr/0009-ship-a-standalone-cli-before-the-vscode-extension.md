# Ship a standalone CLI before the VS Code extension

The first public execution path is a standalone `ai-remote-proxy` CLI, with the VS Code extension following only after the structured CLI contract and recovery behavior are stable. v0.1 proves tunnel-only and Codex end to end; v0.2 adds the independent Claude Code adapter and hardens platform and recovery behavior; the VS Code extension follows in v0.3. An npm-only release would be easier to build but would require the non-technical target audience to install Node.js, so the first formal phase must also produce Windows x64, macOS Intel, and Apple Silicon executables. Packaging technology is selected through an early cross-platform spike, preferring Node's official single-executable mechanism when it satisfies subprocess, resource, and signing requirements.

## Consequences

Preview artifacts may initially be unsigned when clearly labeled and accompanied by SHA-256 checksums. A stable macOS release requires signing and notarization; platform warnings and signing status must be disclosed rather than hidden. The VS Code extension consumes versioned JSON output instead of duplicating configuration logic.
