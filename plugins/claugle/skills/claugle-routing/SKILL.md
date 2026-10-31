---
name: claugle-routing
description: Routing rules for delegating tasks to Google AI models through agy by task kind and 7-day rolling quota state, and for keeping Gemini work cheap.
user-invocable: false
---

# Route tasks across Google AI quota pools

Call the `claugle` stdio MCP tools directly instead of spawning a subagent whenever a task matches the rules below.

1. For release notes, README updates, commit messages, PR descriptions, translations, or summaries, call `claugle_write`.
2. If a writing task edits markdown or documentation files in place, set `allowFileEdits: true` and pass `allowedEditGlobs` to `claugle_write`.
3. For read-only code reviews, PR diffs, or security audits, call `claugle_review`.
4. For `coding-trivial` tasks in `NORMAL` state, call `claugle_run`.
5. When `QuotaState` is `CONSERVE_CLAUDE`, `OVERFLOW_TO_AGY`, or `FALLBACK_GEMINI_CLI`, call `claugle_run` for `coding-complex` and `architecture` tasks as well.
6. `claugle_run` runs read-only unless you pass `allowFileEdits: true`. Pass it, with `allowedEditGlobs`, only when the task must change files.
7. Pass `contextFiles` as paths relative to `cwd`. The tools reject absolute paths and paths outside `cwd`.
8. To inspect 7-day token ratios or circuit-breaker status before a large run, call `claugle_quota`.
9. Put a Gemini task into one delegation call. Pass every file it needs in `contextFiles` and state the whole request at once. Each agy run carries a fixed cost of about 7k tokens and reads files inside its own gated run, so one call that reads several files pays that cost once.
10. When the session's main model is a Google model through the gateway, every tool step resends Claude Code's system prompt, tool schemas, and context, about 24k tokens per step. For work that needs many tool steps, use a Claude main model and delegate the long reading and long writing parts to claugle.

See [`sketch.d.ts`](../../types/sketch.d.ts) for domain types, [`policy-engine.mjs`](../../scripts/policy-engine.mjs) for the 32-cell lookup table, and [`README.md`](../../README.md) for pool budgets and hysteresis thresholds.
