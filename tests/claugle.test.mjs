import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
	ALL_QUOTA_POOLS,
	ALL_QUOTA_STATES,
	ALL_TASK_KINDS,
	DEFAULT_GOVERNOR_THRESHOLDS,
	DEFAULT_POLICY_MATRIX,
	MCP_TOOL_DEFINITIONS,
	MODEL_CAPABILITIES,
	MODEL_FAMILY_CATALOG,
	acquireWorktreeLease,
	appendUsageEvent,
	buildAgyCliArgs,
	buildClaudeModelPickerConfig,
	classifyTask,
	compactExpiredLedgerShards,
	createTaskExecutionId,
	evaluateHookEvent,
	executeRoutedTask,
	harvestAndReleaseWorktree,
	isAgyModelSlug,
	isGeminiCliModelSlug,
	isUnitIntervalRatio,
	loadRollingQuotaSnapshot,
	parseAbsolutePath,
	parseAgyOutputJson,
	parseGeminiCliOutputJson,
	parsePluginEnv,
	parseRelativeGlob,
	parseTaskRequest,
	reconcileStaleWorktrees,
	resolveModelAlias,
	resolveModelAndEffort,
	resolveRoutePlan,
	startAnthropicGatewayServer,
	syncClaudeModelPickerSettings,
	tokenizeShellArgs,
	transitionQuotaState,
} from "../plugins/claugle/scripts/claugle.mjs";

function makeMetricsWithRatios(ratios = {}) {
	const pools = {};
	for (const poolId of ALL_QUOTA_POOLS) {
		const ratio = ratios[poolId] ?? 0;
		const budget = 1_000_000;
		pools[poolId] = {
			poolId,
			consumedTokens: Math.floor(ratio * budget),
			weeklyTokenBudget: budget,
			consumedRatio: ratio,
			requestCount: ratio > 0 ? 1 : 0,
			rateLimitHitsInWindow: 0,
			lastRateLimitAt: null,
		};
	}
	return {
		windowStart: 1_000_000,
		windowEnd: 2_000_000,
		pools,
	};
}

