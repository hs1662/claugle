# claugle: Google AI subscription quota router and weekly governor for Claude Code

> **한국어**: [`README.md`](README.md)

Drafting release notes, translating documentation, and reviewing routine pull requests inside Claude Code quickly drains your weekly host token budget. When you later need multi-file debugging or architecture work, the host quota is often gone. At the same time, a Google AI subscription includes generous weekly limits on Antigravity CLI (`agy`) and Gemini CLI (`gemini`) across Gemini 4 Argon, Gemini 3.8 Flash, Claude Opus 5.5, and Claude Sonnet 5.5. `claugle` connects those pools inside Claude Code and routes each task to the right model and reasoning effort based on task kind and remaining weekly quota.

`claugle` never scrapes private OAuth tokens or intercepts internal RPC traffic. It calls only documented headless CLI flags (`agy --input-format stream-json --output-format stream-json --disable-slash-commands` with the prompt on stdin, and `gemini -p --output-format json`) through standard Claude Code plugin boundaries (`.mcp.json`, `hooks/hooks.json`, `agents/*.md`, `commands/*.md`, and `skills/*/SKILL.md`).

## Install from GitHub

Register the GitHub repository as a Claude Code marketplace and install the plugin. All runtime code uses built-in Node.js (`>=18.18`) modules, so no `npm install` or build step is required.

```bash
claude plugin marketplace add https://github.com/hs1662/claugle.git
claude plugin install claugle@claugle
```

To register the marketplace and install the plugin in a single command, run:

```bash
claude plugin install claugle --marketplace https://github.com/hs1662/claugle.git
```

## How claugle governs quota and routing

`claugle` preserves host Claude Code tokens during normal operation and shifts heavier workloads to Google AI models as weekly usage rises.

1. **Task-specific routing.** Even in `NORMAL` state, `claugle` sends prose drafting (`writing`), documentation updates (`docs`), localization (`translation`), codebase exploration (`research`), read-only reviews (`review`), and small edits (`coding-trivial`) to `gemini-4-argon-high`, `gemini-3.8-flash-high`, and `claude-sonnet-5-5-high`. Host Claude Code stays reserved for `coding-complex` and `architecture`.
2. **Four-state hysteresis governor.** The governor tracks 7-day rolling token consumption across four pools and transitions between `NORMAL`, `CONSERVE_CLAUDE` (enters at 70% host usage, exits below 65%), `OVERFLOW_TO_AGY` (enters at 90%, exits below 82%), and `FALLBACK_GEMINI_CLI` (enters at 95% Antigravity usage, exits below 88%). Separate entry and exit thresholds prevent route oscillation near boundary values. A `QUOTA_EXHAUSTED` event in the ledger from the last 5 hours also moves the state, whatever the usage ratio. On `claude-code-native` it enters `OVERFLOW_TO_AGY`, and on either Antigravity pool it enters `FALLBACK_GEMINI_CLI`. The governor saves its last state to `${CLAUDE_PLUGIN_DATA}/governor-state.json`, so the hysteresis bands hold across processes.
3. **Deterministic 32-cell policy matrix.** Every combination of the 4 quota states and 8 task kinds maps to an ordered fallback chain of 3 route targets. If the primary target returns HTTP 429 (`QUOTA_EXHAUSTED`) or has an open circuit breaker, execution advances to the next candidate in the chain.
4. **Isolated git worktree sandbox.** When an external `agy` worker needs to edit files, `claugle` creates a detached git worktree under `${CLAUDE_PLUGIN_DATA}/worktrees/<taskId>`. After the worker exits, `claugle` verifies that every modified file matches `allowedEditGlobs` and applies the diff to the host working tree with `git apply`, leaving the host index untouched. It rejects the edits if the worktree grew a nested git repository or changed harness configuration: `.claude`, `.gemini`, `.mcp.json`, agy's customization folders `.agents`, `.agent`, `_agents` and `_agent`, or the instruction files `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` and `GEMINI.md` at any depth, the files they link to, and the files `CLAUDE.md` pulls in with `@path`. If the patch conflicts with uncommitted host changes, `claugle` leaves the host tree untouched and preserves the commit on branch `claugle/task-<id>`.
5. **Lock-free sharded ledger.** Each process appends `UsageLedgerEvent` records to its own `shard-<sessionId>-<pid>.jsonl` file so parallel subagents never contend on a lockfile. `SessionStart` deletes shards whose events are all older than 14 days, and orphaned worktrees older than 2 hours. Compaction never rewrites a shard, because another process may still be appending to it.

## Entry points

Choose any of the three invocation paths depending on your workflow.

| Entry point | Names | Purpose |
|---|---|---|
| **Stdio MCP tools** | `claugle_write`, `claugle_review`, `claugle_run`, `claugle_quota` | Direct JSON-RPC 2.0 calls from Claude without subagent turn overhead |
| **Slash commands** | `/claugle:model`, `/claugle:write`, `/claugle:review`, `/claugle:task`, `/claugle:quota`, `/claugle:explain` | Explicit user commands for switching model and effort, delegating tasks, or inspecting routing plans and 7-day usage |
| **Forwarding subagents** | `claugle:gemini-writer`, `claugle:agy-coder`, `claugle:agy-reviewer` | Single-command `Bash` forwarders that keep the host session from pre-reading repository files |
| **Native `/model` picker and gateway** | `/model` (`Alt+P`), `claugle model`, `claugle gateway --daemon` | Populates Claude Code's built-in `/model` picker with Google AI Gemini and Claude families plus inline `Left`/`Right` effort selection (`Low`/`Medium`/`High`) on `http://127.0.0.1:18789` |

## Repository layout and verification

- [`plugins/claugle/README.md`](plugins/claugle/README.md) documents the plugin manifest, quota pools, governor thresholds, MCP tools, commands, agents, and hooks.
- [`docs/architecture.md`](docs/architecture.md) records the domain data structures, the 3-candidate arena cross-judge synthesis, and design trade-offs.
- [`plugins/claugle/types/sketch.d.ts`](plugins/claugle/types/sketch.d.ts) defines the TypeScript domain contract shared across all runtime modules.
- [`tests/claugle.test.mjs`](tests/claugle.test.mjs) tests the 32-cell policy matrix, hysteresis governor, sharded ledger, git worktree sandbox, markdown contracts, and live stdio MCP server.

Run the test suite and the official Claude Code plugin validator locally with:

```bash
npm test
npm run validate
```
