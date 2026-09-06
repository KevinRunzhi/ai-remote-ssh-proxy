# Negotiate machine capabilities before mutation

Machine clients use a read-only CLI handshake to discover the application version, independently versioned machine contracts, named command capabilities, and minimum compatible client requirements before requesting mutation. Comparing only release versions would couple unrelated schemas, while linking the future VS Code extension directly to internal packages would duplicate the execution and recovery boundary.

## Consequences

The version command can carry the handshake without introducing a resident service. A VS Code extension refuses incompatible contracts or missing required capabilities with a structured upgrade action. Every Outcome and NDJSON run remains self-describing and authoritative even when no prior handshake was captured.
