---
name: claugle-routing
description: Internal routing policy reference for delegating tasks across Google AI subscription quota (agy and gemini CLI) based on task kind and rolling weekly quota state.
user-invocable: false
---

# Claugle routing policy

`claugle` governs weekly token consumption across four quota pools (`claude-code-native`, `agy-claude-pool`, `agy-gemini-pool`, and `gemini-cli-pool`) using a four-state hysteresis state machine and a 32-cell `(QuotaState, TaskKind)` lookup matrix.

## When to delegate via MCP tools

Prefer the `claugle` stdio MCP tools (`claugle_write`, `claugle_review`, `claugle_run`, `claugle_quota`) over spawning a subagent so the host Claude session avoids extra turn overhead:

- Call `claugle_write` for release notes, README and documentation edits, commit messages, PR descriptions, translations, and text summaries.
- Call `claugle_review` for read-only code reviews, PR audits, and security checks.
- Call `claugle_run` for routine coding tasks (`coding-trivial`) in `NORMAL` state, and for complex coding or architecture tasks when `QuotaState` enters `CONSERVE_CLAUDE` or `OVERFLOW_TO_AGY`.
- Call `claugle_quota` to inspect the 7-day rolling usage ratios and provider circuit-breaker health.
