---
description: Show 7-day rolling token usage across Claude Code, agy Claude, agy Gemini, and Gemini CLI pools plus current QuotaState.
allowed-tools: Bash, mcp__plugin_claugle_claugle__claugle_quota
---

Inspect the current `claugle` rolling quota snapshot and provider health by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/claugle.mjs" quota
```

Summarize the current `QuotaState` and per-pool consumption ratios for the user.
