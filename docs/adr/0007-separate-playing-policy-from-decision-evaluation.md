---
status: superseded by ADR-0008
---

# Separate Playing Policy from Decision Evaluation

A Strategy answers what it would play by returning a flat normalized distribution over finite Concrete Choices, while a separate Decision Evaluator judges the strategic quality of any complete legal decision it can support. Implementations may provide either or both, preventing policy frequency from being misrepresented as decision quality and allowing expensive evaluators to exist without being suitable for live Bot play.
