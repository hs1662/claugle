# claugle

`claugle` routes Claude Code tasks across Google AI subscription models (`agy -p` and `gemini -p` headless CLIs) and governs 7-day rolling weekly token budgets across four quota pools.

## Install from GitHub

Add the marketplace repository and install `claugle` in Claude Code:

```bash
claude plugin marketplace add https://github.com/hs1662/claugle.git
claude plugin install claugle@claugle
```

Or install in one step:

```bash
claude plugin install claugle --marketplace https://github.com/hs1662/claugle.git
```

## Supported models and quota pools

`claugle` tracks four 7-day rolling quota pools:

1. `claude-code-native` for the host Claude Code session.
2. `agy-gemini-pool` for `gemini-4-argon-high`, `gemini-4-argon-medium`, `gemini-4-argon-low`, `gemini-3.8-flash-high`, `gemini-3.8-flash-medium`, `gemini-3.8-flash-low`, and `gpt-oss-120b-medium`.
3. `agy-claude-pool` for `claude-opus-5-5-high`, `claude-opus-5-5-medium`, `claude-opus-5-5-low`, `claude-sonnet-5-5-high`, `claude-sonnet-5-5-medium`, and `claude-sonnet-5-5-low`.
4. `gemini-cli-pool` for standalone `gemini-2.5-pro` and `gemini-2.5-flash`.

## Four-state hysteresis governor

The governor transitions across four states without oscillating at watermark boundaries:

- `NORMAL` routes prose writing, documentation, translation, research, routine code reviews, and trivial edits to Google AI models while keeping complex coding and architecture on host Claude Code.
- `CONSERVE_CLAUDE` activates at 70% native Claude weekly budget (exits below 65%) and shifts complex coding and architecture primary targets to `agy` Claude 5.5 and Gemini 4 Argon.
- `OVERFLOW_TO_AGY` activates at 90% native Claude weekly budget (exits below 82%) and offloads all eight task kinds to `agy` with `gemini-cli` fallback.
- `FALLBACK_GEMINI_CLI` activates at 95% `agy` pool usage (exits below 88%) and prioritizes standalone `gemini-cli` and low-cost `agy` fallback targets.

## MCP tools, slash commands, and subagents

### Stdio MCP tools

- `claugle_write` delegates prose writing, documentation updates, release notes, summarization, and translation to Gemini models.
- `claugle_review` runs read-only code reviews and security audits on `agy` Claude Sonnet 5.5, Opus 5.5, or Gemini 4 Argon.
- `claugle_run` executes routed coding, research, or architecture tasks with automatic git worktree isolation when `allowFileEdits` is enabled.
- `claugle_quota` reports 7-day rolling pool usage, current `QuotaState`, and provider circuit-breaker status.

### Slash commands

- `/claugle:write`
- `/claugle:review`
- `/claugle:task`
- `/claugle:quota`
- `/claugle:explain`

### Forwarding subagents

- `claugle:gemini-writer`
- `claugle:agy-coder`
- `claugle:agy-reviewer`
