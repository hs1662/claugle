#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_GATEWAY_PORT,
	GATEWAY_TURN_JSON_SCHEMA,
	buildGatewayPrompt,
	ensureGatewayDaemon,
	formatAnthropicJsonResponse,
	isReplaceableLocalBaseUrl,
	parseGatewayPort,
	readConfiguredModelEffort,
	readSettingsBaseUrl,
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
	ANTHROPIC_BUILTIN_CATALOG,
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
	resolveBuiltinAnthropicModel,
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
	ANTHROPIC_BUILTIN_CATALOG,
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
	resolveBuiltinAnthropicModel,
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

function findClosingQuote(text, openAt) {
	const quote = text[openAt];
	for (let i = openAt + 1; i < text.length; i += 1) {
		if (quote === '"' && text[i] === "\\") {
			i += 1;
			continue;
		}
		if (text[i] === quote && (i + 1 === text.length || /\s/.test(text[i + 1]))) {
			return i;
		}
	}
	return -1;
}

// A quote opens a group only at the start of a word and only when it is closed at the end
// of a word, so apostrophes in prose ("the user's parser") stay literal.
function scanShellTokens(text) {
	const tokens = [];
	let i = 0;
	while (i < text.length) {
		if (/\s/.test(text[i])) {
			i += 1;
			continue;
		}
		const start = i;
		let value = "";
		let quoted = false;
		while (i < text.length && !/\s/.test(text[i])) {
			const ch = text[i];
			const close = i === start && (ch === '"' || ch === "'") ? findClosingQuote(text, i) : -1;
			if (close > i) {
				const inner = text.slice(i + 1, close);
				value += ch === '"' ? inner.replace(/\\(.)/gs, "$1") : inner;
				quoted = true;
				i = close + 1;
			} else if (ch === "\\" && i + 1 < text.length) {
				value += text[i + 1];
				i += 2;
			} else {
				value += ch;
				i += 1;
			}
		}
		tokens.push({ value, start, end: i, index: tokens.length, quoted });
	}
	return tokens;
}

export function tokenizeShellArgs(rawArgString) {
	if (typeof rawArgString !== "string") return [];
	return scanShellTokens(rawArgString).map((token) => token.value);
}

const VALUE_FLAGS = Object.freeze({
	"--model": "preferredModel",
	"-m": "preferredModel",
	"--effort": "preferredEffort",
	"-e": "preferredEffort",
	"--kind": "explicitTaskKind",
	"-k": "explicitTaskKind",
	"--context": "contextFiles",
	"-c": "contextFiles",
	"--glob": "allowedEditGlobs",
	"-g": "allowedEditGlobs",
	"--cwd": "cwd",
	"--tokens": "tokens",
	"--pool": "pool",
	"--port": "port",
});
const LIST_OPTIONS = new Set(["contextFiles", "allowedEditGlobs"]);
const SWITCH_FLAGS = Object.freeze({
	"--allow-edits": { allowFileEdits: true },
	"--write": { allowFileEdits: true },
	"--branch-only": { applyStrategy: "branch-only", allowFileEdits: true },
	"--json": { jsonOutput: true },
	"--daemon": { daemon: true },
	"--args-stdin": { argsFromStdin: true },
});

function flagAt(tokens, i, longOnly) {
	const token = tokens[i];
	if (!token || token.quoted || (longOnly && !token.value.startsWith("--"))) return null;
	if (Object.hasOwn(SWITCH_FLAGS, token.value)) {
		return { width: 1, apply: (options) => Object.assign(options, SWITCH_FLAGS[token.value]) };
	}
	if (!Object.hasOwn(VALUE_FLAGS, token.value)) return null;
	if (i + 1 >= tokens.length) return { width: 1, missingValueFor: token.value };
	const key = VALUE_FLAGS[token.value];
	const value = tokens[i + 1].value;
	return {
		width: 2,
		apply: (options) => {
			if (LIST_OPTIONS.has(key)) options[key].push(value);
			else options[key] = value;
		},
	};
}

function parsesAsFlagRun(tokens, from) {
	for (let i = from; i < tokens.length; ) {
		const flag = flagAt(tokens, i, true);
		if (!flag || flag.missingValueFor) return false;
		i += flag.width;
	}
	return true;
}

