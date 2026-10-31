import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PLUGIN_ROOT = path.resolve(SCRIPT_DIR, "..");

export const ALL_QUOTA_STATES = Object.freeze([
	"NORMAL",
	"CONSERVE_CLAUDE",
	"OVERFLOW_TO_AGY",
	"FALLBACK_GEMINI_CLI",
]);

export const ALL_TASK_KINDS = Object.freeze([
	"writing",
	"docs",
	"translation",
	"research",
	"review",
	"coding-trivial",
	"coding-complex",
	"architecture",
]);

export const ALL_QUOTA_POOLS = Object.freeze([
	"claude-code-native",
	"agy-claude-pool",
	"agy-gemini-pool",
	"gemini-cli-pool",
]);

export const EFFORT_LEVELS = Object.freeze([
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

export const AGY_EXECUTION_MODES = Object.freeze([
	"plan",
	"accept-edits",
	"auto",
]);

export const MODEL_CAPABILITIES = Object.freeze({
	"gemini-4-argon-high": Object.freeze({
		slug: "gemini-4-argon-high",
		provider: "agy",
		quotaPool: "agy-gemini-pool",
		family: "gemini",
		defaultEffort: "high",
		recommendedTasks: Object.freeze(["writing", "docs", "translation", "research", "review", "architecture"]),
	}),
	"gemini-4-argon-medium": Object.freeze({
		slug: "gemini-4-argon-medium",
		provider: "agy",
		quotaPool: "agy-gemini-pool",
		family: "gemini",
		defaultEffort: "medium",
		recommendedTasks: Object.freeze(["writing", "docs", "translation", "research"]),
	}),
	"gemini-4-argon-low": Object.freeze({
		slug: "gemini-4-argon-low",
		provider: "agy",
		quotaPool: "agy-gemini-pool",
		family: "gemini",
		defaultEffort: "low",
		recommendedTasks: Object.freeze(["writing", "translation", "coding-trivial"]),
	}),
	"gemini-3.8-flash-high": Object.freeze({
		slug: "gemini-3.8-flash-high",
		provider: "agy",
		quotaPool: "agy-gemini-pool",
		family: "gemini",
		defaultEffort: "high",
		recommendedTasks: Object.freeze(["writing", "docs", "translation", "coding-trivial"]),
	}),
	"gemini-3.8-flash-medium": Object.freeze({
		slug: "gemini-3.8-flash-medium",
		provider: "agy",
		quotaPool: "agy-gemini-pool",
		family: "gemini",
		defaultEffort: "medium",
		recommendedTasks: Object.freeze(["writing", "docs", "translation", "coding-trivial"]),
	}),
	"gemini-3.8-flash-low": Object.freeze({
		slug: "gemini-3.8-flash-low",
		provider: "agy",
		quotaPool: "agy-gemini-pool",
		family: "gemini",
		defaultEffort: "low",
		recommendedTasks: Object.freeze(["translation", "coding-trivial"]),
	}),
	"claude-opus-5-5-high": Object.freeze({
		slug: "claude-opus-5-5-high",
		provider: "agy",
		quotaPool: "agy-claude-pool",
		family: "claude",
		defaultEffort: "high",
		recommendedTasks: Object.freeze(["coding-complex", "architecture", "review"]),
	}),
	"claude-opus-5-5-medium": Object.freeze({
		slug: "claude-opus-5-5-medium",
		provider: "agy",
		quotaPool: "agy-claude-pool",
		family: "claude",
		defaultEffort: "medium",
		recommendedTasks: Object.freeze(["coding-complex", "architecture", "review"]),
	}),
	"claude-opus-5-5-low": Object.freeze({
		slug: "claude-opus-5-5-low",
		provider: "agy",
		quotaPool: "agy-claude-pool",
		family: "claude",
		defaultEffort: "low",
		recommendedTasks: Object.freeze(["review", "coding-trivial"]),
	}),
	"claude-sonnet-5-5-high": Object.freeze({
		slug: "claude-sonnet-5-5-high",
		provider: "agy",
		quotaPool: "agy-claude-pool",
		family: "claude",
		defaultEffort: "high",
		recommendedTasks: Object.freeze(["review", "coding-complex", "coding-trivial", "research"]),
	}),
	"claude-sonnet-5-5-medium": Object.freeze({
		slug: "claude-sonnet-5-5-medium",
		provider: "agy",
		quotaPool: "agy-claude-pool",
		family: "claude",
		defaultEffort: "medium",
		recommendedTasks: Object.freeze(["review", "coding-trivial", "docs"]),
	}),
	"claude-sonnet-5-5-low": Object.freeze({
		slug: "claude-sonnet-5-5-low",
		provider: "agy",
		quotaPool: "agy-claude-pool",
		family: "claude",
		defaultEffort: "low",
		recommendedTasks: Object.freeze(["coding-trivial", "docs"]),
	}),
	"gpt-oss-120b-medium": Object.freeze({
		slug: "gpt-oss-120b-medium",
		provider: "agy",
		quotaPool: "agy-gemini-pool",
		family: "open-weights",
		defaultEffort: "medium",
		recommendedTasks: Object.freeze(["coding-trivial", "research", "writing"]),
	}),
	"gemini-2.5-pro": Object.freeze({
		slug: "gemini-2.5-pro",
		provider: "gemini-cli",
		quotaPool: "gemini-cli-pool",
		family: "gemini",
		defaultEffort: "high",
		recommendedTasks: Object.freeze(["writing", "docs", "translation", "research", "review"]),
	}),
	"gemini-2.5-flash": Object.freeze({
		slug: "gemini-2.5-flash",
		provider: "gemini-cli",
		quotaPool: "gemini-cli-pool",
		family: "gemini",
		defaultEffort: "medium",
		recommendedTasks: Object.freeze(["writing", "docs", "translation"]),
	}),
});

const AGY_MODEL_SET = new Set(
	Object.values(MODEL_CAPABILITIES)
		.filter((cap) => cap.provider === "agy")
		.map((cap) => cap.slug)
);

const GEMINI_CLI_MODEL_SET = new Set(
	Object.values(MODEL_CAPABILITIES)
		.filter((cap) => cap.provider === "gemini-cli")
		.map((cap) => cap.slug)
);

export const DEFAULT_GOVERNOR_THRESHOLDS = Object.freeze({
	windowDurationMs: 7 * 24 * 60 * 60 * 1000,
	conserveClaudeBand: Object.freeze({ enterAt: 0.70, exitBelow: 0.65 }),
	overflowToAgyBand: Object.freeze({ enterAt: 0.90, exitBelow: 0.82 }),
	agyExhaustedBand: Object.freeze({ enterAt: 0.95, exitBelow: 0.88 }),
	circuitBreakerCooldownMs: 5 * 60 * 1000,
});

const READ_ONLY_ISOLATION = Object.freeze({ kind: "read-only" });
const WORKTREE_ISOLATION = Object.freeze({
	kind: "git-worktree",
	applyStrategy: "patch-if-clean",
	defaultAllowedGlobs: Object.freeze(["**/*"]),
});

function makeClaudeNativeTarget(effort = "high") {
	return Object.freeze({
		provider: "claude-native",
		quotaPool: "claude-code-native",
		effort,
		executionMode: "host-inline",
	});
}

function makeAgyTarget(modelSlug, effort, agyMode = "plan", isolation = READ_ONLY_ISOLATION, timeoutMs = 180_000) {
	const cap = MODEL_CAPABILITIES[modelSlug];
	return Object.freeze({
		provider: "agy",
		quotaPool: cap.quotaPool,
		modelSlug,
		family: cap.family,
		effort: effort ?? cap.defaultEffort,
		agyMode,
		isolation,
		timeoutMs,
	});
}

function makeGeminiCliTarget(modelSlug = "gemini-2.5-pro", effort = "high", timeoutMs = 120_000) {
	return Object.freeze({
		provider: "gemini-cli",
		quotaPool: "gemini-cli-pool",
		modelSlug,
		effort,
		agyMode: "plan",
		isolation: READ_ONLY_ISOLATION,
		timeoutMs,
	});
}

export const DEFAULT_POLICY_MATRIX = Object.freeze({
	NORMAL: Object.freeze({
		writing: Object.freeze([
			makeAgyTarget("gemini-4-argon-high", "high", "plan", READ_ONLY_ISOLATION),
			makeGeminiCliTarget("gemini-2.5-pro", "high"),
			makeClaudeNativeTarget("medium"),
		]),
		docs: Object.freeze([
			makeAgyTarget("gemini-4-argon-high", "high", "accept-edits", WORKTREE_ISOLATION),
			makeGeminiCliTarget("gemini-2.5-pro", "high"),
			makeClaudeNativeTarget("medium"),
		]),
		translation: Object.freeze([
			makeAgyTarget("gemini-3.8-flash-high", "high", "plan", READ_ONLY_ISOLATION),
			makeGeminiCliTarget("gemini-2.5-flash", "medium"),
			makeClaudeNativeTarget("low"),
		]),
		research: Object.freeze([
			makeAgyTarget("gemini-4-argon-high", "high", "plan", READ_ONLY_ISOLATION),
			makeGeminiCliTarget("gemini-2.5-pro", "high"),
			makeClaudeNativeTarget("medium"),
		]),
		review: Object.freeze([
			makeAgyTarget("claude-sonnet-5-5-high", "high", "plan", READ_ONLY_ISOLATION),
			makeAgyTarget("gemini-4-argon-high", "high", "plan", READ_ONLY_ISOLATION),
			makeClaudeNativeTarget("high"),
		]),
		"coding-trivial": Object.freeze([
			makeAgyTarget("gemini-3.8-flash-high", "high", "accept-edits", WORKTREE_ISOLATION),
			makeAgyTarget("claude-sonnet-5-5-medium", "medium", "accept-edits", WORKTREE_ISOLATION),
			makeClaudeNativeTarget("medium"),
		]),
		"coding-complex": Object.freeze([
			makeClaudeNativeTarget("high"),
			makeAgyTarget("claude-opus-5-5-high", "high", "accept-edits", WORKTREE_ISOLATION),
			makeAgyTarget("gemini-4-argon-high", "high", "accept-edits", WORKTREE_ISOLATION),
		]),
		architecture: Object.freeze([
			makeClaudeNativeTarget("high"),
			makeAgyTarget("claude-opus-5-5-high", "high", "plan", READ_ONLY_ISOLATION),
			makeAgyTarget("gemini-4-argon-high", "high", "plan", READ_ONLY_ISOLATION),
		]),
	}),
	CONSERVE_CLAUDE: Object.freeze({
		writing: Object.freeze([
			makeAgyTarget("gemini-4-argon-high", "high", "plan", READ_ONLY_ISOLATION),
			makeGeminiCliTarget("gemini-2.5-pro", "high"),
			makeClaudeNativeTarget("low"),
		]),
		docs: Object.freeze([
			makeAgyTarget("gemini-4-argon-high", "high", "accept-edits", WORKTREE_ISOLATION),
			makeGeminiCliTarget("gemini-2.5-pro", "high"),
			makeClaudeNativeTarget("low"),
		]),
		translation: Object.freeze([
			makeAgyTarget("gemini-3.8-flash-high", "high", "plan", READ_ONLY_ISOLATION),
			makeGeminiCliTarget("gemini-2.5-flash", "medium"),
			makeClaudeNativeTarget("low"),
		]),
		research: Object.freeze([
			makeAgyTarget("gemini-4-argon-high", "high", "plan", READ_ONLY_ISOLATION),
			makeGeminiCliTarget("gemini-2.5-pro", "high"),
			makeClaudeNativeTarget("low"),
		]),
		review: Object.freeze([
			makeAgyTarget("claude-sonnet-5-5-high", "high", "plan", READ_ONLY_ISOLATION),
			makeAgyTarget("gemini-4-argon-high", "high", "plan", READ_ONLY_ISOLATION),
			makeGeminiCliTarget("gemini-2.5-pro", "high"),
		]),
		"coding-trivial": Object.freeze([
			makeAgyTarget("gemini-3.8-flash-high", "high", "accept-edits", WORKTREE_ISOLATION),
			makeAgyTarget("claude-sonnet-5-5-medium", "medium", "accept-edits", WORKTREE_ISOLATION),
			makeClaudeNativeTarget("low"),
		]),
		"coding-complex": Object.freeze([
			makeAgyTarget("claude-sonnet-5-5-high", "high", "accept-edits", WORKTREE_ISOLATION),
			makeAgyTarget("claude-opus-5-5-high", "high", "accept-edits", WORKTREE_ISOLATION),
			makeClaudeNativeTarget("medium"),
		]),
		architecture: Object.freeze([
			makeAgyTarget("claude-opus-5-5-high", "high", "plan", READ_ONLY_ISOLATION),
			makeAgyTarget("gemini-4-argon-high", "high", "plan", READ_ONLY_ISOLATION),
			makeClaudeNativeTarget("medium"),
		]),
	}),
	OVERFLOW_TO_AGY: Object.freeze({
		writing: Object.freeze([
			makeAgyTarget("gemini-4-argon-high", "high", "plan", READ_ONLY_ISOLATION),
			makeAgyTarget("gemini-3.8-flash-high", "high", "plan", READ_ONLY_ISOLATION),
			makeGeminiCliTarget("gemini-2.5-pro", "high"),
		]),
		docs: Object.freeze([
			makeAgyTarget("gemini-4-argon-high", "high", "accept-edits", WORKTREE_ISOLATION),
			makeAgyTarget("gemini-3.8-flash-high", "high", "accept-edits", WORKTREE_ISOLATION),
			makeGeminiCliTarget("gemini-2.5-pro", "high"),
		]),
		translation: Object.freeze([
			makeAgyTarget("gemini-3.8-flash-high", "high", "plan", READ_ONLY_ISOLATION),
			makeAgyTarget("gemini-4-argon-medium", "medium", "plan", READ_ONLY_ISOLATION),
			makeGeminiCliTarget("gemini-2.5-flash", "medium"),
		]),
		research: Object.freeze([
			makeAgyTarget("gemini-4-argon-high", "high", "plan", READ_ONLY_ISOLATION),
			makeAgyTarget("claude-sonnet-5-5-high", "high", "plan", READ_ONLY_ISOLATION),
			makeGeminiCliTarget("gemini-2.5-pro", "high"),
		]),
		review: Object.freeze([
			makeAgyTarget("claude-opus-5-5-high", "high", "plan", READ_ONLY_ISOLATION),
			makeAgyTarget("claude-sonnet-5-5-high", "high", "plan", READ_ONLY_ISOLATION),
			makeAgyTarget("gemini-4-argon-high", "high", "plan", READ_ONLY_ISOLATION),
		]),
		"coding-trivial": Object.freeze([
			makeAgyTarget("gemini-3.8-flash-high", "high", "accept-edits", WORKTREE_ISOLATION),
			makeAgyTarget("claude-sonnet-5-5-medium", "medium", "accept-edits", WORKTREE_ISOLATION),
			makeAgyTarget("gpt-oss-120b-medium", "medium", "accept-edits", WORKTREE_ISOLATION),
		]),
		"coding-complex": Object.freeze([
			makeAgyTarget("claude-opus-5-5-high", "high", "accept-edits", WORKTREE_ISOLATION),
			makeAgyTarget("claude-sonnet-5-5-high", "high", "accept-edits", WORKTREE_ISOLATION),
			makeAgyTarget("gemini-4-argon-high", "high", "accept-edits", WORKTREE_ISOLATION),
		]),
		architecture: Object.freeze([
			makeAgyTarget("claude-opus-5-5-high", "high", "plan", READ_ONLY_ISOLATION),
			makeAgyTarget("gemini-4-argon-high", "high", "plan", READ_ONLY_ISOLATION),
			makeGeminiCliTarget("gemini-2.5-pro", "high"),
		]),
	}),
	FALLBACK_GEMINI_CLI: Object.freeze({
		writing: Object.freeze([
			makeGeminiCliTarget("gemini-2.5-pro", "high"),
			makeGeminiCliTarget("gemini-2.5-flash", "medium"),
			makeAgyTarget("gemini-3.8-flash-low", "low", "plan", READ_ONLY_ISOLATION),
		]),
		docs: Object.freeze([
			makeGeminiCliTarget("gemini-2.5-pro", "high"),
			makeAgyTarget("gemini-3.8-flash-medium", "medium", "accept-edits", WORKTREE_ISOLATION),
			makeClaudeNativeTarget("low"),
		]),
		translation: Object.freeze([
			makeGeminiCliTarget("gemini-2.5-flash", "medium"),
			makeGeminiCliTarget("gemini-2.5-pro", "high"),
			makeAgyTarget("gemini-3.8-flash-low", "low", "plan", READ_ONLY_ISOLATION),
		]),
		research: Object.freeze([
			makeGeminiCliTarget("gemini-2.5-pro", "high"),
			makeGeminiCliTarget("gemini-2.5-flash", "medium"),
			makeAgyTarget("gpt-oss-120b-medium", "medium", "plan", READ_ONLY_ISOLATION),
		]),
		review: Object.freeze([
			makeGeminiCliTarget("gemini-2.5-pro", "high"),
			makeAgyTarget("gemini-3.8-flash-high", "high", "plan", READ_ONLY_ISOLATION),
			makeClaudeNativeTarget("low"),
		]),
		"coding-trivial": Object.freeze([
			makeAgyTarget("gemini-3.8-flash-low", "low", "accept-edits", WORKTREE_ISOLATION),
			makeAgyTarget("gpt-oss-120b-medium", "medium", "accept-edits", WORKTREE_ISOLATION),
			makeClaudeNativeTarget("low"),
		]),
		"coding-complex": Object.freeze([
			makeAgyTarget("gpt-oss-120b-medium", "medium", "accept-edits", WORKTREE_ISOLATION),
			makeAgyTarget("gemini-3.8-flash-high", "high", "accept-edits", WORKTREE_ISOLATION),
			makeClaudeNativeTarget("low"),
		]),
		architecture: Object.freeze([
			makeGeminiCliTarget("gemini-2.5-pro", "high"),
			makeAgyTarget("gpt-oss-120b-medium", "medium", "plan", READ_ONLY_ISOLATION),
			makeClaudeNativeTarget("low"),
		]),
	}),
});

export function isAgyModelSlug(value) {
	return typeof value === "string" && AGY_MODEL_SET.has(value);
}

export function isGeminiCliModelSlug(value) {
	return typeof value === "string" && GEMINI_CLI_MODEL_SET.has(value);
}

export function isUnitIntervalRatio(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function createTaskExecutionId(nowMs = Date.now(), randomHex) {
	const ts = Number.isFinite(nowMs) && nowMs >= 0 ? Math.floor(nowMs) : Date.now();
	const suffix =
		typeof randomHex === "string" && /^[0-9a-f]{6,32}$/i.test(randomHex)
			? randomHex.toLowerCase()
			: crypto.randomBytes(4).toString("hex");
	return `task-${ts}-${suffix}`;
}

export function parseAbsolutePath(raw) {
	if (typeof raw !== "string" || raw.trim().length === 0) {
		return { kind: "error", code: "INVALID_PATH", message: "Path must be a non-empty string." };
	}
	if (raw.includes("\0")) {
		return { kind: "error", code: "INVALID_PATH", message: "Path must not contain null bytes." };
	}
	if (!path.isAbsolute(raw)) {
		return { kind: "error", code: "INVALID_PATH", message: `Expected absolute path, got "${raw}".` };
	}
	return { kind: "ok", value: path.resolve(raw) };
}

export function parseRelativeGlob(raw) {
	if (typeof raw !== "string" || raw.trim().length === 0) {
		return { kind: "error", code: "INVALID_PATH", message: "Glob must be a non-empty string." };
	}
	if (raw.includes("\0")) {
		return { kind: "error", code: "INVALID_PATH", message: "Glob must not contain null bytes." };
	}
	const normalized = raw.replace(/\\/g, "/").trim();
	if (normalized.startsWith("/")) {
		return { kind: "error", code: "INVALID_PATH", message: `Expected relative glob, got "${raw}".` };
	}
	const segments = normalized.split("/");
	if (segments.includes("..")) {
		return {
			kind: "error",
			code: "INVALID_PATH",
			message: `Relative glob "${raw}" must not contain parent traversal segments ("..").`,
		};
	}
	return { kind: "ok", value: normalized };
}

function parsePositiveBudget(rawVal, fallback) {
	if (rawVal === undefined || rawVal === null || rawVal === "") {
		return { kind: "ok", value: fallback };
	}
	const parsed = Number(rawVal);
	if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
		return {
			kind: "error",
			code: "INVALID_ENV",
			message: `Expected positive integer weekly token budget, got "${rawVal}".`,
		};
	}
	return { kind: "ok", value: parsed };
}

export function parsePluginEnv(rawEnv = process.env) {
	if (!rawEnv || typeof rawEnv !== "object") {
		return { kind: "error", code: "INVALID_ENV", message: "Environment must be an object." };
	}

	const rawPluginRoot = rawEnv.CLAUDE_PLUGIN_ROOT || DEFAULT_PLUGIN_ROOT;
	const pluginRootRes = parseAbsolutePath(rawPluginRoot);
	if (pluginRootRes.kind === "error") {
		return { kind: "error", code: "INVALID_ENV", message: `CLAUDE_PLUGIN_ROOT: ${pluginRootRes.message}` };
	}

	const rawPluginData =
		rawEnv.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), ".claude", "plugins", "data", "claugle");
	const pluginDataRes = parseAbsolutePath(rawPluginData);
	if (pluginDataRes.kind === "error") {
		return { kind: "error", code: "INVALID_ENV", message: `CLAUDE_PLUGIN_DATA: ${pluginDataRes.message}` };
	}

	const rawProjectDir = rawEnv.CLAUDE_PROJECT_DIR || process.cwd();
	const projectDirRes = parseAbsolutePath(rawProjectDir);
	if (projectDirRes.kind === "error") {
		return { kind: "error", code: "INVALID_ENV", message: `CLAUDE_PROJECT_DIR: ${projectDirRes.message}` };
	}

	let envFile;
	if (rawEnv.CLAUDE_ENV_FILE) {
		const envFileRes = parseAbsolutePath(rawEnv.CLAUDE_ENV_FILE);
		if (envFileRes.kind === "error") {
			return { kind: "error", code: "INVALID_ENV", message: `CLAUDE_ENV_FILE: ${envFileRes.message}` };
		}
		envFile = envFileRes.value;
	}

	const claudeBudget = parsePositiveBudget(
		rawEnv.CLAUDE_PLUGIN_OPTION_CLAUDE_WEEKLY_TOKEN_BUDGET ?? rawEnv.CLAUGLE_CLAUDE_WEEKLY_TOKEN_BUDGET,
		5_000_000
	);
	if (claudeBudget.kind === "error") return claudeBudget;

	const agyClaudeBudget = parsePositiveBudget(
		rawEnv.CLAUDE_PLUGIN_OPTION_AGY_CLAUDE_WEEKLY_TOKEN_BUDGET ?? rawEnv.CLAUGLE_AGY_CLAUDE_WEEKLY_TOKEN_BUDGET,
		8_000_000
	);
	if (agyClaudeBudget.kind === "error") return agyClaudeBudget;

	const agyGeminiBudget = parsePositiveBudget(
		rawEnv.CLAUDE_PLUGIN_OPTION_AGY_GEMINI_WEEKLY_TOKEN_BUDGET ?? rawEnv.CLAUGLE_AGY_GEMINI_WEEKLY_TOKEN_BUDGET,
		15_000_000
	);
	if (agyGeminiBudget.kind === "error") return agyGeminiBudget;

	const geminiCliBudget = parsePositiveBudget(
		rawEnv.CLAUDE_PLUGIN_OPTION_GEMINI_CLI_WEEKLY_TOKEN_BUDGET ?? rawEnv.CLAUGLE_GEMINI_CLI_WEEKLY_TOKEN_BUDGET,
		10_000_000
	);
	if (geminiCliBudget.kind === "error") return geminiCliBudget;

	const rawDefaultMode =
		rawEnv.CLAUDE_PLUGIN_OPTION_DEFAULT_AGY_MODE ?? rawEnv.CLAUGLE_DEFAULT_AGY_MODE ?? "accept-edits";
	if (!AGY_EXECUTION_MODES.includes(rawDefaultMode)) {
		return {
			kind: "error",
			code: "INVALID_ENV",
			message: `Invalid default agy mode "${rawDefaultMode}". Expected one of: ${AGY_EXECUTION_MODES.join(", ")}.`,
		};
	}

	const rawSessionId = String(rawEnv.CLAUDE_SESSION_ID || "default-session").trim();
	const sanitizedSessionId = rawSessionId.replace(/[^a-zA-Z0-9._-]/g, "_") || "default-session";

	return {
		kind: "ok",
		value: Object.freeze({
			pluginRoot: pluginRootRes.value,
			pluginDataDir: pluginDataRes.value,
			projectDir: projectDirRes.value,
			sessionId: sanitizedSessionId,
			...(envFile ? { envFile } : {}),
			weeklyBudgets: Object.freeze({
				"claude-code-native": claudeBudget.value,
				"agy-claude-pool": agyClaudeBudget.value,
				"agy-gemini-pool": agyGeminiBudget.value,
				"gemini-cli-pool": geminiCliBudget.value,
			}),
			defaultAgyMode: rawDefaultMode,
			...(rawEnv.CLAUGLE_AGY_BIN ? { agyBinOverride: String(rawEnv.CLAUGLE_AGY_BIN) } : {}),
			...(rawEnv.CLAUGLE_GEMINI_BIN ? { geminiBinOverride: String(rawEnv.CLAUGLE_GEMINI_BIN) } : {}),
		}),
	};
}

