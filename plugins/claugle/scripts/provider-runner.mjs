import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
	appendUsageEvent,
	compactExpiredLedgerShards,
	loadRollingQuotaSnapshot,
} from "./ledger-store.mjs";
import {
	DEFAULT_GOVERNOR_THRESHOLDS,
	DEFAULT_POLICY_MATRIX,
	classifyTask,
	createTaskExecutionId,
	parseAgyOutputJson,
	parseGeminiCliOutputJson,
	parsePluginEnv,
	parseTaskRequest,
	resolveRoutePlan,
} from "./policy-engine.mjs";
import {
	abortWorktreeLease,
	acquireWorktreeLease,
	harvestAndReleaseWorktree,
	reconcileStaleWorktrees,
} from "./worktree-sandbox.mjs";

function resolveExecutableInPath(binName) {
	if (!binName || typeof binName !== "string") return null;
	if (path.isAbsolute(binName)) {
		try {
			fs.accessSync(binName, fs.constants.X_OK);
			return binName;
		} catch {
			return null;
		}
	}
	const pathDirs = String(process.env.PATH || "")
		.split(path.delimiter)
		.filter(Boolean);
	for (const dir of pathDirs) {
		const candidate = path.join(dir, binName);
		try {
			const stat = fs.statSync(candidate);
			if (stat.isFile()) {
				fs.accessSync(candidate, fs.constants.X_OK);
				return candidate;
			}
		} catch {
			continue;
		}
	}
	return null;
}

function circuitFilePath(pluginDataDir, provider) {
	return path.join(pluginDataDir, "ledger", `circuit-${provider}.json`);
}

export function recordCircuitBreakerOpen({
	pluginDataDir,
	provider,
	binaryPath,
	reason,
	nowMs = Date.now(),
	cooldownMs = DEFAULT_GOVERNOR_THRESHOLDS.circuitBreakerCooldownMs,
}) {
	if (!pluginDataDir) return;
	const file = circuitFilePath(pluginDataDir, provider);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const state = {
		kind: "circuit-open",
		binaryPath,
		openedAt: nowMs,
		reopenAt: nowMs + cooldownMs,
		reason,
	};
	fs.writeFileSync(file, JSON.stringify(state), "utf8");
}

function readCircuitState(pluginDataDir, provider, binaryPath, nowMs) {
	if (!pluginDataDir) return null;
	const file = circuitFilePath(pluginDataDir, provider);
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8"));
		if (raw && raw.kind === "circuit-open" && Number(raw.reopenAt) > nowMs) {
			return Object.freeze({
				kind: "circuit-open",
				binaryPath,
				openedAt: Number(raw.openedAt),
				reopenAt: Number(raw.reopenAt),
				reason: raw.reason || "QUOTA_EXHAUSTED",
			});
		}
		fs.unlinkSync(file);
	} catch {
		return null;
	}
	return null;
}

export function detectProviderHealth(env = {}, nowMs = Date.now()) {
	const agyDesired = env.agyBinOverride || process.env.CLAUGLE_AGY_BIN || "agy";
	const geminiDesired = env.geminiBinOverride || process.env.CLAUGLE_GEMINI_BIN || "gemini";
	const claudeBin = resolveExecutableInPath("claude") || "/usr/bin/claude";

	const agyPath = resolveExecutableInPath(agyDesired);
	const geminiPath = resolveExecutableInPath(geminiDesired);

	let agyHealth;
	if (!agyPath) {
		agyHealth = Object.freeze({
			kind: "unavailable",
			reason: `Executable "${agyDesired}" not found in PATH.`,
		});
	} else {
		const circuit = readCircuitState(env.pluginDataDir, "agy", agyPath, nowMs);
		agyHealth = circuit ?? Object.freeze({ kind: "healthy", binaryPath: agyPath });
	}

	let geminiHealth;
	if (!geminiPath) {
		geminiHealth = Object.freeze({
			kind: "unavailable",
			reason: `Executable "${geminiDesired}" not found in PATH.`,
		});
	} else {
		const circuit = readCircuitState(env.pluginDataDir, "gemini-cli", geminiPath, nowMs);
		geminiHealth = circuit ?? Object.freeze({ kind: "healthy", binaryPath: geminiPath });
	}

	return Object.freeze({
		"claude-native": Object.freeze({
			kind: "healthy",
			binaryPath: claudeBin,
		}),
		agy: agyHealth,
		"gemini-cli": geminiHealth,
	});
}

