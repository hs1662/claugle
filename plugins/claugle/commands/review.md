---
description: Run a read-only code review or security audit on Google AI Antigravity models via claugle.
argument-hint: "[--model <slug>] [--effort <level>] [--context <file>] <prompt>"
allowed-tools: Bash, mcp__plugin_claugle_claugle__claugle_review
---

Run `claugle.mjs` to route the read-only review request. Keep the arguments verbatim inside the quoted heredoc so the shell does not expand them:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/claugle.mjs" review --args-stdin <<'CLAUGLE_ARGS'
$ARGUMENTS
CLAUGLE_ARGS
```

Return the review findings verbatim to the user.
