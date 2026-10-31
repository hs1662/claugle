#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
	appendUsageEvent,
	compactExpiredLedgerShards,
	loadRollingQuotaSnapshot,
	normalizeUsageEvent,
} from "./ledger-store.mjs";
import {
	MCP_TOOL_DEFINITIONS,
	handleMcpJsonRpcRequest,
	startMcpServer,
} from "./mcp-server.mjs";
import {
	AGY_EXECUTION_MODES,
	ALL_QUOTA_POOLS,
	ALL_QUOTA_STATES,
	ALL_TASK_KINDS,
	DEFAULT_GOVERNOR_THRESHOLDS,
	DEFAULT_POLICY_MATRIX,
	EFFORT_LEVELS,
	MODEL_CAPABILITIES,
	classifyTask,
	createTaskExecutionId,
	isAgyModelSlug,
	isGeminiCliModelSlug,
	isUnitIntervalRatio,
	parseAbsolutePath,
	parseAgyOutputJson,
	parseGeminiCliOutputJson,
	parsePluginEnv,
	parseRelativeGlob,
	parseTaskRequest,
	resolveRoutePlan,
	transitionQuotaState,
} from "./policy-engine.mjs";
import {
	buildAgyCliArgs,
	buildGeminiCliArgs,
	detectProviderHealth,
	evaluateHookEvent,
	executeRoutedTask,
	recordCircuitBreakerOpen,
	runHeadlessProvider,
} from "./provider-runner.mjs";
import {
	abortWorktreeLease,
	acquireWorktreeLease,
	globToRegExp,
	harvestAndReleaseWorktree,
	matchesAllowedGlobs,
	reconcileStaleWorktrees,
} from "./worktree-sandbox.mjs";

export {
	AGY_EXECUTION_MODES,
	ALL_QUOTA_POOLS,
	ALL_QUOTA_STATES,
	ALL_TASK_KINDS,
	DEFAULT_GOVERNOR_THRESHOLDS,
	DEFAULT_POLICY_MATRIX,
	EFFORT_LEVELS,
	MCP_TOOL_DEFINITIONS,
	MODEL_CAPABILITIES,
	abortWorktreeLease,
	acquireWorktreeLease,
	appendUsageEvent,
	buildAgyCliArgs,
	buildGeminiCliArgs,
	classifyTask,
	compactExpiredLedgerShards,
	createTaskExecutionId,
	detectProviderHealth,
	evaluateHookEvent,
	executeRoutedTask,
	globToRegExp,
	handleMcpJsonRpcRequest,
	harvestAndReleaseWorktree,
	isAgyModelSlug,
	isGeminiCliModelSlug,
	isUnitIntervalRatio,
	loadRollingQuotaSnapshot,
	matchesAllowedGlobs,
	normalizeUsageEvent,
	parseAbsolutePath,
	parseAgyOutputJson,
	parseGeminiCliOutputJson,
	parsePluginEnv,
	parseRelativeGlob,
	parseTaskRequest,
	reconcileStaleWorktrees,
	recordCircuitBreakerOpen,
	resolveRoutePlan,
	runHeadlessProvider,
	startMcpServer,
	transitionQuotaState,
};

export function tokenizeShellArgs(rawArgString) {
	if (typeof rawArgString !== "string") return [];
	const tokens = [];
	let current = "";
	let quote = null;
	let i = 0;

	while (i < rawArgString.length) {
		const ch = rawArgString[i];
		if (quote) {
			if (ch === "\\" && quote === '"' && i + 1 < rawArgString.length) {
				current += rawArgString[i + 1];
				i += 2;
				continue;
			}
			if (ch === quote) {
				quote = null;
				i += 1;
				continue;
			}
			current += ch;
			i += 1;
			continue;
		}

		if (ch === "'" || ch === '"') {
			quote = ch;
			i += 1;
			continue;
		}

		if (ch === "\\" && i + 1 < rawArgString.length) {
			current += rawArgString[i + 1];
			i += 2;
			continue;
		}

		if (/\s/.test(ch)) {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
			i += 1;
			continue;
		}

		current += ch;
		i += 1;
	}

	if (current.length > 0) {
		tokens.push(current);
	}
	return tokens;
}