function createTempGitRepo() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claugle-repo-"));
	execFileSync("git", ["init", "-b", "main"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
	fs.mkdirSync(path.join(dir, "src"), { recursive: true });
	fs.writeFileSync(path.join(dir, "docs", "guide.md"), "line 1\nline 2\nline 3\n", "utf8");
	fs.writeFileSync(path.join(dir, "src", "index.js"), "export const x = 1;\n", "utf8");
	execFileSync("git", ["add", "-A"], { cwd: dir });
	execFileSync("git", ["commit", "-m", "initial commit", "--no-gpg-sign"], { cwd: dir });
	return dir;
}

describe("PolicyMatrix and ModelCapabilities", () => {
	it("registers all 13 agy models and 2 gemini-cli models with valid metadata", () => {
		const expectedAgyModels = [
			"gemini-4-argon-high",
			"gemini-4-argon-medium",
			"gemini-4-argon-low",
			"gemini-3.8-flash-high",
			"gemini-3.8-flash-medium",
			"gemini-3.8-flash-low",
			"claude-opus-5-5-high",
			"claude-opus-5-5-medium",
			"claude-opus-5-5-low",
			"claude-sonnet-5-5-high",
			"claude-sonnet-5-5-medium",
			"claude-sonnet-5-5-low",
			"gpt-oss-120b-medium",
		];
		const expectedGeminiCliModels = ["gemini-2.5-pro", "gemini-2.5-flash"];

		for (const slug of expectedAgyModels) {
			assert.equal(isAgyModelSlug(slug), true, `expected ${slug} to be recognized as agy model`);
			assert.equal(MODEL_CAPABILITIES[slug].provider, "agy");
		}
		for (const slug of expectedGeminiCliModels) {
			assert.equal(
				isGeminiCliModelSlug(slug),
				true,
				`expected ${slug} to be recognized as gemini-cli model`
			);
			assert.equal(MODEL_CAPABILITIES[slug].provider, "gemini-cli");
		}
		assert.equal(isAgyModelSlug("unknown-model"), false);
		assert.equal(isGeminiCliModelSlug("gemini-4-argon-high"), false);
	});

	it("populates all 32 (QuotaState, TaskKind) cells with non-empty ordered fallback chains", () => {
		let cellCount = 0;
		for (const state of ALL_QUOTA_STATES) {
			assert.ok(DEFAULT_POLICY_MATRIX[state], `missing state row for ${state}`);
			for (const kind of ALL_TASK_KINDS) {
				const chain = DEFAULT_POLICY_MATRIX[state][kind];
				assert.ok(Array.isArray(chain) && chain.length >= 2, `cell (${state}, ${kind}) must have fallback chain`);
				for (const target of chain) {
					assert.ok(
						target.provider === "claude-native" ||
							target.provider === "agy" ||
							target.provider === "gemini-cli"
					);
				}
				cellCount += 1;
			}
		}
		assert.equal(cellCount, 32);

		assert.equal(DEFAULT_POLICY_MATRIX.NORMAL.writing[0].provider, "agy");
		assert.equal(DEFAULT_POLICY_MATRIX.NORMAL.docs[0].provider, "agy");
		assert.equal(DEFAULT_POLICY_MATRIX.NORMAL.translation[0].provider, "agy");
		assert.equal(DEFAULT_POLICY_MATRIX.NORMAL["coding-complex"][0].provider, "claude-native");
		assert.equal(DEFAULT_POLICY_MATRIX.CONSERVE_CLAUDE["coding-complex"][0].provider, "agy");
		assert.equal(DEFAULT_POLICY_MATRIX.OVERFLOW_TO_AGY.architecture[0].provider, "agy");
		assert.equal(DEFAULT_POLICY_MATRIX.FALLBACK_GEMINI_CLI.writing[0].provider, "gemini-cli");
	});

	it("validates boundary inputs and rejects malformed paths, globs, and provider JSON", () => {
		assert.equal(isUnitIntervalRatio(0), true);
		assert.equal(isUnitIntervalRatio(0.75), true);
		assert.equal(isUnitIntervalRatio(1), true);
		assert.equal(isUnitIntervalRatio(-0.1), false);
		assert.equal(isUnitIntervalRatio(1.01), false);

		assert.equal(parseAbsolutePath("/tmp/example").kind, "ok");
		assert.equal(parseAbsolutePath("relative/path").kind, "error");
		assert.equal(parseRelativeGlob("docs/**/*.md").kind, "ok");
		assert.equal(parseRelativeGlob("../outside.md").kind, "error");
		assert.equal(parseRelativeGlob("/abs/path.md").kind, "error");

		const badEnv = parsePluginEnv({
			CLAUDE_PLUGIN_ROOT: "/tmp",
			CLAUDE_PLUGIN_DATA: "/tmp/data",
			CLAUDE_PROJECT_DIR: "/tmp",
			CLAUGLE_CLAUDE_WEEKLY_TOKEN_BUDGET: "-100",
		});
		assert.equal(badEnv.kind, "error");

		const badReq = parseTaskRequest({ prompt: "   " });
		assert.equal(badReq.kind, "error");

		const validAgy = parseAgyOutputJson(
			JSON.stringify({
				conversation_id: "conv-123",
				response: "Completed review",
				duration_seconds: 1.5,
				num_turns: 2,
				usage: {
					input_tokens: 120,
					output_tokens: 80,
					thinking_tokens: 30,
					cache_read_tokens: 10,
					total_tokens: 230,
				},
			})
		);
		assert.equal(validAgy.kind, "ok");
		assert.equal(validAgy.value.usage.totalTokens, 230);
		assert.equal(parseAgyOutputJson("{not-json").kind, "error");
		assert.equal(parseGeminiCliOutputJson(JSON.stringify({ text: "Translated text" })).kind, "ok");

		const tokens = tokenizeShellArgs('--model gemini-4-argon-high --glob "docs/**/*.md" "Write guide"');
		assert.deepEqual(tokens, ["--model", "gemini-4-argon-high", "--glob", "docs/**/*.md", "Write guide"]);
	});
});

describe("Hysteresis QuotaState Governor", () => {
	it("transitions cleanly across all 4 states without oscillating inside hysteresis bands", () => {
		let state = "NORMAL";

		state = transitionQuotaState(
			state,
			makeMetricsWithRatios({ "claude-code-native": 0.69 }),
			DEFAULT_GOVERNOR_THRESHOLDS
		);
		assert.equal(state, "NORMAL");

		state = transitionQuotaState(
			state,
			makeMetricsWithRatios({ "claude-code-native": 0.70 }),
			DEFAULT_GOVERNOR_THRESHOLDS
		);
		assert.equal(state, "CONSERVE_CLAUDE");

		state = transitionQuotaState(
			state,
			makeMetricsWithRatios({ "claude-code-native": 0.67 }),
			DEFAULT_GOVERNOR_THRESHOLDS
		);
		assert.equal(
			state,
			"CONSERVE_CLAUDE",
			"must stay in CONSERVE_CLAUDE inside [0.65, 0.70] hysteresis band"
		);

		state = transitionQuotaState(
			state,
			makeMetricsWithRatios({ "claude-code-native": 0.64 }),
			DEFAULT_GOVERNOR_THRESHOLDS
		);
		assert.equal(state, "NORMAL");

		state = transitionQuotaState(
			state,
			makeMetricsWithRatios({ "claude-code-native": 0.91 }),
			DEFAULT_GOVERNOR_THRESHOLDS
		);
		assert.equal(state, "OVERFLOW_TO_AGY");

		state = transitionQuotaState(
			state,
			makeMetricsWithRatios({ "claude-code-native": 0.85 }),
			DEFAULT_GOVERNOR_THRESHOLDS
		);
		assert.equal(
			state,
			"OVERFLOW_TO_AGY",
			"must stay in OVERFLOW_TO_AGY inside [0.82, 0.90] hysteresis band"
		);

		state = transitionQuotaState(
			state,
			makeMetricsWithRatios({ "claude-code-native": 0.80 }),
			DEFAULT_GOVERNOR_THRESHOLDS
		);
		assert.equal(state, "CONSERVE_CLAUDE");

		state = transitionQuotaState(
			state,
			makeMetricsWithRatios({
				"claude-code-native": 0.92,
				"agy-gemini-pool": 0.96,
			}),
			DEFAULT_GOVERNOR_THRESHOLDS
		);
		assert.equal(state, "FALLBACK_GEMINI_CLI");

		state = transitionQuotaState(
			state,
			makeMetricsWithRatios({
				"claude-code-native": 0.92,
				"agy-gemini-pool": 0.90,
			}),
			DEFAULT_GOVERNOR_THRESHOLDS
		);
		assert.equal(
			state,
			"FALLBACK_GEMINI_CLI",
			"must stay in FALLBACK_GEMINI_CLI inside [0.88, 0.95] hysteresis band"
		);

		state = transitionQuotaState(
			state,
			makeMetricsWithRatios({
				"claude-code-native": 0.86,
				"agy-gemini-pool": 0.85,
			}),
			DEFAULT_GOVERNOR_THRESHOLDS
		);
		assert.equal(state, "OVERFLOW_TO_AGY");
	});
});

describe("Deterministic Task Classifier", () => {
	it("classifies all 8 task kinds accurately and honors explicit overrides", () => {
		assert.equal(
			classifyTask("Draft release notes and a blog post summary for v2.0").taskKind,
			"writing"
		);
		assert.equal(
			classifyTask("Update the README and API documentation in docs/guide.md").taskKind,
			"docs"
		);
		assert.equal(
			classifyTask("Translate the onboarding strings into Japanese and Spanish for i18n").taskKind,
			"translation"
		);
		assert.equal(
			classifyTask("Explain how the hysteresis state machine transitions work").taskKind,
			"research"
		);
		assert.equal(
			classifyTask("Run a security review on this pull request diff and find bugs").taskKind,
			"review"
		);
		assert.equal(
			classifyTask("Fix typo and rename constant in helper").taskKind,
			"coding-trivial"
		);
		assert.equal(
			classifyTask("Refactor the parser algorithm to fix the race condition").taskKind,
			"coding-complex"
		);
		assert.equal(
			classifyTask("Design the system architecture and RFC domain model trade-offs").taskKind,
			"architecture"
		);
		assert.equal(classifyTask("릴리스 노트 초안 작성해줘").taskKind, "writing");
		assert.equal(classifyTask("가이드 문서 수정해줘").taskKind, "docs");
		assert.equal(classifyTask("일본어로 번역해줘").taskKind, "translation");
		assert.equal(classifyTask("동작 원리 설명해줘").taskKind, "research");
		assert.equal(classifyTask("변경사항 코드 리뷰해줘").taskKind, "review");
		assert.equal(classifyTask("오타 수정해줘").taskKind, "coding-trivial");
		assert.equal(classifyTask("동시성 레이스 컨디션 버그 수정해줘").taskKind, "coding-complex");
		assert.equal(classifyTask("시스템 아키텍처와 도메인 모델 설계해줘").taskKind, "architecture");

		const overridden = classifyTask("Random prompt text", "translation", false);
		assert.equal(overridden.taskKind, "translation");
		assert.equal(overridden.confidence, 1.0);
	});
});

describe("Lock-free JSONL Ledger Store", () => {
	it("merges multi-process shards, deduplicates eventIds, filters 7-day window, and compacts 14-day shards", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claugle-ledger-"));
		const nowMs = 1_750_000_000_000;
		const oneDayMs = 24 * 60 * 60 * 1000;

		const sharedId = createTaskExecutionId(nowMs - oneDayMs, "deadbeef");

		appendUsageEvent({
			pluginDataDir: tmpDir,
			pid: 1001,
			event: {
				eventId: sharedId,
				sessionId: "sess-a",
				recordedAt: nowMs - oneDayMs,
				provider: "claude-native",
				quotaPool: "claude-code-native",
				modelSlug: "claude-host",
				taskKind: "coding-complex",
				totalTokens: 3_600_000,
				status: "SUCCESS",
			},
		});

		appendUsageEvent({
			pluginDataDir: tmpDir,
			pid: 1002,
			event: {
				eventId: sharedId,
				sessionId: "sess-a",
				recordedAt: nowMs - oneDayMs,
				provider: "claude-native",
				quotaPool: "claude-code-native",
				modelSlug: "claude-host",
				taskKind: "coding-complex",
				totalTokens: 3_600_000,
				status: "SUCCESS",
			},
		});

		appendUsageEvent({
			pluginDataDir: tmpDir,
			pid: 1002,
			event: {
				eventId: createTaskExecutionId(nowMs - 2 * oneDayMs, "cafebabe"),
				sessionId: "sess-b",
				recordedAt: nowMs - 2 * oneDayMs,
				provider: "agy",
				quotaPool: "agy-gemini-pool",
				modelSlug: "gemini-4-argon-high",
				taskKind: "writing",
				totalTokens: 1_500_000,
				status: "SUCCESS",
			},
		});

		appendUsageEvent({
			pluginDataDir: tmpDir,
			pid: 1003,
			event: {
				eventId: createTaskExecutionId(nowMs - 20 * oneDayMs, "11112222"),
				sessionId: "sess-expired",
				recordedAt: nowMs - 20 * oneDayMs,
				provider: "claude-native",
				quotaPool: "claude-code-native",
				modelSlug: "claude-host",
				taskKind: "coding-complex",
				totalTokens: 4_900_000,
				status: "SUCCESS",
			},
		});

		const snapshot = loadRollingQuotaSnapshot({
			pluginDataDir: tmpDir,
			nowMs,
		});

		assert.equal(snapshot.shardCount, 4);
		assert.equal(snapshot.totalEventsInWindow, 2, "expired 20-day event and duplicate eventId must be excluded");
		assert.equal(snapshot.metrics.pools["claude-code-native"].consumedTokens, 3_600_000);
		assert.equal(snapshot.metrics.pools["claude-code-native"].consumedRatio, 0.72);
		assert.equal(snapshot.quotaState, "CONSERVE_CLAUDE");

		const compaction = compactExpiredLedgerShards({
			pluginDataDir: tmpDir,
			nowMs,
		});
		assert.equal(compaction.removedShards.length, 1);
		assert.equal(compaction.retainedShards.length, 3);

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});
});

