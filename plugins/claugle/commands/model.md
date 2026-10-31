---
description: Select a Google AI Gemini or Claude model and reasoning effort, and sync the Claude Code /model picker.
argument-hint: "[model] [low|medium|high]"
allowed-tools: Bash
---

Run `claugle.mjs` to switch the active model and effort or inspect the registered `/model` picker families. Keep the arguments verbatim inside the quoted heredoc so the shell does not expand them:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/claugle.mjs" model --args-stdin <<'CLAUGLE_ARGS'
$ARGUMENTS
CLAUGLE_ARGS
```

Report the active model family, the configured reasoning effort, and the resolved provider slug.
