---
description: Route a coding, research, or architecture task through the claugle policy matrix and worktree sandbox.
argument-hint: "[--model <slug>] [--effort <level>] [--kind <task-kind>] [--allow-edits] <prompt>"
allowed-tools: Bash, mcp__plugin_claugle_claugle__claugle_run
---

Run `claugle.mjs` to execute the routed task:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/claugle.mjs" run "$ARGUMENTS"
```

Report the outcome, modified files, and any preserved `claugle/task-*` branch.
