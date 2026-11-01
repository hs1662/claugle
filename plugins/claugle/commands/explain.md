---
description: Show how claugle classifies a prompt and which fallback chain it selects under the current QuotaState.
argument-hint: "[--model <slug>] [--effort <level>] [--kind <task-kind>] <prompt>"
allowed-tools: Bash
---

Run `claugle.mjs` to print the `RoutePlan` without invoking a provider binary. Keep the arguments verbatim inside the quoted heredoc so the shell does not expand them:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/claugle.mjs" explain --args-stdin <<'CLAUGLE_ARGS'
$ARGUMENTS
CLAUGLE_ARGS
```

Report the task classification, the selected candidate chain, and any skipped candidates.
