# Maintain an Independent Playground Through All Milestones

M1 will deliver a minimal playable engine-and-server vertical slice through a functional React Playground, with animations and polished product UX deferred. The Playground remains an engineering interface throughout M1-M5, and new platform capabilities are exercised there before their product experiences are planned and implemented. It is maintained independently of the final application so validation tooling does not dictate Trainer or Research Lab UX; M2 introduces the full Trainer and animations, M3 Replay and Research, M4 the Solver, and M5 mass simulation and benchmarking.

`apps/playground` exists from M1 onward, `apps/web` introduces the product experiences from M2 onward, and both use the shared authoritative `apps/server` through safe contracts. The Playground follows participant visibility rules and uses authorized, completion-gated Research endpoints when exercising hidden-information reveal.
