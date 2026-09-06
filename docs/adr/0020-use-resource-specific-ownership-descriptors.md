# Use resource-specific ownership descriptors

Managed State carries a versioned Ownership Descriptor expressed according to the resource format: product-owned files use headers, text regions use paired markers, JSON/JSONC properties use a local descriptor with their pointer and state digests, and the main SSH Include directive corresponds to the owned Include file. A single comment scheme cannot safely cover JSON, while local sidecars alone cannot reliably locate shell blocks or SSH directives after partial state loss.

## Consequences

Descriptors identify the product format, resource, and stable Tunnel Profile without placing private unknown keys in tool settings. Duplicate, incomplete, mismatched, or unknown descriptors fail closed. Unconfiguration and Rollback act only on resources whose descriptor and observed state agree with their records.