export function parseTaskRequest(rawInput) {
	if (!rawInput || typeof rawInput !== "object") {
		return { kind: "error", code: "INVALID_REQUEST", message: "Task request must be an object." };
	}

	const prompt = typeof rawInput.prompt === "string" ? rawInput.prompt.trim() : "";
	if (prompt.length === 0) {
		return { kind: "error", code: "INVALID_REQUEST", message: "Task request prompt must be a non-empty string." };
	}

	let explicitTaskKind;
	if (rawInput.explicitTaskKind !== undefined && rawInput.explicitTaskKind !== null && rawInput.explicitTaskKind !== "") {
		if (!ALL_TASK_KINDS.includes(rawInput.explicitTaskKind)) {
			return {
				kind: "error",
				code: "INVALID_REQUEST",
				message: `Unknown task kind "${rawInput.explicitTaskKind}".`,
			};
		}
		explicitTaskKind = rawInput.explicitTaskKind;
	}

	let preferredModel;
	if (rawInput.preferredModel !== undefined && rawInput.preferredModel !== null && rawInput.preferredModel !== "") {
		if (!isAgyModelSlug(rawInput.preferredModel) && !isGeminiCliModelSlug(rawInput.preferredModel)) {
			return {
				kind: "error",
				code: "INVALID_REQUEST",
				message: `Unsupported preferred model "${rawInput.preferredModel}".`,
			};
		}
		preferredModel = rawInput.preferredModel;
	}

	let preferredEffort;
	if (rawInput.preferredEffort !== undefined && rawInput.preferredEffort !== null && rawInput.preferredEffort !== "") {
		if (!EFFORT_LEVELS.includes(rawInput.preferredEffort)) {
			return {
				kind: "error",
				code: "INVALID_REQUEST",
				message: `Unsupported effort level "${rawInput.preferredEffort}".`,
			};
		}
		preferredEffort = rawInput.preferredEffort;
	}

	const cwdRes = parseAbsolutePath(rawInput.cwd ?? process.cwd());
	if (cwdRes.kind === "error") {
		return { kind: "error", code: "INVALID_REQUEST", message: `Invalid cwd: ${cwdRes.message}` };
	}

	const contextFiles = [];
	if (rawInput.contextFiles !== undefined) {
		if (!Array.isArray(rawInput.contextFiles)) {
			return { kind: "error", code: "INVALID_REQUEST", message: "contextFiles must be an array of strings." };
		}
		for (const item of rawInput.contextFiles) {
			if (typeof item !== "string" || item.trim().length === 0 || item.includes("\0")) {
				return { kind: "error", code: "INVALID_REQUEST", message: "Each contextFile must be a valid path string." };
			}
			contextFiles.push(item.trim());
		}
	}

	const allowFileEdits = Boolean(rawInput.allowFileEdits);
	const rawGlobs =
		Array.isArray(rawInput.allowedEditGlobs) && rawInput.allowedEditGlobs.length > 0
			? rawInput.allowedEditGlobs
			: ["**/*"];

	const parsedGlobs = [];
	for (const g of rawGlobs) {
		const globRes = parseRelativeGlob(g);
		if (globRes.kind === "error") {
			return { kind: "error", code: "INVALID_REQUEST", message: globRes.message };
		}
		parsedGlobs.push(globRes.value);
	}

	const applyStrategy = rawInput.applyStrategy ?? "patch-if-clean";
	if (applyStrategy !== "patch-if-clean" && applyStrategy !== "branch-only") {
		return {
			kind: "error",
			code: "INVALID_REQUEST",
			message: `Invalid applyStrategy "${applyStrategy}".`,
		};
	}

	const taskId =
		typeof rawInput.taskId === "string" && rawInput.taskId.startsWith("task-")
			? rawInput.taskId
			: createTaskExecutionId();

	return {
		kind: "ok",
		value: Object.freeze({
			taskId,
			prompt,
			...(explicitTaskKind ? { explicitTaskKind } : {}),
			...(preferredModel ? { preferredModel } : {}),
			...(preferredEffort ? { preferredEffort } : {}),
			cwd: cwdRes.value,
			contextFiles: Object.freeze(contextFiles),
			allowFileEdits,
			allowedEditGlobs: Object.freeze(parsedGlobs),
			applyStrategy,
		}),
	};
}

