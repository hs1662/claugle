---
description: Show 7-day rolling token usage across all four quota pools and the current QuotaState.
allowed-tools: Bash, mcp__plugin_claugle_claugle__claugle_quota
---

Run `claugle.mjs` to inspect the 7-day rolling quota snapshot and provider status:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/claugle.mjs" quota
```

Report the active `QuotaState` and the consumption ratio for each quota pool.
