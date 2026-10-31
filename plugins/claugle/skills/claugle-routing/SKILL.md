---
name: claugle-routing
description: Routing rules for delegating tasks across Google AI subscription pools (agy and gemini CLI) by task kind and 7-day rolling quota state.
user-invocable: false
---

# Route tasks across Google AI quota pools

Call the `claugle` stdio MCP tools directly instead of spawning a subagent whenever a task matches the rules below.

1. For release notes, README updates, commit messages, PR descriptions, translations, or summaries, call `claugle_write`.
2. If a writing task edits markdown or documentation files in place, set `allowFileEdits: true` and pass `allowedEditGlobs` to `claugle_write`.
3. For read-only code reviews, PR diffs, or security audits, call `claugle_review`.
4. For `coding-trivial` tasks in `NORMAL` state, call `claugle_run`.
5. When `QuotaState` is `CONSERVE_CLAUDE`, `OVERFLOW_TO_AGY`, or `FALLBACK_GEMINI_CLI`, call `claugle_run` for `coding-complex` and `architecture` tasks as well.
6. To inspect 7-day token ratios or circuit-breaker status before a large run, call `claugle_quota`.

See [`sketch.d.ts`](../../types/sketch.d.ts) for domain types, [`policy-engine.mjs`](../../scripts/policy-engine.mjs) for the 32-cell lookup table, and [`README.md`](../../README.md) for pool budgets and hysteresis thresholds.
