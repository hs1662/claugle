---
description: Run a read-only code review or security audit on Google AI Antigravity models via claugle.
argument-hint: "[--model <slug>] [--effort <level>] [--context <file>] <prompt>"
allowed-tools: Bash, mcp__plugin_claugle_claugle__claugle_review
---

Route the review request through `claugle` by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/claugle.mjs" review "$ARGUMENTS"
```

Present the review findings directly to the user.