export function buildAgyCliArgs(invocation) {
	if (!invocation || typeof invocation.prompt !== "string" || invocation.prompt.trim().length === 0) {
		throw new Error("AgyCliInvocation requires a non-empty prompt.");
	}
	const args = [
		"-p",
		invocation.prompt,
		"--model",
		invocation.modelSlug,
		"--effort",
		invocation.effort ?? "high",
		"--output-format",
		"json",
		"--disable-slash-commands",
		"--mode",
		invocation.mode ?? "plan",
	];
	if (Array.isArray(invocation.addDirs)) {
		for (const dir of invocation.addDirs) {
			if (typeof dir === "string" && dir.length > 0) {
				args.push("--add-dir", dir);
			}
		}
	}
	return Object.freeze(args);
}

export function buildGeminiCliArgs(invocation) {
	if (!invocation || typeof invocation.prompt !== "string" || invocation.prompt.trim().length === 0) {
		throw new Error("Gemini CLI invocation requires a non-empty prompt.");
	}
	return Object.freeze([
		"-p",
		invocation.prompt,
		"--model",
		invocation.modelSlug ?? "gemini-2.5-pro",
		"--output-format",
		"json",
	]);
}

function classifyProviderFailure(combinedOutput) {
	const text = String(combinedOutput || "");
	if (/quota[_\s-]*exhausted|resource_exhausted|weekly\s+limit|insufficient_quota|exceeded.*quota/i.test(text)) {
		return "QUOTA_EXHAUSTED";
	}
	if (/rate[_\s-]*limit|too\s+many\s+requests|\b429\b/i.test(text)) {
		return "RATE_LIMITED";
	}
	if (/auth[_\s-]*required|unauthenticated|invalid[_\s-]*credentials|login\s+required|\b401\b|\b403\b/i.test(text)) {
		return "AUTH_REQUIRED";
	}
	return "NON_ZERO_EXIT";
}

export function runHeadlessProvider(params) {
	const provider = params.provider;
	const binaryPath = params.binaryPath;
	const cwd = params.cwd || process.cwd();
	const timeoutMs = Number.isFinite(Number(params.timeoutMs)) && Number(params.timeoutMs) > 0
		? Math.floor(Number(params.timeoutMs))
		: 120_000;

	const args =
		provider === "gemini-cli"
			? buildGeminiCliArgs(params)
			: buildAgyCliArgs({
					binaryPath,
					prompt: params.prompt,
					modelSlug: params.modelSlug,
					effort: params.effort ?? "high",
					mode: params.mode ?? "plan",
					outputFormat: "json",
					disableSlashCommands: true,
					cwd,
					addDirs: params.addDirs,
					timeoutMs,
				});

	const startedAt = Date.now();

	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;

		const child = spawn(binaryPath, args, {
			cwd,
			env: {
				...process.env,
				CLAUGLE_HEADLESS_SUBPROCESS: "1",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		const timer = setTimeout(() => {
			timedOut = true;
			if (child.exitCode === null && !child.killed) {
				child.kill("SIGTERM");
			}
		}, timeoutMs);

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});

		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});

		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const durationMs = Math.max(0, Date.now() - startedAt);
			resolve(
				Object.freeze({
					kind: "failure",
					reason: "NON_ZERO_EXIT",
					message: `Failed to spawn ${binaryPath}: ${err.message}`,
					exitCode: null,
					durationMs,
				})
			);
		});

		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const durationMs = Math.max(0, Date.now() - startedAt);

			if (timedOut) {
				resolve(
					Object.freeze({
						kind: "failure",
						reason: "TIMEOUT",
						message: `${provider} timed out after ${timeoutMs}ms.`,
						exitCode: code,
						durationMs,
					})
				);
				return;
			}

			if (code !== 0) {
				const combined = `${stderr}\n${stdout}`.trim();
				const reason = classifyProviderFailure(combined);
				resolve(
					Object.freeze({
						kind: "failure",
						reason,
						message: combined || `${provider} exited with status ${code}.`,
						exitCode: code,
						durationMs,
					})
				);
				return;
			}

			const parsed =
				provider === "gemini-cli"
					? parseGeminiCliOutputJson(stdout)
					: parseAgyOutputJson(stdout);

			if (parsed.kind === "error") {
				const combined = `${stderr}\n${stdout}`.trim();
				const maybeQuota = classifyProviderFailure(combined);
				const reason =
					maybeQuota !== "NON_ZERO_EXIT" ? maybeQuota : "MALFORMED_JSON";
				resolve(
					Object.freeze({
						kind: "failure",
						reason,
						message: parsed.message,
						exitCode: code,
						durationMs,
					})
				);
				return;
			}

			resolve(
				Object.freeze({
					kind: "success",
					payload: parsed.value,
					durationMs,
				})
			);
		});
	});
}