describe("Git Worktree Sandbox", () => {
	it("applies clean edits to host repo, preserves conflicting edits on branch, rejects glob violations, and prunes stale worktrees", () => {
		const repoDir = createTempGitRepo();
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "claugle-wt-data-"));

		const cleanLease = acquireWorktreeLease({
			taskId: "task-clean-1",
			hostRepoRoot: repoDir,
			pluginDataDir: dataDir,
			allowedGlobs: ["docs/**/*.md"],
			applyStrategy: "patch-if-clean",
		});
		fs.writeFileSync(
			path.join(cleanLease.worktreePath, "docs", "guide.md"),
			"line 1\nupdated in worktree\nline 3\n",
			"utf8"
		);
		const cleanOutcome = harvestAndReleaseWorktree(cleanLease);
		assert.equal(cleanOutcome.kind, "applied-to-host");
		assert.deepEqual(cleanOutcome.modifiedFiles, ["docs/guide.md"]);
		assert.equal(
			fs.readFileSync(path.join(repoDir, "docs", "guide.md"), "utf8"),
			"line 1\nupdated in worktree\nline 3\n"
		);
		assert.equal(fs.existsSync(cleanLease.worktreePath), false);

		const globLease = acquireWorktreeLease({
			taskId: "task-glob-violation",
			hostRepoRoot: repoDir,
			pluginDataDir: dataDir,
			allowedGlobs: ["docs/**/*.md"],
			applyStrategy: "patch-if-clean",
		});
		fs.writeFileSync(path.join(globLease.worktreePath, "src", "index.js"), "export const x = 999;\n", "utf8");
		const globOutcome = harvestAndReleaseWorktree(globLease);
		assert.equal(globOutcome.kind, "rejected-glob-violation");
		assert.deepEqual(globOutcome.violatingFiles, ["src/index.js"]);
		assert.equal(
			fs.readFileSync(path.join(repoDir, "src", "index.js"), "utf8"),
			"export const x = 1;\n",
			"host file must remain untouched when glob check fails"
		);

		const conflictLease = acquireWorktreeLease({
			taskId: "task-conflict-1",
			hostRepoRoot: repoDir,
			pluginDataDir: dataDir,
			allowedGlobs: ["docs/**/*.md"],
			applyStrategy: "patch-if-clean",
		});
		fs.writeFileSync(
			path.join(conflictLease.worktreePath, "docs", "guide.md"),
			"line 1\nworktree conflicting edit\nline 3\n",
			"utf8"
		);
		fs.writeFileSync(
			path.join(repoDir, "docs", "guide.md"),
			"line 1\nhost conflicting uncommitted edit\nline 3\n",
			"utf8"
		);
		const conflictOutcome = harvestAndReleaseWorktree(conflictLease);
		assert.equal(conflictOutcome.kind, "preserved-on-branch");
		assert.equal(conflictOutcome.reason, "HOST_CONFLICT_ON_3WAY_APPLY");
		assert.equal(conflictOutcome.branchName, "claugle/task-conflict-1");
		assert.equal(
			fs.readFileSync(path.join(repoDir, "docs", "guide.md"), "utf8"),
			"line 1\nhost conflicting uncommitted edit\nline 3\n",
			"host working tree must not contain conflict markers"
		);
		const branchSha = execFileSync("git", ["rev-parse", "--verify", "claugle/task-conflict-1"], {
			cwd: repoDir,
			encoding: "utf8",
		}).trim();
		assert.ok(branchSha.length >= 7);

		const staleLease = acquireWorktreeLease({
			taskId: "task-stale-1",
			hostRepoRoot: repoDir,
			pluginDataDir: dataDir,
		});
		const oldTime = new Date(Date.now() - 4 * 60 * 60 * 1000);
		fs.utimesSync(staleLease.worktreePath, oldTime, oldTime);
		const pruned = reconcileStaleWorktrees({
			hostRepoRoot: repoDir,
			pluginDataDir: dataDir,
			nowMs: Date.now(),
		});
		assert.equal(pruned.prunedWorktrees.length, 1);
		assert.equal(fs.existsSync(staleLease.worktreePath), false);

		fs.rmSync(repoDir, { recursive: true, force: true });
		fs.rmSync(dataDir, { recursive: true, force: true });
	});
});

