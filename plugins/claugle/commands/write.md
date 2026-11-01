---
description: Delegate writing, documentation, translation, or summarization to Google AI Gemini models via claugle.
argument-hint: "[--model <slug>] [--allow-edits] [--glob <pattern>] <prompt>"
allowed-tools: Bash, mcp__plugin_claugle_claugle__claugle_write
---

Run `claugle.mjs` to route the writing or documentation task. Keep the arguments verbatim inside the quoted heredoc so the shell does not expand them:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/claugle.mjs" write --args-stdin <<'CLAUGLE_ARGS'
$ARGUMENTS
CLAUGLE_ARGS
```

Return the command output verbatim without rewriting it in the host session.