function toNonNegativeInt(val, fallback = 0) {
	const num = Number(val);
	return Number.isFinite(num) && num >= 0 ? Math.floor(num) : fallback;
}

export function parseAgyOutputJson(rawStdout) {
	if (typeof rawStdout !== "string" || rawStdout.trim().length === 0) {
		return { kind: "error", code: "INVALID_PROVIDER_JSON", message: "Empty stdout from agy CLI." };
	}

	let parsed;
	try {
		parsed = JSON.parse(rawStdout.trim());
	} catch (err) {
		return {
			kind: "error",
			code: "INVALID_PROVIDER_JSON",
			message: `Failed to parse agy JSON output: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	if (!parsed || typeof parsed !== "object") {
		return { kind: "error", code: "INVALID_PROVIDER_JSON", message: "agy JSON output is not an object." };
	}

	const responseText =
		typeof parsed.response === "string"
			? parsed.response
			: typeof parsed.result === "string"
				? parsed.result
				: null;

	if (responseText === null) {
		return {
			kind: "error",
			code: "INVALID_PROVIDER_JSON",
			message: "agy JSON output is missing string field 'response'.",
		};
	}

	const rawUsage = parsed.usage && typeof parsed.usage === "object" ? parsed.usage : {};
	const inputTokens = toNonNegativeInt(rawUsage.input_tokens ?? rawUsage.inputTokens, 0);
	const outputTokens = toNonNegativeInt(rawUsage.output_tokens ?? rawUsage.outputTokens, 0);
	const thinkingTokens = toNonNegativeInt(rawUsage.thinking_tokens ?? rawUsage.thinkingTokens, 0);
	const cacheReadTokens = toNonNegativeInt(rawUsage.cache_read_tokens ?? rawUsage.cacheReadTokens, 0);
	const totalTokens = toNonNegativeInt(
		rawUsage.total_tokens ?? rawUsage.totalTokens,
		inputTokens + outputTokens + thinkingTokens
	);

	const conversationId = String(parsed.conversation_id ?? parsed.conversationId ?? "conv-agy-headless");
	const durationSeconds = Number.isFinite(Number(parsed.duration_seconds ?? parsed.durationSeconds))
		? Math.max(0, Number(parsed.duration_seconds ?? parsed.durationSeconds))
		: 0;
	const numTurns = toNonNegativeInt(parsed.num_turns ?? parsed.numTurns, 1);
	const structuredOutput =
		parsed.structured_output && typeof parsed.structured_output === "object"
			? parsed.structured_output
			: parsed.structuredOutput && typeof parsed.structuredOutput === "object"
				? parsed.structuredOutput
				: undefined;

	return {
		kind: "ok",
		value: Object.freeze({
			conversationId,
			status: "SUCCESS",
			response: responseText,
			durationSeconds,
			numTurns,
			...(structuredOutput ? { structuredOutput } : {}),
			usage: Object.freeze({
				inputTokens,
				outputTokens,
				thinkingTokens,
				cacheReadTokens,
				totalTokens,
			}),
		}),
	};
}

export function parseGeminiCliOutputJson(rawStdout) {
	if (typeof rawStdout !== "string" || rawStdout.trim().length === 0) {
		return { kind: "error", code: "INVALID_PROVIDER_JSON", message: "Empty stdout from gemini CLI." };
	}

	let parsed;
	try {
		parsed = JSON.parse(rawStdout.trim());
	} catch (err) {
		return {
			kind: "error",
			code: "INVALID_PROVIDER_JSON",
			message: `Failed to parse gemini JSON output: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	if (!parsed || typeof parsed !== "object") {
		return { kind: "error", code: "INVALID_PROVIDER_JSON", message: "gemini JSON output is not an object." };
	}

	const responseText =
		typeof parsed.response === "string"
			? parsed.response
			: typeof parsed.text === "string"
				? parsed.text
				: typeof parsed.result === "string"
					? parsed.result
					: null;

	if (responseText === null) {
		return {
			kind: "error",
			code: "INVALID_PROVIDER_JSON",
			message: "gemini JSON output is missing string field 'response' or 'text'.",
		};
	}

	const rawUsage =
		parsed.usage && typeof parsed.usage === "object"
			? parsed.usage
			: parsed.stats?.models && typeof parsed.stats.models === "object"
				? Object.values(parsed.stats.models)[0]?.tokens ?? {}
				: {};

	const inputTokens = toNonNegativeInt(rawUsage.input_tokens ?? rawUsage.inputTokens ?? rawUsage.prompt, 0);
	const outputTokens = toNonNegativeInt(rawUsage.output_tokens ?? rawUsage.outputTokens ?? rawUsage.candidates, 0);
	const thinkingTokens = toNonNegativeInt(rawUsage.thinking_tokens ?? rawUsage.thinkingTokens ?? rawUsage.thoughts, 0);
	const cacheReadTokens = toNonNegativeInt(rawUsage.cache_read_tokens ?? rawUsage.cacheReadTokens ?? rawUsage.cached, 0);
	const totalTokens = toNonNegativeInt(
		rawUsage.total_tokens ?? rawUsage.totalTokens ?? rawUsage.total,
		inputTokens + outputTokens + thinkingTokens
	);

	return {
		kind: "ok",
		value: Object.freeze({
			conversationId: String(parsed.conversation_id ?? parsed.session_id ?? "conv-gemini-cli"),
			status: "SUCCESS",
			response: responseText,
			durationSeconds: Number.isFinite(Number(parsed.duration_seconds)) ? Number(parsed.duration_seconds) : 0,
			numTurns: 1,
			usage: Object.freeze({
				inputTokens,
				outputTokens,
				thinkingTokens,
				cacheReadTokens,
				totalTokens,
			}),
		}),
	};
}

const TASK_CLASSIFICATION_RULES = Object.freeze([
	{
		taskKind: "translation",
		patterns: [
			/\btranslat(e|ion|ing)\b/i,
			/\blocaliz(e|ation)\b/i,
			/\b(i18n|l10n)\b/i,
			/\binto\s+(spanish|japanese|chinese|french|german|korean|portuguese|italian|english)\b/i,
		],
		defaultWrite: false,
	},
	{
		taskKind: "review",
		patterns: [
			/\bcode\s+review\b/i,
			/\breview\s+(this|the|my|a)?\s*(diff|pr|pull\s+request|branch|commit|change|patch|code|file|module)\b/i,
			/\bsecurity\s+(audit|review)\b/i,
			/\bfind\s+(bugs|vulnerabilities|regressions)\b/i,
			/\baudit\s+(the|this)\b/i,
		],
		defaultWrite: false,
	},
	{
		taskKind: "docs",
		patterns: [
			/\b(readme|changelog|jsdoc|tsdoc|docstring|markdown)\b/i,
			/\b(write|update|generate|edit|refresh)\s+(the\s+)?(docs|documentation|api\s+docs|guide|tutorial|readme)\b/i,
			/\bdocument\s+(the|this|how)\b/i,
			/\bdocs\/[a-z0-9_/-]+\.md\b/i,
		],
		defaultWrite: false,
	},
	{
		taskKind: "writing",
		patterns: [
			/\b(release\s+notes|blog\s+post|announcement|commit\s+message|pr\s+description|pull\s+request\s+description)\b/i,
			/\b(summarize|summary|tl;dr|rewrite\s+prose|copywriting|draft\s+an?\s+(email|post|message|note|summary))\b/i,
			/\bwrite\s+a\s+(summary|post|essay|letter|description|announcement)\b/i,
		],
		defaultWrite: false,
	},
	{
		taskKind: "architecture",
		patterns: [
			/\b(system\s+design|architecture|architectural|rfc|adr|design\s+doc)\b/i,
			/\b(design|sketch)\s+(the\s+)?(types|schema|state\s+machine|domain\s+model|module\s+boundaries|api\s+contract)\b/i,
			/\btrade-?offs?\s+between\b/i,
		],
		defaultWrite: false,
	},
	{
		taskKind: "research",
		patterns: [
			/\b(explain\s+how|how\s+does|why\s+does|investigate|research|survey|explore\s+how)\b/i,
			/\bwhat\s+causes\b/i,
			/\bwalk\s+me\s+through\b/i,
		],
		defaultWrite: false,
	},
	{
		taskKind: "coding-trivial",
		patterns: [
			/\b(rename|typo|format|prettier|eslint|lint\s+fix|bump\s+version|one-line|one\s+liner|simple\s+helper|update\s+constant)\b/i,
			/\badd\s+an?\s+export\b/i,
		],
		defaultWrite: true,
	},
	{
		taskKind: "coding-complex",
		patterns: [
			/\b(refactor|implement|migrate|concurrency|race\s+condition|deadlock|state\s+machine|parser|compiler|algorithm)\b/i,
			/\b(fix|debug)\s+(the\s+)?(bug|issue|error|crash|regression|test)\b/i,
			/\bmulti-?file\b/i,
		],
		defaultWrite: true,
	},
]);

const WRITE_INTENT_PATTERN =
	/\b(edit|modify|update|write\s+to|apply|refactor|implement|fix|rename|create\s+file|patch)\b/i;

export function classifyTask(prompt, explicitTaskKind, allowFileEdits = false) {
	const text = typeof prompt === "string" ? prompt.trim() : "";

	if (explicitTaskKind && ALL_TASK_KINDS.includes(explicitTaskKind)) {
		const isCoding = explicitTaskKind === "coding-trivial" || explicitTaskKind === "coding-complex";
		return Object.freeze({
			taskKind: explicitTaskKind,
			confidence: 1.0,
			matchedSignals: Object.freeze(["explicit-task-kind"]),
			requiresWorkspaceWrite: Boolean(allowFileEdits || isCoding),
		});
	}

	let bestKind = "coding-complex";
	let bestMatches = [];
	let defaultWrite = true;

	for (const rule of TASK_CLASSIFICATION_RULES) {
		const matches = [];
		for (const pattern of rule.patterns) {
			const match = text.match(pattern);
			if (match) {
				matches.push(match[0].toLowerCase());
			}
		}
		if (matches.length > bestMatches.length) {
			bestKind = rule.taskKind;
			bestMatches = matches;
			defaultWrite = rule.defaultWrite;
		}
	}

	const confidence =
		bestMatches.length === 0
			? 0.55
			: Math.min(0.98, Number((0.72 + (bestMatches.length - 1) * 0.1).toFixed(2)));

	const isReadOnlyKind =
		bestKind === "review" ||
		bestKind === "research" ||
		bestKind === "translation" ||
		bestKind === "architecture";

	const requiresWorkspaceWrite = Boolean(
		allowFileEdits || (!isReadOnlyKind && (defaultWrite || WRITE_INTENT_PATTERN.test(text)))
	);

	return Object.freeze({
		taskKind: bestKind,
		confidence,
		matchedSignals: Object.freeze(bestMatches.length > 0 ? bestMatches : ["default-coding-fallback"]),
		requiresWorkspaceWrite,
	});
}

export function transitionQuotaState(
	previousState,
	metrics,
	thresholds = DEFAULT_GOVERNOR_THRESHOLDS
) {
	const prev = ALL_QUOTA_STATES.includes(previousState) ? previousState : "NORMAL";
	const pools = metrics?.pools ?? {};

	const claudeRatio = Number(pools["claude-code-native"]?.consumedRatio ?? 0);
	const agyClaudeRatio = Number(pools["agy-claude-pool"]?.consumedRatio ?? 0);
	const agyGeminiRatio = Number(pools["agy-gemini-pool"]?.consumedRatio ?? 0);
	const agyMaxRatio = Math.max(agyClaudeRatio, agyGeminiRatio);

	const agyExhausted =
		prev === "FALLBACK_GEMINI_CLI"
			? agyMaxRatio >= thresholds.agyExhaustedBand.exitBelow
			: agyMaxRatio >= thresholds.agyExhaustedBand.enterAt;

	if (agyExhausted) {
		return "FALLBACK_GEMINI_CLI";
	}

	const wasOverflowOrHigher = prev === "OVERFLOW_TO_AGY" || prev === "FALLBACK_GEMINI_CLI";
	const inOverflow = wasOverflowOrHigher
		? claudeRatio >= thresholds.overflowToAgyBand.exitBelow
		: claudeRatio >= thresholds.overflowToAgyBand.enterAt;

	if (inOverflow) {
		return "OVERFLOW_TO_AGY";
	}

	const wasConserveOrHigher =
		prev === "CONSERVE_CLAUDE" || prev === "OVERFLOW_TO_AGY" || prev === "FALLBACK_GEMINI_CLI";
	const inConserve = wasConserveOrHigher
		? claudeRatio >= thresholds.conserveClaudeBand.exitBelow
		: claudeRatio >= thresholds.conserveClaudeBand.enterAt;

	if (inConserve) {
		return "CONSERVE_CLAUDE";
	}

	return "NORMAL";
}

function buildPreferredTarget(preferredModel, preferredEffort, allowFileEdits, allowedEditGlobs, applyStrategy) {
	if (isAgyModelSlug(preferredModel)) {
		const cap = MODEL_CAPABILITIES[preferredModel];
		const isolation = allowFileEdits
			? Object.freeze({
					kind: "git-worktree",
					applyStrategy,
					defaultAllowedGlobs: allowedEditGlobs,
				})
			: READ_ONLY_ISOLATION;
		return makeAgyTarget(
			preferredModel,
			preferredEffort ?? cap.defaultEffort,
			allowFileEdits ? "accept-edits" : "plan",
			isolation
		);
	}
	if (isGeminiCliModelSlug(preferredModel)) {
		const cap = MODEL_CAPABILITIES[preferredModel];
		return makeGeminiCliTarget(preferredModel, preferredEffort ?? cap.defaultEffort);
	}
	return null;
}

function adaptTargetForRequest(target, request, requiresWrite) {
	const effort = request.preferredEffort ?? target.effort;
	if (target.provider === "agy") {
		const needsWorktree = Boolean(request.allowFileEdits || requiresWrite);
		const isolation = needsWorktree
			? Object.freeze({
					kind: "git-worktree",
					applyStrategy: request.applyStrategy,
					defaultAllowedGlobs: request.allowedEditGlobs,
				})
			: READ_ONLY_ISOLATION;
		const agyMode = needsWorktree ? "accept-edits" : "plan";
		return Object.freeze({
			...target,
			effort,
			agyMode,
			isolation,
		});
	}
	if (target.provider === "gemini-cli") {
		return Object.freeze({
			...target,
			effort,
		});
	}
	return Object.freeze({
		...target,
		effort,
	});
}

export function resolveRoutePlan({
	request,
	quotaState,
	metrics,
	health,
	policyMatrix = DEFAULT_POLICY_MATRIX,
}) {
	const state = ALL_QUOTA_STATES.includes(quotaState) ? quotaState : "NORMAL";
	const classification = classifyTask(
		request.prompt,
		request.explicitTaskKind,
		request.allowFileEdits
	);

	const baseChain = policyMatrix[state][classification.taskKind];
	const rawChain = [];

	if (request.preferredModel) {
		const preferred = buildPreferredTarget(
			request.preferredModel,
			request.preferredEffort,
			request.allowFileEdits,
			request.allowedEditGlobs,
			request.applyStrategy
		);
		if (preferred) {
			rawChain.push(preferred);
		}
	}

	for (const item of baseChain) {
		rawChain.push(adaptTargetForRequest(item, request, classification.requiresWorkspaceWrite));
	}

	const candidates = [];
	const skippedCandidates = [];
	const pools = metrics?.pools ?? {};

	for (const target of rawChain) {
		const providerStatus = health?.[target.provider];
		if (providerStatus?.kind === "unavailable") {
			skippedCandidates.push(Object.freeze({ target, skipReason: "PROVIDER_UNAVAILABLE" }));
			continue;
		}
		if (providerStatus?.kind === "circuit-open") {
			skippedCandidates.push(Object.freeze({ target, skipReason: "CIRCUIT_OPEN" }));
			continue;
		}
		if (request.allowFileEdits && target.provider === "gemini-cli") {
			skippedCandidates.push(Object.freeze({ target, skipReason: "WRITE_UNSUPPORTED" }));
			continue;
		}
		const poolMetrics = pools[target.quotaPool];
		if (poolMetrics && Number(poolMetrics.consumedRatio) >= 1.0) {
			skippedCandidates.push(Object.freeze({ target, skipReason: "POOL_EXHAUSTED" }));
			continue;
		}
		candidates.push(target);
	}

	if (candidates.length === 0) {
		candidates.push(makeClaudeNativeTarget(request.preferredEffort ?? "low"));
	}

	const primary = candidates[0];
	const primaryLabel =
		primary.provider === "claude-native"
			? `claude-native (${primary.effort})`
			: `${primary.provider}:${primary.modelSlug} (${primary.effort})`;

	const rationale = `QuotaState=${state}, TaskKind=${classification.taskKind} -> primary=${primaryLabel} (${candidates.length} candidate(s), ${skippedCandidates.length} skipped).`;

	return Object.freeze({
		quotaState: state,
		classification,
		candidates: Object.freeze(candidates),
		skippedCandidates: Object.freeze(skippedCandidates),
		rationale,
	});
}
