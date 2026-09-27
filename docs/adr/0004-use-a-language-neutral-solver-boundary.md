# Use a Language-Neutral Solver Boundary

The Solver's modeled inputs, configuration, policies, outputs, and solution-quality measurements will be separated from its computational implementation. Algorithms and backends may coexist across TypeScript, native languages, WebAssembly, GPU compute, or other suitable technologies, while generated policies continue to appear through the common Strategy abstraction and readable reference models may validate optimized implementations.
