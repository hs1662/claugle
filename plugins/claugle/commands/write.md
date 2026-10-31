---
description: Delegate writing, documentation, translation, or summarization to Google AI Gemini models via claugle.
argument-hint: "[--model <slug>] [--allow-edits] [--glob <pattern>] <prompt>"
allowed-tools: Bash, mcp__plugin_claugle_claugle__claugle_write
---

Route the user's writing or documentation task through `claugle` by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/claugle.mjs" write "$ARGUMENTS"
```

Return the output directly without rewriting it in the host session.
