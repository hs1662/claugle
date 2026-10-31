---
description: Delegate writing, documentation, translation, or summarization to Google AI Gemini models via claugle.
argument-hint: "[--model <slug>] [--allow-edits] [--glob <pattern>] <prompt>"
allowed-tools: Bash, mcp__plugin_claugle_claugle__claugle_write
---

Run `claugle.mjs` to route the writing or documentation task:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/claugle.mjs" write "$ARGUMENTS"
```

Return the command output verbatim without rewriting it in the host session.
