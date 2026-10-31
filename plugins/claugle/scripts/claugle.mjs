#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_GATEWAY_PORT,
	GATEWAY_TURN_JSON_SCHEMA,
	buildGatewayPrompt,
	ensureGatewayDaemon,
	extractSlashCommandFastPath,
	formatAnthropicJsonResponse,
	readConfiguredModelEffort,
	resolveGatewayCandidates,
	startAnthropicGatewayServer,
	syncClaudeModelPickerSettings,
	writeAnthropicSseResponse,
} from "./anthropic-gateway.mjs";
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
	MODEL_ALIAS_MAP,
	MODEL_CAPABILITIES,
	MODEL_FAMILY_CATALOG,
	buildClaudeModelPickerConfig,
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
	resolveModelAlias,
	resolveModelAndEffort,
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
	DEFAULT_GATEWAY_PORT,
	DEFAULT_GOVERNOR_THRESHOLDS,
	DEFAULT_POLICY_MATRIX,
	EFFORT_LEVELS,
	GATEWAY_TURN_JSON_SCHEMA,
	MCP_TOOL_DEFINITIONS,
	MODEL_ALIAS_MAP,
	MODEL_CAPABILITIES,
	MODEL_FAMILY_CATALOG,
	abortWorktreeLease,
	acquireWorktreeLease,
	appendUsageEvent,
	buildAgyCliArgs,
	buildClaudeModelPickerConfig,
	buildGatewayPrompt,
	buildGeminiCliArgs,
	classifyTask,
	compactExpiredLedgerShards,
	createTaskExecutionId,
	detectProviderHealth,
	ensureGatewayDaemon,
	evaluateHookEvent,
	executeRoutedTask,
	extractSlashCommandFastPath,
	formatAnthropicJsonResponse,
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
	readConfiguredModelEffort,
	reconcileStaleWorktrees,
	recordCircuitBreakerOpen,
	resolveGatewayCandidates,
	resolveModelAlias,
	resolveModelAndEffort,
	resolveRoutePlan,
	runHeadlessProvider,
	startAnthropicGatewayServer,
	startMcpServer,
	syncClaudeModelPickerSettings,
	transitionQuotaState,
	writeAnthropicSseResponse,
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
		if (arg === "--port") {
			options.port = Number(expanded[i + 1]);
			i += 2;
			continue;
		}
		if (arg === "--daemon") {
			options.daemon = true;
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

function renderEffortGauge(effort, supportedEfforts) {
	if (supportedEfforts.length <= 1) {
		return `[■■■] ${effort} (고정)`;
	}
	const bars =
		effort === "low"
			? "■□□"
			: effort === "medium"
				? "■■□"
				: "■■■";
	return `[${bars}] ${effort}`;
}

export function runInteractiveModelPickerTui({
	settingsPath,
} = {}) {
	const initialSync = syncClaudeModelPickerSettings({ settingsPath });
	const families = MODEL_FAMILY_CATALOG;
	let selectedIdx = Math.max(
		0,
		families.findIndex((f) => f.familyId === initialSync.activeModel)
	);
	const effortsByFamily = {};
	for (const fam of families) {
		effortsByFamily[fam.familyId] =
			readConfiguredModelEffort(fam.familyId, initialSync.settingsPath) ||
			fam.defaultEffort;
	}

	const renderScreen = () => {
		const lines = [
			"\x1b[2J\x1b[H",
			"\x1b[1;36mSelect model & effort (claugle · Google AI & Claude Picker)\x1b[0m",
			"\x1b[2m위아래 방향키(↑/↓)로 모델을 고르고 좌우 방향키(←/→)로 추론 강도를 조절한 뒤 Enter를 누르세요. ( 취소는 Esc / q )\x1b[0m",
			"",
		];
		families.forEach((fam, idx) => {
			const isSelected = idx === selectedIdx;
			const pointer = isSelected ? "\x1b[1;32m❯\x1b[0m" : " ";
			const eff = effortsByFamily[fam.familyId] || fam.defaultEffort;
			const gauge = renderEffortGauge(eff, fam.supportedEfforts);
			const title = isSelected
				? `\x1b[1m${fam.label}\x1b[0m`
				: fam.label;
			lines.push(`${pointer} ${title}  \x1b[33m${gauge}\x1b[0m`);
			lines.push(`    \x1b[2m${fam.description}\x1b[0m`);
		});
		process.stdout.write(`${lines.join("\n")}\n`);
	};

	return new Promise((resolve) => {
		renderScreen();
		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.setEncoding("utf8");

		const cleanup = () => {
			process.stdin.removeListener("data", onData);
			try {
				process.stdin.setRawMode(false);
			} catch {}
			process.stdin.pause();
		};

		const onData = (key) => {
			if (key === "\u0003" || key === "q" || key === "\u001b") {
				cleanup();
				process.stdout.write("\n모델 변경을 취소했습니다.\n");
				resolve(0);
				return;
			}
			if (key === "\r" || key === "\n") {
				cleanup();
				const chosenFamily = families[selectedIdx];
				const chosenEffort =
					effortsByFamily[chosenFamily.familyId] || chosenFamily.defaultEffort;
				const updated = syncClaudeModelPickerSettings({
					settingsPath,
					selectedModel: chosenFamily.familyId,
					selectedEffort: chosenEffort,
				});
				process.stdout.write(`\n${JSON.stringify(updated, null, 2)}\n`);
				resolve(0);
				return;
			}
			if (key === "\u001b[A" || key === "k") {
				selectedIdx = (selectedIdx - 1 + families.length) % families.length;
				renderScreen();
				return;
			}
			if (key === "\u001b[B" || key === "j") {
				selectedIdx = (selectedIdx + 1) % families.length;
				renderScreen();
				return;
			}
			if (key === "\u001b[D" || key === "h" || key === "\u001b[C" || key === "l") {
				const fam = families[selectedIdx];
				const list = fam.supportedEfforts;
				if (list.length > 1) {
					const cur = effortsByFamily[fam.familyId] || fam.defaultEffort;
					const curIdx = Math.max(0, list.indexOf(cur));
					const delta = key === "\u001b[C" || key === "l" ? 1 : -1;
					const nextIdx = Math.max(0, Math.min(list.length - 1, curIdx + delta));
					effortsByFamily[fam.familyId] = list[nextIdx];
					renderScreen();
				}
			}
		};

		process.stdin.on("data", onData);
	});
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
		if (
			rawEnv.CLAUGLE_SKIP_GATEWAY_AUTOSTART !== "1" &&
			(!stdinText || stdinText.includes("SessionStart"))
		) {
			syncClaudeModelPickerSettings({
				settingsPath: rawEnv.CLAUGLE_CLAUDE_SETTINGS_PATH,
			});
			await ensureGatewayDaemon({
				port: Number(rawEnv.CLAUGLE_GATEWAY_PORT) || DEFAULT_GATEWAY_PORT,
				pluginRoot: rawEnv.CLAUDE_PLUGIN_ROOT,
			});
		}
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

	const { options, prompt } = parseCliSubcommandArgs(restArgs);

	if (subcommand === "model" || subcommand === "models") {
		const promptTokens = tokenizeShellArgs(prompt);
		const selectedModel = options.preferredModel || promptTokens[0];
		const selectedEffort = options.preferredEffort || promptTokens[1];

		if (
			!selectedModel &&
			!selectedEffort &&
			process.stdin.isTTY &&
			process.stdout.isTTY &&
			!options.jsonOutput
		) {
			return runInteractiveModelPickerTui({
				settingsPath: rawEnv.CLAUGLE_CLAUDE_SETTINGS_PATH,
			});
		}

		const synced = syncClaudeModelPickerSettings({
			settingsPath: rawEnv.CLAUGLE_CLAUDE_SETTINGS_PATH,
			selectedModel,
			selectedEffort,
		});
		if (synced.kind === "error") {
			process.stderr.write(`[claugle] ${synced.message}\n`);
			return 1;
		}
		process.stdout.write(`${JSON.stringify(synced, null, 2)}\n`);
		return 0;
	}

	if (subcommand === "gateway") {
		const port =
			Number.isFinite(options.port) && options.port > 0
				? Math.floor(options.port)
				: Number(rawEnv.CLAUGLE_GATEWAY_PORT) || DEFAULT_GATEWAY_PORT;
		if (options.daemon) {
			const status = await ensureGatewayDaemon({
				port,
				pluginRoot: env.pluginRoot,
			});
			process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
			return status.status === "failed-to-start" ? 1 : 0;
		}
		const started = await startAnthropicGatewayServer({
			port,
			env,
		});
		process.stdout.write(
			`${JSON.stringify({ status: "listening", port: started.port, url: started.url })}\n`
		);
		await new Promise(() => {});
		return 0;
	}

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
		`[claugle] Unknown subcommand "${subcommand}". Valid subcommands: run, write, review, quota, explain, model, gateway, hook, mcp, record-native.\n`
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
