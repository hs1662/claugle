---
description: Select a Google AI Gemini or Claude model and reasoning effort, and sync the Claude Code /model picker.
argument-hint: "[model] [low|medium|high]"
allowed-tools: Bash
---

Run `claugle.mjs` to switch the active model and effort or inspect the registered `/model` picker families:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/claugle.mjs" model "$ARGUMENTS"
```

Report the active model family, the configured reasoning effort, and the resolved provider slug.