export function parseCliSubcommandArgs(rawArgs) {
	const expanded =
		rawArgs.length === 1 && rawArgs[0].includes(" ") && rawArgs[0].trim().startsWith("-")
			? tokenizeShellArgs(rawArgs[0])
			: rawArgs;

	const options = {
		contextFiles: [],
		allowedEditGlobs: [],
		allowFileEdits: false,
		applyStrategy: "patch-if-clean",
		jsonOutput: false,
	};
	const positional = [];

	let i = 0;
	while (i < expanded.length) {
		const arg = expanded[i];
		if (arg === "--model" || arg === "-m") {
			options.preferredModel = expanded[i + 1];
			i += 2;
			continue;
		}
		if (arg === "--effort" || arg === "-e") {
			options.preferredEffort = expanded[i + 1];
			i += 2;
			continue;
		}
		if (arg === "--kind" || arg === "-k") {
			options.explicitTaskKind = expanded[i + 1];
			i += 2;
			continue;
		}
		if (arg === "--context" || arg === "-c") {
			if (expanded[i + 1]) options.contextFiles.push(expanded[i + 1]);
			i += 2;
			continue;
		}
		if (arg === "--glob" || arg === "-g") {
			if (expanded[i + 1]) options.allowedEditGlobs.push(expanded[i + 1]);
			i += 2;
			continue;
		}
		if (arg === "--allow-edits" || arg === "--write") {
			options.allowFileEdits = true;
			i += 1;
			continue;
		}
		if (arg === "--branch-only") {
			options.applyStrategy = "branch-only";
			options.allowFileEdits = true;
			i += 1;
			continue;
		}
		if (arg === "--cwd") {
			options.cwd = expanded[i + 1];
			i += 2;
			continue;
		}
		if (arg === "--tokens") {
			options.tokens = Number(expanded[i + 1]);
			i += 2;
			continue;
		}
		if (arg === "--pool") {
			options.pool = expanded[i + 1];
			i += 2;
			continue;
		}
		if (arg === "--json") {
			options.jsonOutput = true;
			i += 1;
			continue;
		}
		if (arg === "--") {
			positional.push(...expanded.slice(i + 1));
			break;
		}
		positional.push(arg);
		i += 1;
	}

	return {
		options,
		prompt: positional.join(" ").trim(),
	};
}

function readAllStdinSync() {
	try {
		if (process.stdin.isTTY) return "";
		return fs.readFileSync(0, "utf8");
	} catch {
		return "";
	}
}

