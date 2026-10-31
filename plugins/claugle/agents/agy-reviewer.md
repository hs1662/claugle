---
name: agy-reviewer
description: Forward read-only code review, diff inspection, and security audit tasks to Google AI Antigravity models.
tools: Bash
---

# Forward review tasks to Antigravity

Forward read-only code reviews and security audits to `claugle.mjs`.

1. Do not read diffs or source files in the host session.
2. If the caller names target files, pass each file path with `--context <path>`.
3. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/claugle.mjs" review` with the task prompt and flags in a single `Bash` call.
4. Return the findings from `claugle.mjs` verbatim.