function isGitRepository(dirPath) {
	try {
		execFileSync("git", ["-C", dirPath, "rev-parse", "--is-inside-work-tree"], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		return true;
	} catch {
		return false;
	}
}

function formatPromptWithContextFiles(request) {
	if (!Array.isArray(request.contextFiles) || request.contextFiles.length === 0) {
		return request.prompt;
	}
	const sections = [request.prompt, "", "Context files:"];
	for (const relOrAbs of request.contextFiles) {
		const resolved = path.isAbsolute(relOrAbs)
			? relOrAbs
			: path.resolve(request.cwd, relOrAbs);
		try {
			const stat = fs.statSync(resolved);
			if (stat.isFile() && stat.size <= 128 * 1024) {
				const content = fs.readFileSync(resolved, "utf8");
				sections.push(`\n--- ${relOrAbs} ---\n${content}`);
			} else {
				sections.push(`- ${relOrAbs}`);
			}
		} catch {
			sections.push(`- ${relOrAbs}`);
		}
	}
	return sections.join("\n");
}

export async function executeRoutedTask(params) {
	const rawEnv = params.env?.pluginDataDir ? { kind: "ok", value: params.env } : parsePluginEnv(params.env);
	if (rawEnv.kind === "error") {
		throw new Error(rawEnv.message);
	}
	const env = rawEnv.value;

	const rawReq = params.request?.taskId && params.request?.cwd
		? { kind: "ok", value: params.request }
		: parseTaskRequest(params.request);
	if (rawReq.kind === "error") {
		throw new Error(rawReq.message);
	}
	const request = rawReq.value;

	const nowMs = Number.isFinite(Number(params.nowMs)) ? Math.floor(Number(params.nowMs)) : Date.now();
	const thresholds = params.thresholds ?? DEFAULT_GOVERNOR_THRESHOLDS;
	const policyMatrix = params.policyMatrix ?? DEFAULT_POLICY_MATRIX;

	const snapshot = loadRollingQuotaSnapshot({
		pluginDataDir: env.pluginDataDir,
		weeklyBudgets: env.weeklyBudgets,
		nowMs,
		thresholds,
	});

	const health = params.health ?? detectProviderHealth(env, nowMs);
	const plan = resolveRoutePlan({
		request,
		quotaState: snapshot.quotaState,
		metrics: snapshot.metrics,
		health,
		thresholds,
		policyMatrix,
	});

	const fullPrompt = formatPromptWithContextFiles(request);
	const attemptedTargets = [];
	const errors = [];

	for (const candidate of plan.candidates) {
		attemptedTargets.push(candidate);

		if (candidate.provider === "claude-native") {
			return Object.freeze({
				taskId: request.taskId,
				status: "DELEGATE_TO_HOST",
				selectedTarget: candidate,
				attemptedTargets: Object.freeze(attemptedTargets),
				plan,
				responseText:
					`[claugle] Delegated to host Claude Code session (${candidate.effort} effort). ` +
					`QuotaState=${plan.quotaState}, TaskKind=${plan.classification.taskKind}.`,
			});
		}

		const providerHealth = health[candidate.provider];
		if (!providerHealth || providerHealth.kind !== "healthy") {
			errors.push(`${candidate.provider} is not healthy (${providerHealth?.kind ?? "unknown"}).`);
			continue;
		}

		let lease = null;
		const useWorktree =
			candidate.provider === "agy" &&
			candidate.isolation.kind === "git-worktree" &&
			isGitRepository(request.cwd);

		if (useWorktree) {
			lease = acquireWorktreeLease({
				taskId: `${request.taskId}-${attemptedTargets.length}`,
				hostRepoRoot: request.cwd,
				pluginDataDir: env.pluginDataDir,
				allowedGlobs: request.allowedEditGlobs,
				applyStrategy: request.applyStrategy,
				nowMs,
			});
		}

		const executionCwd = lease ? lease.worktreePath : request.cwd;
		const execResult = await runHeadlessProvider({
			provider: candidate.provider,
			binaryPath: providerHealth.binaryPath,
			prompt: fullPrompt,
			modelSlug: candidate.modelSlug,
			effort: candidate.effort,
			mode: candidate.agyMode,
			cwd: executionCwd,
			timeoutMs: candidate.timeoutMs,
		});

		if (execResult.kind === "success") {
			let worktreeOutcome;
			if (lease) {
				worktreeOutcome = harvestAndReleaseWorktree(lease);
			}

			const appended = appendUsageEvent({
				pluginDataDir: env.pluginDataDir,
				event: {
					eventId:
						attemptedTargets.length === 1
							? request.taskId
							: createTaskExecutionId(nowMs),
					sessionId: env.sessionId,
					recordedAt: nowMs,
					provider: candidate.provider,
					quotaPool: candidate.quotaPool,
					modelSlug: candidate.modelSlug,
					taskKind: plan.classification.taskKind,
					inputTokens: execResult.payload.usage.inputTokens,
					outputTokens: execResult.payload.usage.outputTokens,
					thinkingTokens: execResult.payload.usage.thinkingTokens,
					cacheReadTokens: execResult.payload.usage.cacheReadTokens,
					totalTokens: execResult.payload.usage.totalTokens,
					durationMs: execResult.durationMs,
					status: "SUCCESS",
				},
			});

			if (worktreeOutcome?.kind === "rejected-glob-violation") {
				return Object.freeze({
					taskId: request.taskId,
					status: "FAILED",
					selectedTarget: candidate,
					attemptedTargets: Object.freeze(attemptedTargets),
					plan,
					responseText: `Rejected file edits outside allowed globs: ${worktreeOutcome.violatingFiles.join(", ")}`,
					worktreeOutcome,
					ledgerEvent: appended.event,
				});
			}

			return Object.freeze({
				taskId: request.taskId,
				status: "COMPLETED",
				selectedTarget: candidate,
				attemptedTargets: Object.freeze(attemptedTargets),
				plan,
				responseText: execResult.payload.response,
				...(worktreeOutcome ? { worktreeOutcome } : {}),
				ledgerEvent: appended.event,
			});
		}

		if (lease) {
			abortWorktreeLease(lease);
		}

		errors.push(
			`${candidate.provider}:${candidate.modelSlug} failed (${execResult.reason}): ${execResult.message}`
		);

		if (execResult.reason === "QUOTA_EXHAUSTED" || execResult.reason === "RATE_LIMITED") {
			appendUsageEvent({
				pluginDataDir: env.pluginDataDir,
				event: {
					eventId: createTaskExecutionId(nowMs),
					sessionId: env.sessionId,
					recordedAt: nowMs,
					provider: candidate.provider,
					quotaPool: candidate.quotaPool,
					modelSlug: candidate.modelSlug,
					taskKind: plan.classification.taskKind,
					inputTokens: 0,
					outputTokens: 0,
					thinkingTokens: 0,
					cacheReadTokens: 0,
					totalTokens: 0,
					durationMs: execResult.durationMs,
					status: "QUOTA_EXHAUSTED",
				},
			});
		}
	}

	const fallbackTarget = attemptedTargets[attemptedTargets.length - 1] ?? plan.candidates[0];
	return Object.freeze({
		taskId: request.taskId,
		status: "FAILED",
		selectedTarget: fallbackTarget,
		attemptedTargets: Object.freeze(attemptedTargets),
		plan,
		responseText: `All routed candidates failed. Errors: ${errors.join(" | ")}`,
	});
}

function persistPluginDataEnvVar(envFile, pluginDataDir) {
	if (!envFile) return false;
	const parentDir = path.dirname(envFile);
	if (!fs.existsSync(parentDir)) return false;
	const exportLine = `export CLAUDE_PLUGIN_DATA=${JSON.stringify(pluginDataDir)}`;
	const existing = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
	if (!existing.includes("CLAUDE_PLUGIN_DATA=")) {
		const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
		fs.appendFileSync(envFile, `${prefix}${exportLine}\n`, "utf8");
	}
	return true;
}

export function evaluateHookEvent({ hookStdinJson, env: rawEnv, nowMs = Date.now() }) {
	const parsedEnv = rawEnv?.pluginDataDir ? { kind: "ok", value: rawEnv } : parsePluginEnv(rawEnv);
	if (parsedEnv.kind === "error") {
		return {
			continue: true,
			systemMessage: `[claugle] Invalid environment: ${parsedEnv.message}`,
		};
	}
	const env = parsedEnv.value;

	let payload = {};
	if (typeof hookStdinJson === "string" && hookStdinJson.trim().length > 0) {
		try {
			payload = JSON.parse(hookStdinJson);
		} catch {
			return { continue: true };
		}
	} else if (hookStdinJson && typeof hookStdinJson === "object") {
		payload = hookStdinJson;
	}

	const eventName = payload.hook_event_name || payload.event || "SessionStart";

	if (eventName === "SessionStart") {
		fs.mkdirSync(path.join(env.pluginDataDir, "ledger"), { recursive: true });
		fs.mkdirSync(path.join(env.pluginDataDir, "worktrees"), { recursive: true });
		persistPluginDataEnvVar(env.envFile, env.pluginDataDir);

		const compaction = compactExpiredLedgerShards({
			pluginDataDir: env.pluginDataDir,
			nowMs,
		});
		const worktreeCleanup = reconcileStaleWorktrees({
			hostRepoRoot: isGitRepository(env.projectDir) ? env.projectDir : undefined,
			pluginDataDir: env.pluginDataDir,
			nowMs,
		});
		const snapshot = loadRollingQuotaSnapshot({
			pluginDataDir: env.pluginDataDir,
			weeklyBudgets: env.weeklyBudgets,
			nowMs,
		});

		const claudePct = (snapshot.metrics.pools["claude-code-native"].consumedRatio * 100).toFixed(1);
		const agyGeminiPct = (snapshot.metrics.pools["agy-gemini-pool"].consumedRatio * 100).toFixed(1);
		const agyClaudePct = (snapshot.metrics.pools["agy-claude-pool"].consumedRatio * 100).toFixed(1);

		const contextSummary =
			`[claugle] QuotaState=${snapshot.quotaState} ` +
			`(claude-native=${claudePct}%, agy-gemini=${agyGeminiPct}%, agy-claude=${agyClaudePct}%). ` +
			`Compacted ${compaction.removedShards.length} expired shard(s), pruned ${worktreeCleanup.prunedWorktrees.length} stale worktree(s).`;

		return Object.freeze({
			hookSpecificOutput: {
				hookEventName: "SessionStart",
				additionalContext: contextSummary,
			},
		});
	}

	if (eventName === "UserPromptSubmit") {
		const promptText = String(payload.prompt ?? payload.user_prompt ?? "").trim();
		if (!promptText || promptText.startsWith("/")) {
			return { continue: true };
		}

		const snapshot = loadRollingQuotaSnapshot({
			pluginDataDir: env.pluginDataDir,
			weeklyBudgets: env.weeklyBudgets,
			nowMs,
		});
		const classification = classifyTask(promptText);
		const candidates = DEFAULT_POLICY_MATRIX[snapshot.quotaState][classification.taskKind];
		const primary = candidates[0];

		if (primary.provider === "claude-native" && snapshot.quotaState === "NORMAL") {
			return { continue: true };
		}

		const recommendedTool =
			classification.taskKind === "writing" ||
			classification.taskKind === "docs" ||
			classification.taskKind === "translation"
				? "mcp__plugin_claugle_claugle__claugle_write (or subagent claugle:gemini-writer)"
				: classification.taskKind === "review"
					? "mcp__plugin_claugle_claugle__claugle_review (or subagent claugle:agy-reviewer)"
					: "mcp__plugin_claugle_claugle__claugle_run (or subagent claugle:agy-coder)";

		const targetLabel =
			primary.provider === "claude-native"
				? `claude-native (${primary.effort})`
				: `${primary.provider}:${primary.modelSlug} (${primary.effort})`;

		return Object.freeze({
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				additionalContext:
					`[claugle routing policy] QuotaState=${snapshot.quotaState}, TaskKind=${classification.taskKind} ` +
					`-> primary target is ${targetLabel}. Delegate via ${recommendedTool} to preserve host Claude Code quota.`,
			},
		});
	}

	return { continue: true };
}