export async function runCli(argv = process.argv.slice(2), rawEnv = process.env) {
	const subcommand = argv[0] || "quota";
	const restArgs = argv.slice(1);

	if (subcommand === "mcp") {
		startMcpServer({ rawEnv });
		return 0;
	}

	if (subcommand === "hook") {
		const stdinText = readAllStdinSync();
		const hookOut = evaluateHookEvent({
			hookStdinJson: stdinText,
			env: rawEnv,
		});
		process.stdout.write(`${JSON.stringify(hookOut)}\n`);
		return 0;
	}

	const envRes = parsePluginEnv(rawEnv);
	if (envRes.kind === "error") {
		process.stderr.write(`[claugle] ${envRes.message}\n`);
		return 1;
	}
	const env = envRes.value;

	if (subcommand === "quota") {
		const snapshot = loadRollingQuotaSnapshot({
			pluginDataDir: env.pluginDataDir,
			weeklyBudgets: env.weeklyBudgets,
		});
		const health = detectProviderHealth(env);
		const report = {
			quotaState: snapshot.quotaState,
			totalEventsInWindow: snapshot.totalEventsInWindow,
			shardCount: snapshot.shardCount,
			pools: snapshot.metrics.pools,
			providerHealth: health,
		};
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		return 0;
	}

	const { options, prompt } = parseCliSubcommandArgs(restArgs);

	if (subcommand === "record-native") {
		const totalTokens = Number.isFinite(options.tokens) && options.tokens > 0 ? Math.floor(options.tokens) : 0;
		const pool = options.pool || "claude-code-native";
		const appended = appendUsageEvent({
			pluginDataDir: env.pluginDataDir,
			event: {
				sessionId: env.sessionId,
				provider: pool === "claude-code-native" ? "claude-native" : "agy",
				quotaPool: pool,
				modelSlug: options.preferredModel || "claude-host",
				taskKind: options.explicitTaskKind || "coding-complex",
				inputTokens: totalTokens,
				outputTokens: 0,
				thinkingTokens: 0,
				cacheReadTokens: 0,
				totalTokens,
				durationMs: 0,
				status: "SUCCESS",
			},
		});
		process.stdout.write(`${JSON.stringify(appended, null, 2)}\n`);
		return 0;
	}

	if (subcommand === "explain") {
		const reqRes = parseTaskRequest({
			prompt: prompt || "Explain current routing policy",
			explicitTaskKind: options.explicitTaskKind,
			preferredModel: options.preferredModel,
			preferredEffort: options.preferredEffort,
			cwd: options.cwd || env.projectDir,
			contextFiles: options.contextFiles,
			allowFileEdits: options.allowFileEdits,
			allowedEditGlobs: options.allowedEditGlobs.length > 0 ? options.allowedEditGlobs : undefined,
			applyStrategy: options.applyStrategy,
		});
		if (reqRes.kind === "error") {
			process.stderr.write(`[claugle] ${reqRes.message}\n`);
			return 1;
		}
		const snapshot = loadRollingQuotaSnapshot({
			pluginDataDir: env.pluginDataDir,
			weeklyBudgets: env.weeklyBudgets,
		});
		const health = detectProviderHealth(env);
		const plan = resolveRoutePlan({
			request: reqRes.value,
			quotaState: snapshot.quotaState,
			metrics: snapshot.metrics,
			health,
		});
		process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
		return 0;
	}

	if (subcommand === "run" || subcommand === "write" || subcommand === "review") {
		const explicitTaskKind =
			subcommand === "review"
				? "review"
				: subcommand === "write"
					? options.explicitTaskKind || (options.allowFileEdits ? "docs" : "writing")
					: options.explicitTaskKind;

		const reqRes = parseTaskRequest({
			prompt,
			explicitTaskKind,
			preferredModel: options.preferredModel,
			preferredEffort: options.preferredEffort,
			cwd: options.cwd || env.projectDir,
			contextFiles: options.contextFiles,
			allowFileEdits: subcommand === "review" ? false : options.allowFileEdits,
			allowedEditGlobs: options.allowedEditGlobs.length > 0 ? options.allowedEditGlobs : undefined,
			applyStrategy: options.applyStrategy,
		});

		if (reqRes.kind === "error") {
			process.stderr.write(`[claugle] ${reqRes.message}\n`);
			return 1;
		}

		const outcome = await executeRoutedTask({
			request: reqRes.value,
			env,
		});

		if (options.jsonOutput) {
			process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
		} else {
			process.stdout.write(`${outcome.responseText}\n`);
		}
		return outcome.status === "FAILED" ? 1 : 0;
	}

	process.stderr.write(
		`[claugle] Unknown subcommand "${subcommand}". Valid subcommands: run, write, review, quota, explain, hook, mcp, record-native.\n`
	);
	return 1;
}

const resolvedArgv1 =
	process.argv[1] && fs.existsSync(process.argv[1])
		? fs.realpathSync(process.argv[1])
		: process.argv[1];
const isMainModule =
	Boolean(resolvedArgv1) &&
	fs.realpathSync(fileURLToPath(import.meta.url)) === resolvedArgv1;

if (isMainModule) {
	runCli().then((code) => {
		process.exitCode = code;
	});
}
