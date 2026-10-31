---
description: Route any coding, research, or architecture task through claugle's 32-cell policy matrix and worktree sandbox.
argument-hint: "[--model <slug>] [--effort <level>] [--kind <task-kind>] [--allow-edits] <prompt>"
allowed-tools: Bash, mcp__plugin_claugle_claugle__claugle_run
---

Execute the routed task through `claugle` by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/claugle.mjs" run "$ARGUMENTS"
```

Report the outcome and any modified files or preserved worktree branch.