describe("End-to-End Provider Execution, Hooks, and Live Stdio MCP Server", () => {
	it("enforces --disable-slash-commands, falls back on QUOTA_EXHAUSTED, applies worktree edits, and serves MCP tools over stdio", async () => {
		const repoDir = createTempGitRepo();
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "claugle-e2e-data-"));
		const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "claugle-e2e-bin-"));
		const mockAgyPath = path.join(binDir, "mock-agy");
		const mockGeminiPath = path.join(binDir, "mock-gemini");

		fs.writeFileSync(
			mockAgyPath,
			`#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (!args.includes("--disable-slash-commands")) {
	process.stderr.write("Missing --disable-slash-commands\\n");
	process.exit(2);
}
const modelIdx = args.indexOf("--model");
const model = modelIdx >= 0 ? args[modelIdx + 1] : "unknown";
const modeIdx = args.indexOf("--mode");
const mode = modeIdx >= 0 ? args[modeIdx + 1] : "plan";

if (model === "claude-sonnet-5-5-high") {
	process.stderr.write("Error 429: QUOTA_EXHAUSTED for claude-sonnet-5-5-high\\n");
	process.exit(1);
}

if (mode === "accept-edits" && fs.existsSync(path.join(process.cwd(), "docs", "guide.md"))) {
	fs.writeFileSync(path.join(process.cwd(), "docs", "guide.md"), "# Updated by mock-agy\\n", "utf8");
}

process.stdout.write(JSON.stringify({
	conversation_id: "conv-mock-agy",
	response: "Executed on " + model,
	duration_seconds: 0.4,
	num_turns: 1,
	usage: {
		input_tokens: 500,
		output_tokens: 250,
		thinking_tokens: 50,
		cache_read_tokens: 0,
		total_tokens: 800
	}
}) + "\\n");
`,
			{ mode: 0o755 }
		);

		fs.writeFileSync(
			mockGeminiPath,
			`#!/usr/bin/env node
process.stdout.write(JSON.stringify({
	session_id: "sess-mock-gemini",
	response: "Executed on gemini-cli",
	usage: { input_tokens: 100, output_tokens: 100, total_tokens: 200 }
}) + "\\n");
`,
			{ mode: 0o755 }
		);

		const builtArgs = buildAgyCliArgs({
			binaryPath: mockAgyPath,
			prompt: "Check args",
			modelSlug: "gemini-4-argon-high",
			effort: "high",
			mode: "plan",
			outputFormat: "json",
			disableSlashCommands: true,
			cwd: repoDir,
			timeoutMs: 10_000,
		});
		assert.ok(builtArgs.includes("--disable-slash-commands"));

		const envRes = parsePluginEnv({
			CLAUDE_PLUGIN_DATA: dataDir,
			CLAUDE_PROJECT_DIR: repoDir,
			CLAUDE_SESSION_ID: "e2e-session",
			CLAUGLE_AGY_BIN: mockAgyPath,
			CLAUGLE_GEMINI_BIN: mockGeminiPath,
		});
		assert.equal(envRes.kind, "ok");

		const reviewReq = parseTaskRequest({
			prompt: "Review this pull request diff for security bugs",
			cwd: repoDir,
		});
		assert.equal(reviewReq.kind, "ok");

		const reviewOutcome = await executeRoutedTask({
			request: reviewReq.value,
			env: envRes.value,
		});
		assert.equal(reviewOutcome.status, "COMPLETED");
		assert.equal(reviewOutcome.attemptedTargets.length, 2, "must fall back after primary QUOTA_EXHAUSTED");
		assert.equal(reviewOutcome.attemptedTargets[0].modelSlug, "claude-sonnet-5-5-high");
		assert.equal(reviewOutcome.selectedTarget.modelSlug, "gemini-4-argon-high");
		assert.equal(reviewOutcome.responseText, "Executed on gemini-4-argon-high");

		const docsReq = parseTaskRequest({
			prompt: "Update the documentation in docs/guide.md",
			explicitTaskKind: "docs",
			cwd: repoDir,
			allowFileEdits: true,
			allowedEditGlobs: ["docs/**/*.md"],
		});
		assert.equal(docsReq.kind, "ok");

		const docsOutcome = await executeRoutedTask({
			request: docsReq.value,
			env: envRes.value,
		});
		assert.equal(docsOutcome.status, "COMPLETED");
		assert.equal(docsOutcome.worktreeOutcome?.kind, "applied-to-host");
		assert.equal(
			fs.readFileSync(path.join(repoDir, "docs", "guide.md"), "utf8"),
			"# Updated by mock-agy\n"
		);

		const envFile = path.join(dataDir, "claude.env");
		const sessionStartOut = evaluateHookEvent({
			hookStdinJson: JSON.stringify({ hook_event_name: "SessionStart" }),
			env: {
				...process.env,
				CLAUDE_PLUGIN_DATA: dataDir,
				CLAUDE_PROJECT_DIR: repoDir,
				CLAUDE_ENV_FILE: envFile,
			},
		});
		assert.equal(sessionStartOut.hookSpecificOutput.hookEventName, "SessionStart");
		assert.ok(fs.readFileSync(envFile, "utf8").includes("CLAUDE_PLUGIN_DATA="));

		const promptHookOut = evaluateHookEvent({
			hookStdinJson: JSON.stringify({
				hook_event_name: "UserPromptSubmit",
				prompt: "Translate the release notes into Japanese",
			}),
			env: envRes.value,
		});
		assert.equal(promptHookOut.hookSpecificOutput.hookEventName, "UserPromptSubmit");
		assert.ok(promptHookOut.hookSpecificOutput.additionalContext.includes("TaskKind=translation"));

		assert.equal(MCP_TOOL_DEFINITIONS.length, 4);
		const mcpServerScript = path.resolve(
			path.dirname(new URL(import.meta.url).pathname),
			"../plugins/claugle/scripts/mcp-server.mjs"
		);

		const mcpChild = spawn(process.execPath, [mcpServerScript], {
			env: {
				...process.env,
				CLAUDE_PLUGIN_DATA: dataDir,
				CLAUDE_PROJECT_DIR: repoDir,
				CLAUGLE_AGY_BIN: mockAgyPath,
				CLAUGLE_GEMINI_BIN: mockGeminiPath,
			},
			stdio: ["pipe", "pipe", "pipe"],
		});

		const responses = [];
		await new Promise((resolve, reject) => {
			let buffer = "";
			mcpChild.stdout.on("data", (chunk) => {
				buffer += chunk.toString("utf8");
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.trim()) continue;
					responses.push(JSON.parse(line));
					if (responses.length === 3) {
						resolve();
					}
				}
			});
			mcpChild.on("error", reject);

			mcpChild.stdin.write(
				`${JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: { protocolVersion: "2024-11-05" },
				})}\n`
			);
			mcpChild.stdin.write(
				`${JSON.stringify({
					jsonrpc: "2.0",
					id: 2,
					method: "tools/list",
				})}\n`
			);
			mcpChild.stdin.write(
				`${JSON.stringify({
					jsonrpc: "2.0",
					id: 3,
					method: "tools/call",
					params: {
						name: "claugle_write",
						arguments: {
							prompt: "Write a short release summary",
							cwd: repoDir,
						},
					},
				})}\n`
			);
		});

		mcpChild.kill("SIGTERM");

		assert.equal(responses[0].id, 1);
		assert.equal(responses[0].result.serverInfo.name, "claugle");
		assert.equal(responses[1].id, 2);
		assert.equal(responses[1].result.tools.length, 4);
		assert.equal(responses[2].id, 3);
		assert.equal(responses[2].result.isError, false);
		const callPayload = JSON.parse(responses[2].result.content[0].text);
		assert.equal(callPayload.status, "COMPLETED");
		assert.equal(callPayload.responseText, "Executed on gemini-4-argon-high");

		const quotaCheck = resolveRoutePlan({
			request: docsReq.value,
			quotaState: "NORMAL",
			metrics: makeMetricsWithRatios({ "agy-gemini-pool": 1.0 }),
			health: {
				"claude-native": { kind: "healthy", binaryPath: "/usr/bin/claude" },
				agy: { kind: "healthy", binaryPath: mockAgyPath },
				"gemini-cli": { kind: "healthy", binaryPath: mockGeminiPath },
			},
		});
		assert.ok(quotaCheck.skippedCandidates.some((s) => s.skipReason === "POOL_EXHAUSTED"));
		assert.ok(quotaCheck.skippedCandidates.some((s) => s.skipReason === "WRITE_UNSUPPORTED"));

		fs.rmSync(repoDir, { recursive: true, force: true });
		fs.rmSync(dataDir, { recursive: true, force: true });
		fs.rmSync(binDir, { recursive: true, force: true });
	});
});

