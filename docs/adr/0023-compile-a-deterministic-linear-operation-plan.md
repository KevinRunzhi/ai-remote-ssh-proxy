# Compile a deterministic linear operation plan

The Plan Compiler produces a deterministic linear Operation Plan with explicit Verification barriers from tunnel requirements and Tool Adapter Desired State Contributions. Allowing Adapters to order mutations would leak shared-resource and rollback knowledge into them, while a general dependency DAG would introduce cycle handling, scheduling, and partial-compensation semantics before the product needs concurrent mutation.

## Consequences

Each operation has a typed resource identity, preconditions, postconditions, compensation data, and sensitivity classification. The Transaction Executor applies the sequence in order, records every external-effect boundary, and compensates the successfully applied operation stack in reverse order. Adding a future operation type requires compiler and executor support; an Adapter cannot bypass those modules with commands or callbacks.
