---
description: Explain how claugle classifies a prompt and which fallback chain it selects under the current QuotaState.
argument-hint: "[--model <slug>] [--effort <level>] [--kind <task-kind>] <prompt>"
allowed-tools: Bash
---

Compute and print the `RoutePlan` for the given prompt without executing a provider call:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/claugle.mjs" explain "$ARGUMENTS"
```

Present the classification, selected candidate chain, and skipped candidates.