// Free text from a slash command is prose, so only a leading run of flags (any form) and a
// trailing run of long flags count as options; "git commit -m" in a sentence stays prose, and a
// bare "--" ends option parsing wherever it appears.
function extractEdgeFlags(tokens, options) {
	let start = 0;
	for (;;) {
		if (tokens[start] && !tokens[start].quoted && tokens[start].value === "--") {
			return tokens.slice(start + 1);
		}
		const flag = flagAt(tokens, start, false);
		if (!flag) break;
		if (flag.missingValueFor) throw new Error(`${flag.missingValueFor} needs a value.`);
		flag.apply(options);
		start += flag.width;
	}
	const terminator = tokens.findIndex((token, i) => i >= start && !token.quoted && token.value === "--");
	if (terminator >= 0) {
		const flagNearby = [...tokens.slice(start, terminator), ...tokens.slice(terminator + 1)].find((token) =>
			flagAt([token, { value: "" }], 0, true)
		);
		if (flagNearby) {
			throw new Error(
				`"${flagNearby.value}" appears in text that also has a bare -- in the middle, so it is unclear whether it is an option. Put options before the text, or quote the word.`
			);
		}
		return tokens.slice(start);
	}
	let end = tokens.length;
	for (let k = start + 1; k < tokens.length; k += 1) {
		if (parsesAsFlagRun(tokens, k)) {
			end = k;
			break;
		}
	}
	for (let i = end; i < tokens.length; ) {
		const flag = flagAt(tokens, i, true);
		flag.apply(options);
		i += flag.width;
	}
	return tokens.slice(start, end);
}

function extractFlags(tokens, options) {
	const promptTokens = [];
	for (let i = 0; i < tokens.length; ) {
		if (!tokens[i].quoted && tokens[i].value === "--") {
			promptTokens.push(...tokens.slice(i + 1));
			break;
		}
		const flag = flagAt(tokens, i, false);
		if (!flag) {
			promptTokens.push(tokens[i]);
			i += 1;
			continue;
		}
		if (flag.missingValueFor) throw new Error(`${flag.missingValueFor} needs a value.`);
		flag.apply(options);
		i += flag.width;
	}
	return promptTokens;
}

// Rebuilds the prompt from the original text so quotes, newlines, and spacing survive.
function spliceRawText(text, tokens) {
	const runs = [];
	for (const token of tokens) {
		const last = runs.at(-1);
		if (last && token.index === last.index + 1) {
			last.end = token.end;
			last.index = token.index;
		} else {
			runs.push({ start: token.start, end: token.end, index: token.index });
		}
	}
	return runs.map((run) => text.slice(run.start, run.end)).join(" ");
}