function auditMarkdownDocument({ filePath, content, checkLinksOnDisk = true }) {
	const issues = [];
	const relName = path.basename(filePath);
	const isEnglishDoc =
		relName === "README.en.md" ||
		filePath.includes("/agents/") ||
		filePath.includes("/commands/") ||
		filePath.includes("/skills/");

	if (
		filePath.includes("/agents/") ||
		filePath.includes("/commands/") ||
		filePath.includes("/skills/")
	) {
		const fmMatch = /^---\n([\s\S]*?)\n---\n/.exec(content);
		if (!fmMatch) {
			issues.push(`missing YAML frontmatter in ${relName}`);
		} else {
			const fm = fmMatch[1];
			if (!/^description:\s*\S+/m.test(fm)) {
				issues.push(`missing description in frontmatter of ${relName}`);
			}
			if (
				(filePath.includes("/agents/") || filePath.includes("/skills/")) &&
				!/^name:\s*\S+/m.test(fm)
			) {
				issues.push(`missing name in frontmatter of ${relName}`);
			}
		}
	}

	const linkRegex = /\[[^\]]+\]\(([^)#]+)\)/g;
	for (const match of content.matchAll(linkRegex)) {
		const target = match[1].trim();
		if (/^[a-z]+:\/\//i.test(target)) continue;
		if (checkLinksOnDisk) {
			const resolved = path.resolve(path.dirname(filePath), target);
			if (!fs.existsSync(resolved)) {
				issues.push(`broken relative link ${target} in ${relName}`);
			}
		}
	}

	if (isEnglishDoc) {
		const slopRe =
			/\b(?:delve|tapestry|testament|pivotal|vibrant|fostering|garner|interplay|intricate|utilize|leverage)\b/i;
		const hit = slopRe.exec(content);
		if (hit) {
			issues.push(`english slop token '${hit[0]}' in ${relName}`);
		}
		if (content.includes("—")) {
			issues.push(`em-dash found in ${relName}`);
		}
	}

	const koreanInterferenceRe =
		/(?:되어지|보여지|쓰여지|잊혀지|에서의|으로의|에로의|로부터의|가지고 있|갖고 있|결론적으로|요약하자면|에 의해)/;
	const koHit = koreanInterferenceRe.exec(content);
	if (koHit) {
		issues.push(`korean interference token '${koHit[0]}' in ${relName}`);
	}

	return issues;
}

describe("Markdown Documentation and Prompt Contracts", () => {
	it("verifies all 13 repository markdown files and catches seeded negative controls", () => {
		const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
		const expectedMarkdownFiles = [
			"README.md",
			"README.en.md",
			"docs/architecture.md",
			"plugins/claugle/README.md",
			"plugins/claugle/agents/agy-coder.md",
			"plugins/claugle/agents/agy-reviewer.md",
			"plugins/claugle/agents/gemini-writer.md",
			"plugins/claugle/commands/explain.md",
			"plugins/claugle/commands/model.md",
			"plugins/claugle/commands/quota.md",
			"plugins/claugle/commands/review.md",
			"plugins/claugle/commands/task.md",
			"plugins/claugle/commands/write.md",
			"plugins/claugle/skills/claugle-routing/SKILL.md",
		];

		for (const relPath of expectedMarkdownFiles) {
			const fullPath = path.join(repoRoot, relPath);
			assert.equal(fs.existsSync(fullPath), true, `expected ${relPath} to exist`);
			const content = fs.readFileSync(fullPath, "utf8");
			const issues = auditMarkdownDocument({ filePath: fullPath, content });
			assert.deepEqual(issues, [], `unexpected markdown issues in ${relPath}`);
		}

		const seededBrokenLink = auditMarkdownDocument({
			filePath: path.join(repoRoot, "README.en.md"),
			content: "# Title\n\nSee [missing](docs/does-not-exist.md).\n",
		});
		assert.deepEqual(seededBrokenLink, ["broken relative link docs/does-not-exist.md in README.en.md"]);

		const seededEnglishSlop = auditMarkdownDocument({
			filePath: path.join(repoRoot, "README.en.md"),
			content: "# Title\n\nWe utilize a vibrant — architecture.\n",
			checkLinksOnDisk: false,
		});
		assert.deepEqual(seededEnglishSlop, [
			"english slop token 'utilize' in README.en.md",
			"em-dash found in README.en.md",
		]);

		const seededKoreanSlop = auditMarkdownDocument({
			filePath: path.join(repoRoot, "README.md"),
			content: "# 제목\n\n결론적으로 시스템에 의해 처리되어진다.\n",
			checkLinksOnDisk: false,
		});
		assert.deepEqual(seededKoreanSlop, ["korean interference token '결론적으로' in README.md"]);

		const seededMissingFrontmatter = auditMarkdownDocument({
			filePath: path.join(repoRoot, "plugins/claugle/skills/claugle-routing/SKILL.md"),
			content: "---\ndescription: Missing name field\n---\n\nBody.\n",
			checkLinksOnDisk: false,
		});
		assert.deepEqual(seededMissingFrontmatter, ["missing name in frontmatter of SKILL.md"]);
	});
});

describe("Anthropic Messages API Gateway and Model Alias Resolution", () => {
	it("resolves argon/flash aliases, strips agy warning prefixes, and serves /v1/messages SSE, tool_use, and slash-command fast-paths", async () => {
		assert.equal(resolveModelAlias("argon"), "gemini-4-argon-high");
		assert.equal(resolveModelAlias("argon-medium"), "gemini-4-argon-medium");
		assert.equal(resolveModelAlias("gemini-4-argon-high[1m]"), "gemini-4-argon-high");
		assert.equal(resolveModelAlias("flash"), "gemini-3.8-flash-high");
		assert.equal(resolveModelAlias("agy-opus"), "claude-opus-5-5-high");
		assert.equal(resolveModelAlias("agy-sonnet"), "claude-sonnet-5-5-high");
		assert.equal(resolveModelAlias("unknown-slug"), null);

		assert.equal(MODEL_FAMILY_CATALOG.length, 8);
		const argonLow = resolveModelAndEffort("gemini-4-argon", "low");
		assert.equal(argonLow.modelSlug, "gemini-4-argon-low");
		assert.equal(argonLow.effort, "low");
		assert.equal(argonLow.familyId, "gemini-4-argon");

		const flashMed = resolveModelAndEffort("flash", "medium");
		assert.equal(flashMed.modelSlug, "gemini-3.8-flash-medium");
		assert.equal(flashMed.effort, "medium");

		const opusLow = resolveModelAndEffort("agy-opus-5-5", "low");
		assert.equal(opusLow.modelSlug, "claude-opus-5-5-low");
		assert.equal(opusLow.effort, "low");

		const autoMode = resolveModelAndEffort("claugle-auto", "medium");
		assert.equal(autoMode.mode, "auto");
		assert.equal(autoMode.modelSlug, null);

		const pickerCfg = buildClaudeModelPickerConfig();
		assert.equal(pickerCfg.modelPicker.replaceBuiltInOptions, true);
		assert.ok(pickerCfg.modelPicker.options.length >= 20);
		assert.equal(pickerCfg.modelSettings["gemini-4-argon"].effortLevel, "high");
		assert.equal(pickerCfg.modelSettings["gpt-oss-120b"].maxEffortLevel, "medium");

		const tmpSettingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "claugle-settings-"));
		const tmpSettingsPath = path.join(tmpSettingsDir, "settings.json");
		const syncedSettings = syncClaudeModelPickerSettings({
			settingsPath: tmpSettingsPath,
			selectedModel: "argon",
			selectedEffort: "low",
		});
		assert.equal(syncedSettings.kind, "ok");
		assert.equal(syncedSettings.activeModel, "gemini-4-argon");
		assert.equal(syncedSettings.activeEffort, "low");
		assert.equal(syncedSettings.resolvedModelSlug, "gemini-4-argon-low");
		const savedJson = JSON.parse(fs.readFileSync(tmpSettingsPath, "utf8"));
		assert.equal(savedJson.model, "gemini-4-argon");
		assert.equal(savedJson.modelSettings["gemini-4-argon"].effortLevel, "low");
		assert.equal(savedJson.modelPicker.replaceBuiltInOptions, true);
		fs.rmSync(tmpSettingsDir, { recursive: true, force: true });

		const reqWithAlias = parseTaskRequest({
			prompt: "Draft release notes",
			preferredModel: "argon",
			preferredEffort: "low",
		});
		assert.equal(reqWithAlias.kind, "ok");
		assert.equal(reqWithAlias.value.preferredModel, "gemini-4-argon-low");
		assert.equal(reqWithAlias.value.preferredEffort, "low");

		const prefixedAgy = parseAgyOutputJson(
			'warning: --mode plan has no effect while slash command expansion is disabled.\n{"conversation_id":"c1","status":"SUCCESS","response":"ok","usage":{"total_tokens":50}}'
		);
		assert.equal(prefixedAgy.kind, "ok");
		assert.equal(prefixedAgy.value.response, "ok");

		const errAgy = parseAgyOutputJson(
			'{"conversation_id":"","status":"ERROR","response":"","error":"--model gemini-4-argon-high conflicts with --effort=medium"}'
		);
		assert.equal(errAgy.kind, "error");
		assert.match(errAgy.message, /conflicts with --effort=medium/);

		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "claugle-gw-data-"));
		const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "claugle-gw-bin-"));
		const mockAgyPath = path.join(binDir, "mock-agy");
		fs.writeFileSync(mockAgyPath, "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o755 });

		const gw = await startAnthropicGatewayServer({
			port: 0,
			host: "127.0.0.1",
			env: {
				CLAUDE_PLUGIN_DATA: dataDir,
				CLAUDE_PROJECT_DIR: process.cwd(),
				CLAUGLE_AGY_BIN: mockAgyPath,
			},
			providerRunner: async (params) => {
				return {
					kind: "success",
					durationMs: 12,
					payload: {
						conversationId: "conv-gw-1",
						status: "SUCCESS",
						response: JSON.stringify({
							text: `응답 모델: ${params.modelSlug}`,
							tool_calls: [],
						}),
						structuredOutput: {
							text: `응답 모델: ${params.modelSlug}`,
							tool_calls: [],
						},
						usage: {
							inputTokens: 100,
							outputTokens: 25,
							thinkingTokens: 10,
							cacheReadTokens: 0,
							totalTokens: 135,
						},
					},
				};
			},
		});

		try {
			const helloRes = await fetch(`${gw.url}/api/hello`, { method: "HEAD" });
			assert.equal(helloRes.status, 200);

			const countRes = await fetch(`${gw.url}/v1/messages/count_tokens?beta=true`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "argon", messages: [{ role: "user", content: "안녕" }] }),
			});
			const countJson = await countRes.json();
			assert.ok(countJson.input_tokens > 0);

			const msgRes = await fetch(`${gw.url}/v1/messages?beta=true`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "argon",
					stream: false,
					tools: [{ name: "Bash", description: "Run shell", input_schema: { type: "object" } }],
					messages: [{ role: "user", content: "안녕하세요" }],
				}),
			});
			const msgJson = await msgRes.json();
			assert.equal(msgJson.model, "gemini-4-argon-high");
			assert.equal(msgJson.stop_reason, "end_turn");
			assert.equal(msgJson.content[0].text, "응답 모델: gemini-4-argon-high");

			const effortRes = await fetch(`${gw.url}/v1/messages?beta=true`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gemini-4-argon",
					output_config: { effort: "low" },
					stream: false,
					messages: [{ role: "user", content: "저강도 테스트" }],
				}),
			});
			const effortJson = await effortRes.json();
			assert.equal(effortJson.model, "gemini-4-argon-low");
			assert.equal(effortJson.content[0].text, "응답 모델: gemini-4-argon-low");

			const modelsRes = await fetch(`${gw.url}/v1/models`, { method: "GET" });
			const modelsJson = await modelsRes.json();
			assert.equal(modelsJson.data.length, 8);

			const sseRes = await fetch(`${gw.url}/v1/messages?beta=true`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "argon",
					stream: true,
					messages: [{ role: "user", content: "스트리밍 테스트" }],
				}),
			});
			const sseText = await sseRes.text();
			assert.match(sseText, /event: message_start/);
			assert.match(sseText, /응답 모델: gemini-4-argon-high/);
			assert.match(sseText, /event: message_stop/);

			const slashTurn1 = await fetch(`${gw.url}/v1/messages?beta=true`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "argon",
					stream: false,
					tools: [{ name: "Bash", description: "Run shell", input_schema: { type: "object" } }],
					messages: [
						{
							role: "user",
							content: 'Run claugle.mjs:\n```bash\nnode "${CLAUDE_PLUGIN_ROOT}/scripts/claugle.mjs" quota\n```',
						},
					],
				}),
			});
			const slashTurn1Json = await slashTurn1.json();
			assert.equal(slashTurn1Json.stop_reason, "tool_use");
			assert.equal(slashTurn1Json.content[0].type, "tool_use");
			assert.equal(slashTurn1Json.content[0].name, "Bash");
			assert.match(slashTurn1Json.content[0].input.command, /scripts\/claugle\.mjs" quota/);

			const slashTurn2 = await fetch(`${gw.url}/v1/messages?beta=true`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "argon",
					stream: false,
					tools: [{ name: "Bash", description: "Run shell", input_schema: { type: "object" } }],
					messages: [
						{
							role: "user",
							content: 'Run claugle.mjs:\n```bash\nnode "${CLAUDE_PLUGIN_ROOT}/scripts/claugle.mjs" quota\n```',
						},
						{
							role: "assistant",
							content: slashTurn1Json.content,
						},
						{
							role: "user",
							content: [
								{
									type: "tool_result",
									tool_use_id: slashTurn1Json.content[0].id,
									content: '{"quotaState":"OVERFLOW_TO_AGY"}',
								},
							],
						},
					],
				}),
			});
			const slashTurn2Json = await slashTurn2.json();
			assert.equal(slashTurn2Json.stop_reason, "end_turn");
			assert.match(slashTurn2Json.content[0].text, /"quotaState":"OVERFLOW_TO_AGY"/);
		} finally {
			gw.server.close();
			fs.rmSync(dataDir, { recursive: true, force: true });
			fs.rmSync(binDir, { recursive: true, force: true });
		}
	});
});
