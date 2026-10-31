# Architecture and synthesis rationale

## Problem

Claude Code users who hold a Google AI subscription have access to thirteen `agy` headless models across the Gemini 4 Argon, Gemini 3.8 Flash, Claude Opus 5.5, Claude Sonnet 5.5, and GPT-OSS families, plus standalone `gemini` CLI models. Without automated routing, the host Claude Code session burns native weekly quota on prose writing, documentation updates, translation, summarization, and routine reviews while Google AI subscription quota sits idle.

The plugin must satisfy five structural constraints from Phase A grounding:
1. Claude Code caches marketplace plugins without running `npm install`, so every runtime script must run on stock Node.js (`>=18.18`) built-ins alone.
2. `plugin.json` must omit the `"agents"` array so Claude Code auto-discovers `agents/*.md`, and command files in `commands/*.md` must not collide with user-invocable skill names.
3. Forwarding subagents must stay thin (`tools: Bash`) so the host Claude model does not read repository files before invoking `agy -p`.
4. Every `agy -p` call must pass `--disable-slash-commands` to prevent recursive slash-command expansion.
5. File-editing tasks delegated to `agy -p` must not race against uncommitted buffers in the active working tree or concurrent subagents.

## Usage (caller's view)

A developer installs `claugle` directly from its GitHub repository URL inside Claude Code:

```bash
claude plugin marketplace add https://github.com/<owner>/claugle.git
claude plugin install claugle@claugle
```

Or in one command:

```bash
claude plugin install claugle --marketplace https://github.com/<owner>/claugle.git
```

### Call site 1: Stdio MCP server tools (`claugle_write`, `claugle_review`, `claugle_run`, `claugle_quota`)

Claude Code calls `claugle_write`, `claugle_review`, `claugle_run`, or `claugle_quota` over stdio JSON-RPC 2.0 via `.mcp.json` with zero subagent initialization overhead:

```json
{
	"name": "claugle_write",
	"arguments": {
		"prompt": "Write the migration guide for the storage subsystem.",
		"contextFiles": ["docs/architecture.md"],
		"preferredModel": "gemini-4-argon-high",
		"effort": "high"
	}
}
```

### Call site 2: Thin forwarding subagents and slash commands

Users invoke `/claugle:write`, `/claugle:review`, `/claugle:task`, `/claugle:quota`, or `/claugle:explain`, and Claude Code dispatches `claugle:gemini-writer`, `claugle:agy-coder`, or `claugle:agy-reviewer`. Each subagent runs a single `Bash` command through `scripts/claugle.mjs`.

### Call site 3: Programmatic Node ESM entrypoint

```ts
import {
	executeRoutedTask,
	parsePluginEnv,
	parseTaskRequest,
} from "./claugle.mjs";

const env = parsePluginEnv(process.env);
const request = parseTaskRequest({
	prompt: "Update docs/routing.md to document the four quota states.",
	explicitTaskKind: "docs",
	cwd: process.cwd(),
	allowFileEdits: true,
	allowedEditGlobs: ["docs/**/*.md", "README.md"],
});

if (env.kind === "ok" && request.kind === "ok") {
	const outcome = await executeRoutedTask({
		request: request.value,
		env: env.value,
	});
}
```

## Shape

The architecture centers on three domain structures, per `principle-foundational-thinking` and `principle-model-the-domain`:

1. **`QuotaState` and `GovernorThresholds` (four-state hysteresis machine).** Weekly quota consumption across `claude-code-native`, `agy-claude-pool`, `agy-gemini-pool`, and `gemini-cli-pool` transitions across four states: `NORMAL`, `CONSERVE_CLAUDE`, `OVERFLOW_TO_AGY`, and `FALLBACK_GEMINI_CLI`. Each watermark uses a `HysteresisBand` (`enterAt` and `exitBelow`, where `exitBelow < enterAt`) so state transitions do not oscillate near threshold boundaries.
2. **`PolicyMatrix` (total 32-cell 2D lookup table).** Routing policy is a compile-time total map `Readonly<Record<QuotaState, Readonly<Record<TaskKind, NonEmptyArray<RouteTarget>>>>>`. Every combination of the four quota states and eight task kinds (`writing`, `docs`, `translation`, `research`, `review`, `coding-trivial`, `coding-complex`, `architecture`) maps to a non-empty ordered fallback chain of targets.
3. **`RouteTarget` (discriminated union by `provider`).** `RouteTarget` branches on `provider` (`"claude-native" | "agy" | "gemini-cli"`), per `principle-type-system-discipline`. `AgyCliInvocation` types `disableSlashCommands` as `true`, encoding the recursion guard in structure, per `principle-encode-lessons-in-structure`.