export function parseCliSubcommandArgs(rawArgs, argsText) {
	const options = {
		contextFiles: [],
		allowedEditGlobs: [],
		allowFileEdits: false,
		applyStrategy: "patch-if-clean",
		jsonOutput: false,
	};
	const argvTokens = rawArgs.map((value, index) => ({ value, index, quoted: false }));
	const promptParts = [extractFlags(argvTokens, options).map((token) => token.value).join(" ")];
	if (options.argsFromStdin && typeof argsText === "string") {
		const tokens = scanShellTokens(argsText);
		promptParts.push(spliceRawText(argsText, extractEdgeFlags(tokens, options)));
	}

	return {
		options,
		prompt: promptParts.filter(Boolean).join(" ").trim(),
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

function hookEventName(stdinText) {
	try {
		return JSON.parse(stdinText)?.hook_event_name;
	} catch {
		return undefined;
	}
}

const PROVIDER_BY_POOL = Object.freeze({
	"claude-code-native": "claude-native",
	"agy-claude-pool": "agy",
	"agy-gemini-pool": "agy",
	"gemini-cli-pool": "gemini-cli",
});

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
	gatewayUrl,
	replaceLocalBaseUrl = false,
} = {}) {
	const initialSync = syncClaudeModelPickerSettings({ settingsPath, gatewayUrl, replaceLocalBaseUrl });
	const families = [...ANTHROPIC_BUILTIN_CATALOG, ...MODEL_FAMILY_CATALOG];
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
					gatewayUrl,
					replaceLocalBaseUrl,
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
		const warnings = [];
		if (rawEnv.CLAUGLE_SKIP_GATEWAY_AUTOSTART !== "1" && hookEventName(stdinText) === "SessionStart") {
			const port = parseGatewayPort(rawEnv.CLAUGLE_GATEWAY_PORT);
			const settingsPath = rawEnv.CLAUGLE_CLAUDE_SETTINGS_PATH;
			const synced = syncClaudeModelPickerSettings({
				settingsPath,
				gatewayUrl: `http://127.0.0.1:${port}`,
				replaceLocalBaseUrl: await isReplaceableLocalBaseUrl(readSettingsBaseUrl(settingsPath)),
			});
			if (synced.kind === "error") warnings.push(`[claugle] ${synced.message}`);
			const daemon = await ensureGatewayDaemon({ port, pluginRoot: rawEnv.CLAUDE_PLUGIN_ROOT });
			if (daemon.status === "stale-daemon" || daemon.status === "failed-to-start") {
				warnings.push(
					`[claugle] The gateway on port ${port} is ${daemon.status}. ${daemon.message ?? "Requests Claude Code sends to it will fail until it runs."}`
				);
			}
		}
		const hookOut = evaluateHookEvent({
			hookStdinJson: stdinText,
			env: rawEnv,
		});
		const output =
			warnings.length > 0
				? { ...hookOut, systemMessage: [hookOut.systemMessage, ...warnings].filter(Boolean).join("\n") }
				: hookOut;
		process.stdout.write(`${JSON.stringify(output)}\n`);
		return 0;
	}

	const envRes = parsePluginEnv(rawEnv);
	if (envRes.kind === "error") {
		process.stderr.write(`[claugle] ${envRes.message}\n`);
		return 1;
	}
	const env = envRes.value;

	const { options, prompt } = parseCliSubcommandArgs(
		restArgs,
		restArgs.includes("--args-stdin") ? readAllStdinSync() : undefined
	);

	const configuredGatewayUrl = `http://127.0.0.1:${parseGatewayPort(rawEnv.CLAUGLE_GATEWAY_PORT)}`;

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
				gatewayUrl: configuredGatewayUrl,
				replaceLocalBaseUrl: await isReplaceableLocalBaseUrl(readSettingsBaseUrl(rawEnv.CLAUGLE_CLAUDE_SETTINGS_PATH)),
			});
		}

		const synced = syncClaudeModelPickerSettings({
			settingsPath: rawEnv.CLAUGLE_CLAUDE_SETTINGS_PATH,
			gatewayUrl: configuredGatewayUrl,
			replaceLocalBaseUrl: await isReplaceableLocalBaseUrl(readSettingsBaseUrl(rawEnv.CLAUGLE_CLAUDE_SETTINGS_PATH)),
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
		const requestedPort = Number(options.port);
		const port =
			Number.isFinite(requestedPort) && requestedPort > 0
				? Math.floor(requestedPort)
				: parseGatewayPort(rawEnv.CLAUGLE_GATEWAY_PORT);
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
		const pool = options.pool ?? "claude-code-native";
		if (!Object.hasOwn(PROVIDER_BY_POOL, pool)) {
			process.stderr.write(`[claugle] Unknown quota pool "${pool}". Expected one of: ${ALL_QUOTA_POOLS.join(", ")}.\n`);
			return 1;
		}
		const tokensText = options.tokens ?? "0";
		if (!/^\d+$/.test(tokensText)) {
			process.stderr.write(`[claugle] --tokens expects a non-negative integer, got "${tokensText}".\n`);
			return 1;
		}
		const totalTokens = Number(tokensText);
		const appended = appendUsageEvent({
			pluginDataDir: env.pluginDataDir,
			event: {
				sessionId: env.sessionId,
				provider: PROVIDER_BY_POOL[pool],
				quotaPool: pool,
				modelSlug: options.preferredModel,
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
	runCli().then(
		(code) => {
			process.exitCode = code;
		},
		(err) => {
			process.stderr.write(`[claugle] ${err instanceof Error ? err.message : String(err)}\n`);
			process.exitCode = 1;
		}
	);
}
