---
description: Show how claugle classifies a prompt and which fallback chain it selects under the current QuotaState.
argument-hint: "[--model <slug>] [--effort <level>] [--kind <task-kind>] <prompt>"
allowed-tools: Bash
---

Run `claugle.mjs` to print the `RoutePlan` without invoking a provider binary:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/claugle.mjs" explain "$ARGUMENTS"
```

Report the task classification, the selected candidate chain, and any skipped candidates.
