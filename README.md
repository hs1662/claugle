# claugle

`claugle` is a Claude Code plugin marketplace repository providing the `claugle` plugin. `claugle` integrates Google AI subscription model quota (`agy -p` and `gemini -p` headless CLIs) into Claude Code, automatically routing writing, documentation, translation, review, and overflow coding tasks across Gemini 4 Argon, Gemini 3.8 Flash, Claude Opus 5.5, Claude Sonnet 5.5, and Gemini 2.5 models.

## Quick start

Install `claugle` in Claude Code directly from GitHub:

```bash
claude plugin marketplace add https://github.com/hs1662/claugle.git
claude plugin install claugle@claugle
```

## Architecture highlights

- **Zero external dependencies.** Every runtime module under `plugins/claugle/scripts/` uses only built-in Node.js (`>=18.18`) modules so Claude Code marketplace caching works out of the box without `npm install`.
- **32-cell policy matrix and hysteresis governor.** `plugins/claugle/scripts/policy-engine.mjs` maps all four `QuotaState` values (`NORMAL`, `CONSERVE_CLAUDE`, `OVERFLOW_TO_AGY`, `FALLBACK_GEMINI_CLI`) and eight `TaskKind` values (`writing`, `docs`, `translation`, `research`, `review`, `coding-trivial`, `coding-complex`, `architecture`) to non-empty ordered fallback chains.
- **Lock-free per-process JSONL ledger shards.** `plugins/claugle/scripts/ledger-store.mjs` writes usage events to `${CLAUDE_PLUGIN_DATA}/ledger/shard-${sessionId}-${pid}.jsonl`, merges and deduplicates events over a 7-day rolling window at read time, and compacts shards older than 14 days on `SessionStart`.
- **Task-scoped git worktree sandboxing.** `plugins/claugle/scripts/worktree-sandbox.mjs` isolates file-editing `agy -p` invocations in detached worktrees, validates modified paths against `allowedGlobs`, applies clean patches to the host repository with `git apply --3way`, and preserves conflicting edits on `claugle/task-<id>` branches without dirtying the host tree.
- **Recursion guard encoded in structure.** `buildAgyCliArgs` always includes `--disable-slash-commands` and `CLAUGLE_HEADLESS_SUBPROCESS=1`.

## Verification

Run the test suite and strict Claude Code plugin validator:

```bash
npm test
npm run validate
```

See [docs/architecture.md](docs/architecture.md) for the synthesis rationale and [plugins/claugle/types/sketch.d.ts](plugins/claugle/types/sketch.d.ts) for the TypeScript contract.