Validation happens at the boundary in `parsePluginEnv`, `parseTaskRequest`, `parseAgyOutputJson`, and `parseGeminiCliOutputJson`, per `principle-boundary-discipline`.

Concurrent state writes are eliminated in two places, per `principle-separate-before-serializing-shared-state` and `principle-make-operations-idempotent`:
- **Per-process JSONL ledger shards.** Each process appends `UsageLedgerEvent` lines to `${CLAUDE_PLUGIN_DATA}/ledger/shard-${sessionId}-${pid}.jsonl`. `loadRollingQuotaSnapshot` merges active shards at read time, deduplicates by `TaskExecutionId`, and `compactExpiredLedgerShards` prunes stale shards older than 14 days during `SessionStart`.
- **Task-scoped git worktrees.** When `executeRoutedTask` runs an `agy` target with `isolation.kind === "git-worktree"`, `acquireWorktreeLease` creates a detached worktree at `${CLAUDE_PLUGIN_DATA}/worktrees/${taskId}`. After `agy -p` finishes, `harvestAndReleaseWorktree` verifies that every modified path matches `allowedGlobs`, applies the diff to the host repository with `git apply --3way`, or preserves the commit on branch `claugle/task-${taskId}` if the host tree has conflicting edits.

## Synthesis decision

Candidate 2 (24.5/25 in Cross-Judge evaluation) became the base because it models the domain with a four-state hysteresis governor, a 32-cell 2D `PolicyMatrix` with non-empty fallback chains, task-scoped git worktree isolation, and type-enforced CLI invariants.

Grafted from Candidate 1 (19.0/25):
1. First-class stdio MCP server tool schemas (`claugle_run`, `claugle_write`, `claugle_review`, `claugle_quota`) in `.mcp.json` and `scripts/mcp-server.mjs` so Claude Code can invoke routed tools without spawning a subagent.
2. Static `ModelCapability` metadata registry and 14-day stale shard compaction on `SessionStart`.

Grafted from Candidate 3 (10.0/25):
1. Shell-safe single-argument tokenization for slash commands that pass `"$ARGUMENTS"` as one string.

Rejected:
- Candidate 3's single `ledger.json` file (race condition under concurrent subagents) and rejection of MCP tools.
- Candidate 1's direct in-place file edits without worktree isolation.

## Tradeoffs accepted

- We accept reading and merging per-process JSONL shard files on `loadRollingQuotaSnapshot` calls in exchange for zero lockfile contention across concurrent processes.
- We accept creating a temporary git worktree for file-editing `agy -p` calls in exchange for protecting uncommitted host edits from concurrent overwrite.
- We accept a deterministic lexical classifier in `classifyTask` in exchange for sub-10ms `UserPromptSubmit` hook latency and zero classification token burn.

## Alternatives considered

1. **Dynamic floating-point utility router.** Rejected because opaque weight formulas are harder to audit and test than an explicit 32-cell `(QuotaState, TaskKind)` lookup table.
2. **Single lockfile-guarded JSON ledger.** Rejected because stock Node.js has no portable built-in cross-process lock and crashed processes leave stale locks.
3. **Background Unix socket daemon.** Rejected because orphaned daemons and stale sockets complicate plugin updates and lifecycle teardown.

## Implementation reconciliation

All modules under `plugins/claugle/scripts/` implement the contracts in `plugins/claugle/types/sketch.d.ts`.

## Open questions and risks

1. Should default weekly token budgets in `userConfig` be tuned per subscription tier (`Pro` vs `Ultra`) via `/plugin configure claugle`?
2. When a 3-way patch apply conflicts with dirty host files and preserves commits on `claugle/task-<id>`, should the MCP response include the exact `git cherry-pick` command?

## Next implementation step

Implement the synthesized core modules (`policy-engine.mjs`, `ledger-store.mjs`, `worktree-sandbox.mjs`, `provider-runner.mjs`, `mcp-server.mjs`, and `claugle.mjs`) and plugin manifests, then verify with `node --test` and `claude plugin validate . --strict`.
