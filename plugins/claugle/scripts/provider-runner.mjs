import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	appendUsageEvent,
	compactExpiredLedgerShards,
	loadRollingQuotaSnapshot,
} from "./ledger-store.mjs";
import {
	AGY_WORKSPACE_DIRS,
	DEFAULT_GOVERNOR_THRESHOLDS,
	DEFAULT_POLICY_MATRIX,
	HARNESS_CONFIG_NAMES,
	MODEL_CAPABILITIES,
	classifyTask,
	createTaskExecutionId,
	isSafeTaskId,
	parseAbsolutePath,
	parseAgyOutputJson,
	parseGeminiCliOutputJson,
	parsePluginEnv,
	parseTaskRequest,
	resolveModelAndEffort,
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

function writeJsonAtomic(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmpFile = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmpFile, JSON.stringify(value), "utf8");
	fs.renameSync(tmpFile, file);
}

// agy quotas are per model, so a circuit opens for one quota pool and the provider keeps serving
// its other pools. The provider as a whole is out only once every pool it serves is open.
function circuitFilePath(pluginDataDir, provider, quotaPool) {
	return path.join(pluginDataDir, "ledger", `circuit-${provider}-${quotaPool}.json`);
}

function poolsServedBy(provider) {
	return [
		...new Set(
			Object.values(MODEL_CAPABILITIES)
				.filter((cap) => cap.provider === provider)
				.map((cap) => cap.quotaPool)
		),
	];
}

export function recordCircuitBreakerOpen({
	pluginDataDir,
	provider,
	quotaPool,
	binaryPath,
	reason,
	nowMs = Date.now(),
	cooldownMs = DEFAULT_GOVERNOR_THRESHOLDS.circuitBreakerCooldownMs,
}) {
	if (!pluginDataDir) return;
	writeJsonAtomic(circuitFilePath(pluginDataDir, provider, quotaPool), {
		kind: "circuit-open",
		quotaPool,
		binaryPath,
		openedAt: nowMs,
		reopenAt: nowMs + cooldownMs,
		reason,
	});
}

function readOpenCircuit(pluginDataDir, provider, quotaPool, nowMs) {
	if (!pluginDataDir) return null;
	const file = circuitFilePath(pluginDataDir, provider, quotaPool);
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8"));
		if (raw && raw.kind === "circuit-open" && Number(raw.reopenAt) > nowMs) {
			return Object.freeze({
				quotaPool,
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

function healthOf(provider, desiredBin, pluginDataDir, nowMs) {
	const binaryPath = resolveExecutableInPath(desiredBin);
	if (!binaryPath) {
		return Object.freeze({ kind: "unavailable", reason: `Executable "${desiredBin}" not found in PATH.` });
	}
	const pools = poolsServedBy(provider);
	const openCircuits = Object.freeze(
		pools.map((pool) => readOpenCircuit(pluginDataDir, provider, pool, nowMs)).filter(Boolean)
	);
	if (openCircuits.length === pools.length) {
		return Object.freeze({
			kind: "circuit-open",
			binaryPath,
			reopenAt: Math.min(...openCircuits.map((circuit) => circuit.reopenAt)),
			reason: openCircuits[0].reason,
			openCircuits,
		});
	}
	return Object.freeze({ kind: "healthy", binaryPath, openCircuits });
}

export function detectProviderHealth(env = {}, nowMs = Date.now()) {
	return Object.freeze({
		"claude-native": Object.freeze({
			kind: "healthy",
			binaryPath: resolveExecutableInPath("claude") || "/usr/bin/claude",
		}),
		agy: healthOf("agy", env.agyBinOverride || process.env.CLAUGLE_AGY_BIN || "agy", env.pluginDataDir, nowMs),
		"gemini-cli": healthOf(
			"gemini-cli",
			env.geminiBinOverride || process.env.CLAUGLE_GEMINI_BIN || "gemini",
			env.pluginDataDir,
			nowMs
		),
	});
}

function isWithin(target, dir) {
	const rel = path.relative(dir, target);
	return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

// Three layers bind a delegated run: the agent's tool list (writeAgyAgent), the PreToolUse gate
// (writeAgyToolGate) and these deny rules. agy ignores `--mode plan` once slash commands are
// disabled, and it accepts only the actions command, read_file, write_file, read_url, mcp,
// execute_url and unsandboxed here; it logs and skips any other entry. `<action>(*)` matches every
// target and a path rule matches everything under it.
const AGY_ALWAYS_DENIED = Object.freeze(["command(*)", "mcp(*)", "read_url(*)", "execute_url(*)", "unsandboxed(*)"]);

// Headless agy refuses any write it would have to ask about, but it writes to the temp dir without
// asking, and the host repo is the one place where a direct write would skip the glob check. A
// wildcard deny cannot be narrowed by an allow rule.
function agyDeniedPermissions(mode, cwd, hostRepoRoot) {
	if (mode === "plan") {
		return [...AGY_ALWAYS_DENIED, "write_file(*)"];
	}
	const outsideWorktree = [...new Set(["/tmp", os.tmpdir(), ...(hostRepoRoot ? [hostRepoRoot] : [])])].filter(
		(dir) => !isWithin(cwd, dir)
	);
	return [...AGY_ALWAYS_DENIED, ...outsideWorktree.map((dir) => `write_file(${dir})`)];
}

const AGY_TOOL_GATE_SOURCE = `const fs = require("node:fs");
const path = require("node:path");
const CONFIG = __CONFIG__;
const READ_TOOLS = new Set(["read_file", "view_file", "list_dir", "grep_search", "find_by_name", "search_in_file", "view_code_item", "view_file_outline"]);
const WRITE_TOOLS = new Set(["write_file", "edit_file", "write_to_file", "replace_file_content", "multi_replace_file_content"]);
const PATH_KEY = /(path|file|dir|directory)$/i;
function resolveReal(target) {
	if (typeof target !== "string" || !path.isAbsolute(target)) return null;
	let probe = path.resolve(target);
	const rest = [];
	for (;;) {
		try {
			probe = fs.realpathSync(probe);
			break;
		} catch {
			if (fs.lstatSync(probe, { throwIfNoEntry: false })) return null;
			const parent = path.dirname(probe);
			if (parent === probe) return null;
			rest.unshift(path.basename(probe));
			probe = parent;
		}
	}
	return path.join(probe, ...rest);
}
function allowedPath(target, roots, forbiddenNames) {
	if (target.split(/[\\/]/).includes("..")) return false;
	const resolved = resolveReal(target);
	if (!resolved) return false;
	const root = roots.find((r) => resolved === r || resolved.startsWith(r + path.sep));
	if (!root) return false;
	return !path.relative(root, resolved).split(path.sep).some((name) => forbiddenNames.includes(name));
}
function allowedTargets(args, roots, forbiddenNames) {
	try {
		const targets = Object.entries(args || {})
			.filter(([key, value]) => PATH_KEY.test(key) && typeof value === "string")
			.map(([, value]) => value);
		return targets.length > 0 && targets.every((target) => allowedPath(target, roots, forbiddenNames));
	} catch {
		return false;
	}
}
let raw = "";
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
	let call = {};
	try {
		call = JSON.parse(raw).toolCall || {};
	} catch {}
	const name = typeof call.name === "string" ? call.name : "";
	const allowed =
		name === "finish" ||
		(READ_TOOLS.has(name) && allowedTargets(call.args, CONFIG.readRoots.concat(CONFIG.writeRoots), [".git"])) ||
		(WRITE_TOOLS.has(name) && allowedTargets(call.args, CONFIG.writeRoots, CONFIG.harnessConfigNames));
	process.stdout.write(JSON.stringify(allowed ? { decision: "allow" } : { decision: "deny", reason: CONFIG.denyReason }));
});
`;

function writeFileIfChanged(filePath, content) {
	try {
		if (fs.readFileSync(filePath, "utf8") === content) return;
	} catch {}
	const tmpPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
	fs.writeFileSync(tmpPath, content, "utf8");
	fs.renameSync(tmpPath, filePath);
}

// agy loads PreToolUse hooks from the .agents folder of every workspace root.
export function writeAgyToolGate(dir, { readRoots = [], writeRoots = [], denyReason }) {
	const agentsDir = path.join(dir, ".agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	const config = {
		readRoots: readRoots.map((root) => fs.realpathSync(root)),
		writeRoots: writeRoots.map((root) => fs.realpathSync(root)),
		harnessConfigNames: HARNESS_CONFIG_NAMES,
		denyReason,
	};
	writeFileIfChanged(path.join(agentsDir, "tool-gate.cjs"), AGY_TOOL_GATE_SOURCE.replace("__CONFIG__", () => JSON.stringify(config)));
	const hooks = {
		"claugle-tool-gate": {
			PreToolUse: [
				{ matcher: "*", hooks: [{ type: "command", command: `${JSON.stringify(process.execPath)} tool-gate.cjs`, timeout: 5 }] },
			],
		},
	};
	writeFileIfChanged(path.join(agentsDir, "hooks.json"), `${JSON.stringify(hooks, null, 2)}\n`);
	return dir;
}

// agy walks up from each workspace root to the top of its git repo and loads every agy
// customization folder on the way. A folder that is its own repo stops that walk; an empty .git
// folder does not, so this runs a real `git init`.
export function ensureOwnGitRepo(dir) {
	const real = fs.realpathSync(dir);
	const isTop = () => {
		try {
			return execFileSync("git", ["-C", real, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === real;
		} catch {
			return false;
		}
	};
	if (isTop()) return;
	try {
		execFileSync("git", ["init", "-q", real], { stdio: "ignore" });
	} catch {}
	if (!isTop()) {
		throw new Error(`claugle could not make ${real} its own git repository, so agy would load agy customizations from the folders above it. agy was not started.`);
	}
}

// agy reads rules, skills, plugins, agents, workflows, sidecars, hooks and MCP servers from many
// places under ~/.gemini (GEMINI.md and AGENTS.md, config/, antigravity-cli/hooks.json). So agy runs
// in a home that holds only the login token, linked so that agy's token refreshes reach the real
// home; agy creates the rest of its state there itself. Without config/.migrated agy migrates
// antigravity-cli/hooks.json on start.
const AGY_HOME_LINKS = Object.freeze([".gemini/antigravity-cli/antigravity-oauth-token"]);
const AGY_HOME_FILES = Object.freeze([".gemini/config/.migrated"]);

function removeLinksExcept(dir, keep) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isSymbolicLink()) {
			if (!keep.has(full)) fs.rmSync(full, { force: true });
		} else if (entry.isDirectory()) {
			removeLinksExcept(full, keep);
		}
	}
}

export function prepareAgyHome(pluginDataDir, realHome = os.homedir()) {
	const home = path.join(pluginDataDir, "agy-home");
	fs.mkdirSync(home, { recursive: true });
	const links = AGY_HOME_LINKS.map((rel) => ({ link: path.join(home, rel), target: path.join(realHome, rel) }));
	const isLinked = ({ link, target }) => {
		try {
			return fs.readlinkSync(link) === target;
		} catch {
			return false;
		}
	};
	removeLinksExcept(home, new Set(links.filter(isLinked).map(({ link }) => link)));
	for (const { link, target } of links.filter((entry) => !isLinked(entry))) {
		fs.mkdirSync(path.dirname(link), { recursive: true });
		fs.rmSync(link, { recursive: true, force: true });
		try {
			fs.symlinkSync(target, link);
		} catch (err) {
			if (err?.code !== "EEXIST") throw err;
		}
	}
	for (const rel of AGY_HOME_FILES) {
		fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
		fs.closeSync(fs.openSync(path.join(home, rel), "a"));
	}
	return home;
}

// claugle runs agy as a custom agent whose prompt is one line and whose tools are only what the path
// needs: the gateway needs finish to return its structured answer, delegated runs need file tools.
// A custom agent otherwise inherits agy's default prompt sections and every rule, skill, agent and
// plugin agy finds, global or the project's own AGENTS.md and GEMINI.md. excludeDefaultComponents
// and the empty lists keep all of them out of the model's context while agy still runs the
// PreToolUse gate, so Claude Code's harness, carried in the prompt, is the only rule set. The gate
// folder is a second workspace root, so a delegated agent is told which root is the project;
// otherwise the model starts in the gate folder.
const AGY_READ_TOOLS = Object.freeze(["view_file", "list_dir", "grep_search", "find_by_name"]);
const AGY_AGENT_PROFILES = Object.freeze({
	"claugle-gateway": {
		tools: ["finish"],
		instructions: () => "Answer the request in the transcript. Claude Code runs every tool; ask for tools only through the response schema.",
	},
	"claugle-reader": {
		tools: AGY_READ_TOOLS,
		instructions: (projectDir) =>
			`The project folder is ${projectDir}. Read the files you need there and answer. You cannot change files, run commands or use any other tool.`,
	},
	"claugle-editor": {
		tools: [...AGY_READ_TOOLS, "write_to_file", "replace_file_content", "multi_replace_file_content"],
		instructions: (projectDir) =>
			`The project folder is ${projectDir}. Read and edit files only there. Make the requested change directly: list folders only to find a file the request does not name, and do not reread a file you just wrote. You cannot run commands or use any other tool.`,
	},
});
const AGY_AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function writeAgyAgent(dir, name, projectDir) {
	const profile = AGY_AGENT_PROFILES[name];
	if (!profile) throw new Error(`Unknown claugle agy agent: ${name}`);
	const agentDir = path.join(dir, ".agents", "agents", name);
	fs.mkdirSync(agentDir, { recursive: true });
	const body = [
		"---",
		`name: ${name}`,
		"description: claugle worker",
		"mainAgent: true",
		"excludeDefaultComponents: true",
		"skills: []",
		"rules: []",
		"agents: []",
		"plugins: []",
		"tools:",
		...profile.tools.map((tool) => `  - ${tool}`),
		"---",
		"",
		`# ${name}`,
		"",
		profile.instructions(projectDir),
		"",
	].join("\n");
	writeFileIfChanged(path.join(agentDir, "agent.md"), body);
	return name;
}

export function buildAgyCliArgs(invocation) {
	if (!invocation || typeof invocation.prompt !== "string" || invocation.prompt.trim().length === 0) {
		throw new Error("AgyCliInvocation requires a non-empty prompt.");
	}
	const mode = invocation.mode ?? "plan";
	const resolved = resolveModelAndEffort(
		invocation.modelSlug,
		invocation.effort,
		{ preferExplicitEffort: Boolean(invocation.effort) }
	);
	const effectiveModelSlug = resolved?.modelSlug ?? invocation.modelSlug;
	const effectiveEffort =
		resolved?.effort ??
		MODEL_CAPABILITIES[effectiveModelSlug]?.defaultEffort ??
		invocation.effort ??
		"high";
	const args = [
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--model",
		effectiveModelSlug,
		"--effort",
		effectiveEffort,
		"--disable-slash-commands",
		"--mode",
		mode,
		"--settings",
		JSON.stringify({
			permissions: {
				deny: agyDeniedPermissions(mode, path.resolve(invocation.cwd ?? process.cwd()), invocation.hostRepoRoot),
			},
		}),
	];
	if (invocation.jsonSchema) {
		const serializedSchema =
			typeof invocation.jsonSchema === "string"
				? invocation.jsonSchema
				: JSON.stringify(invocation.jsonSchema);
		args.push("--json-schema", serializedSchema);
	}
	if (Array.isArray(invocation.addDirs)) {
		for (const dir of invocation.addDirs) {
			if (typeof dir === "string" && dir.length > 0) {
				args.push("--add-dir", dir);
			}
		}
	}
	if (invocation.agent !== undefined) {
		if (!AGY_AGENT_NAME.test(String(invocation.agent))) {
			throw new Error(`Invalid agy agent name: ${JSON.stringify(invocation.agent)}`);
		}
		args.push("--agent", invocation.agent);
	}
	if (Number(invocation.timeoutMs) > 0) {
		args.push("--print-timeout", `${Math.max(1, Math.ceil(Number(invocation.timeoutMs) / 1000))}s`);
	}
	args.push("-p=");
	return Object.freeze(args);
}

function encodeAgyStreamInput(prompt) {
	return `${JSON.stringify({ event: "user", message: { content: prompt } })}\n`;
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

function providerFailureText(stdout, stderr) {
	const parts = [stderr];
	const collectErrors = (event) => {
		const step = event?.step_update;
		for (const err of [event?.error, event?.result?.error, step?.step_type === "tool" ? undefined : step?.error]) {
			if (typeof err === "string") parts.push(err);
			else if (err && typeof err === "object") parts.push(JSON.stringify(err));
		}
	};
	try {
		collectErrors(JSON.parse(stdout));
		return parts.join("\n");
	} catch {}
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			collectErrors(JSON.parse(trimmed));
		} catch {
			parts.push(trimmed);
		}
	}
	return parts.join("\n");
}

function classifyProviderFailure(failureText) {
	const text = String(failureText || "");
	if (
		/quota[_\s-]*exhausted|exhausted\s+your\s+quota|quota\s+reached|resource_exhausted|weekly\s+limit|5-hour\s+limit|session\s+limit|hit\s+your.*limit|insufficient_quota|exceeded.*quota/i.test(
			text
		)
	) {
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

const KILL_GRACE_MS = 1_000;
const EXIT_DRAIN_MS = 250;

const liveProcessGroups = new Set();
const TERMINATING_SIGNALS = Object.freeze(["SIGINT", "SIGTERM", "SIGHUP"]);

function killLiveProcessGroups() {
	for (const pid of liveProcessGroups) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {}
	}
}

function forwardTerminatingSignal(signal) {
	killLiveProcessGroups();
	for (const sig of TERMINATING_SIGNALS) process.removeListener(sig, forwardTerminatingSignal);
	process.removeListener("exit", killLiveProcessGroups);
	process.kill(process.pid, signal);
}

// agy runs in its own process group so a timeout can kill everything it started, which also
// means a signal to the caller no longer reaches it. While any group is alive the caller passes
// its own termination on, and agy's --print-timeout covers a caller killed with SIGKILL.
function trackProcessGroup(pid) {
	if (liveProcessGroups.size === 0) {
		process.on("exit", killLiveProcessGroups);
		for (const sig of TERMINATING_SIGNALS) process.on(sig, forwardTerminatingSignal);
	}
	liveProcessGroups.add(pid);
}

function untrackProcessGroup(pid) {
	if (!liveProcessGroups.delete(pid) || liveProcessGroups.size > 0) return;
	process.removeListener("exit", killLiveProcessGroups);
	for (const sig of TERMINATING_SIGNALS) process.removeListener(sig, forwardTerminatingSignal);
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
					hostRepoRoot: params.hostRepoRoot,
					agent: params.agent,
					addDirs: params.addDirs,
					jsonSchema: params.jsonSchema,
					timeoutMs,
				});

	const startedAt = Date.now();

	if (params.signal?.aborted) {
		return Promise.resolve(
			Object.freeze({ kind: "failure", reason: "CANCELLED", message: `${provider} run was cancelled before it started.`, exitCode: null, durationMs: 0 })
		);
	}

	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let exitCode = null;
		let spawnError = null;
		let timedOut = false;
		let cancelled = false;
		let settled = false;
		const timers = [];

		let child;
		try {
			// Detached, agy and everything it starts form one process group that the runner can kill.
			child = spawn(binaryPath, args, {
				cwd,
				env: {
					...process.env,
					CLAUGLE_HEADLESS_SUBPROCESS: "1",
					...(provider === "agy" && params.agyHome ? { HOME: params.agyHome } : {}),
				},
				stdio: [provider === "gemini-cli" ? "ignore" : "pipe", "pipe", "pipe"],
				detached: true,
			});
		} catch (err) {
			resolve(
				Object.freeze({
					kind: "failure",
					reason: "NON_ZERO_EXIT",
					message: `Failed to spawn ${binaryPath}: ${errorMessage(err)}`,
					exitCode: null,
					durationMs: Math.max(0, Date.now() - startedAt),
				})
			);
			return;
		}

		const killGroup = (signal) => {
			try {
				process.kill(-child.pid, signal);
			} catch {}
		};
		if (child.pid) trackProcessGroup(child.pid);

		const outcome = () => {
			if (spawnError) {
				return {
					kind: "failure",
					reason: "NON_ZERO_EXIT",
					message: `Failed to spawn ${binaryPath}: ${spawnError.message}`,
					exitCode: null,
				};
			}
			if (cancelled) {
				return { kind: "failure", reason: "CANCELLED", message: `${provider} run was cancelled by its caller.`, exitCode };
			}
			if (timedOut) {
				return { kind: "failure", reason: "TIMEOUT", message: `${provider} timed out after ${timeoutMs}ms.`, exitCode };
			}
			if (exitCode !== 0) {
				const combined = `${stderr}\n${stdout}`.trim();
				return {
					kind: "failure",
					reason: classifyProviderFailure(providerFailureText(stdout, stderr)),
					message: combined || `${provider} exited with status ${exitCode}.`,
					exitCode,
				};
			}
			const parsed = provider === "gemini-cli" ? parseGeminiCliOutputJson(stdout) : parseAgyOutputJson(stdout);
			if (parsed.kind === "error") {
				const maybeQuota = classifyProviderFailure(providerFailureText(stdout, stderr));
				return {
					kind: "failure",
					reason:
						parsed.finishedReason === "print_timeout"
							? "TIMEOUT"
							: maybeQuota !== "NON_ZERO_EXIT"
								? maybeQuota
								: "MALFORMED_JSON",
					message: parsed.message,
					exitCode,
				};
			}
			return { kind: "success", payload: parsed.value, stderr: stderr.trim() };
		};

		const settle = () => {
			if (settled) return;
			settled = true;
			for (const timer of timers) clearTimeout(timer);
			if (child.pid) untrackProcessGroup(child.pid);
			params.signal?.removeEventListener("abort", onAbort);
			child.stdout.destroy();
			child.stderr.destroy();
			resolve(Object.freeze({ ...outcome(), durationMs: Math.max(0, Date.now() - startedAt) }));
		};

		if (child.stdin) {
			child.stdin.on("error", () => {});
			child.stdin.end(encodeAgyStreamInput(params.prompt));
		}
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});

		function onAbort() {
			if (settled) return;
			cancelled = true;
			killGroup("SIGTERM");
			timers.push(
				setTimeout(() => {
					killGroup("SIGKILL");
					settle();
				}, KILL_GRACE_MS)
			);
		}
		params.signal?.addEventListener("abort", onAbort, { once: true });

		timers.push(
			setTimeout(() => {
				timedOut = true;
				killGroup("SIGTERM");
				timers.push(
					setTimeout(() => {
						killGroup("SIGKILL");
						settle();
					}, KILL_GRACE_MS)
				);
			}, timeoutMs)
		);

		child.on("error", (err) => {
			spawnError = err;
			settle();
		});
		child.on("exit", (code) => {
			if (settled) return;
			exitCode = code;
			timers.push(
				setTimeout(() => {
					killGroup("SIGKILL");
					settle();
				}, EXIT_DRAIN_MS)
			);
		});
		child.on("close", settle);
	});
}

function errorMessage(err) {
	return err instanceof Error ? err.message : String(err);
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
		try {
			const real = fs.realpathSync(path.resolve(request.cwd, relOrAbs));
			if (!isWithin(real, fs.realpathSync(request.cwd))) {
				sections.push(`- ${relOrAbs} (not read: outside the task directory)`);
				continue;
			}
			const stat = fs.statSync(real);
			if (stat.isFile() && stat.size <= 128 * 1024) {
				const content = fs.readFileSync(real, "utf8");
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

// agy runs commands from a workspace's customization folders: hooks.json files (plugin hooks
// included), MCP server configs, and plugins found in place or registered in plugins.json. The
// PreToolUse gate never sees those commands, so agy must not start in a workspace that has any of them.
function findAgyCommandCustomization(workspaceDir) {
	let top = path.parse(path.resolve(workspaceDir)).root;
	try {
		top =
			execFileSync("git", ["-C", workspaceDir, "rev-parse", "--show-toplevel"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim() || top;
	} catch {}
	const commandRunning = (dir) => {
		const pending = [dir];
		while (pending.length > 0) {
			const current = pending.pop();
			let entries = [];
			try {
				entries = fs.readdirSync(current, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				const full = path.join(current, entry.name);
				// A symlink could lead anywhere agy follows it, so it counts as a customization too.
				if (entry.isSymbolicLink() || ["hooks.json", "mcp_config.json", "plugins", "plugins.json"].includes(entry.name)) {
					return full;
				}
				if (entry.isDirectory()) pending.push(full);
			}
		}
		return null;
	};
	for (let dir = path.resolve(workspaceDir); ; dir = path.dirname(dir)) {
		for (const name of AGY_WORKSPACE_DIRS) {
			const customDir = path.join(dir, name);
			const found = fs.lstatSync(customDir, { throwIfNoEntry: false })?.isSymbolicLink() ? customDir : commandRunning(customDir);
			if (found) return found;
		}
		if (dir === path.resolve(top) || dir === path.dirname(dir)) return null;
	}
}

export async function executeRoutedTask(params) {
	const rawEnv = params.env?.pluginDataDir ? { kind: "ok", value: params.env } : parsePluginEnv(params.env);
	if (rawEnv.kind === "error") {
		throw new Error(rawEnv.message);
	}
	const env = rawEnv.value;

	const rawReq = isSafeTaskId(params.request?.taskId) && params.request?.cwd
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
	const outcome = (status, selectedTarget, responseText, extra = {}) =>
		Object.freeze({
			taskId: request.taskId,
			status,
			selectedTarget,
			attemptedTargets: Object.freeze([...attemptedTargets]),
			plan,
			responseText,
			...extra,
		});

	for (const candidate of plan.candidates) {
		if (candidate.provider === "claude-native") {
			continue;
		}
		attemptedTargets.push(candidate);

		if (candidate.provider === "gemini-cli") {
			errors.push(`${candidate.modelSlug}: gemini-cli is not run because claugle cannot gate its tools.`);
			continue;
		}

		const providerHealth = health[candidate.provider];
		if (!providerHealth || providerHealth.kind !== "healthy") {
			errors.push(`${candidate.provider} is not healthy (${providerHealth?.kind ?? "unknown"}).`);
			continue;
		}
		const openCircuit = providerHealth.openCircuits?.find((circuit) => circuit.quotaPool === candidate.quotaPool);
		if (openCircuit) {
			errors.push(
				`${candidate.modelSlug}: ${candidate.quotaPool} is paused after ${openCircuit.reason} until ${new Date(openCircuit.reopenAt).toISOString()}.`
			);
			continue;
		}

		let lease = null;
		const useWorktree = candidate.isolation.kind === "git-worktree" && isGitRepository(request.cwd);

		if (useWorktree) {
			try {
				lease = acquireWorktreeLease({
					taskId: `${request.taskId}-${attemptedTargets.length}`,
					hostRepoRoot: request.cwd,
					pluginDataDir: env.pluginDataDir,
					allowedGlobs: request.allowedEditGlobs,
					applyStrategy: request.applyStrategy,
					nowMs,
				});
			} catch (err) {
				errors.push(`${candidate.modelSlug}: ${errorMessage(err)}`);
				continue;
			}
		}

		if (candidate.agyMode !== "plan" && !lease) {
			errors.push(
				`${candidate.modelSlug}: refused to let agy edit files outside a git worktree (${request.cwd} is not a git repository).`
			);
			continue;
		}

		const projectDir = lease ? lease.executionCwd : request.cwd;
		const customization = findAgyCommandCustomization(projectDir);
		if (customization) {
			if (lease) abortWorktreeLease(lease);
			errors.push(
				`${candidate.modelSlug}: ${customization} would make agy run commands outside Claude Code's harness, so claugle does not start agy here.`
			);
			continue;
		}
		const gateDir = path.join(env.pluginDataDir, "agy-gates", `${request.taskId}-${attemptedTargets.length}`);
		writeAgyToolGate(gateDir, {
			readRoots: [projectDir],
			writeRoots: lease ? [projectDir] : [],
			denyReason: lease
				? `claugle: only file reads and writes under ${projectDir} are allowed, never in ${HARNESS_CONFIG_NAMES.join(", ")}. Use paths under ${projectDir}.`
				: `claugle: only file reads under ${projectDir} are allowed. This task cannot change files, run commands or use other tools.`,
		});
		const agyAgent = writeAgyAgent(gateDir, lease ? "claugle-editor" : "claugle-reader", projectDir);
		let execResult;
		try {
			execResult = await runHeadlessProvider({
				provider: candidate.provider,
				binaryPath: providerHealth.binaryPath,
				prompt: fullPrompt,
				modelSlug: candidate.modelSlug,
				effort: candidate.effort,
				mode: candidate.agyMode,
				cwd: projectDir,
				addDirs: [gateDir],
				agyHome: prepareAgyHome(env.pluginDataDir),
				agent: agyAgent,
				hostRepoRoot: lease?.hostRepoRoot,
				timeoutMs: candidate.timeoutMs,
			});
		} finally {
			fs.rmSync(gateDir, { recursive: true, force: true });
		}

		const recordRunUsage = (status) =>
			appendUsageEvent({
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
					status,
				},
			});

		// Headless agy ends a turn it could only finish by asking (a write outside the workspace, say)
		// with exit 0 and an empty response.
		const stoppedEarly =
			execResult.kind === "success" &&
			!execResult.payload.response.trim() &&
			!execResult.payload.structuredOutput;

		if (execResult.kind === "success" && !stoppedEarly) {
			let worktreeOutcome;
			if (lease) {
				try {
					worktreeOutcome = harvestAndReleaseWorktree(lease);
				} catch (err) {
					worktreeOutcome = Object.freeze({ kind: "harvest-failed", message: errorMessage(err), worktreeCleanedUp: true });
				}
			}

			const ledgerEvent = recordRunUsage("SUCCESS").event;

			if (worktreeOutcome?.kind === "rejected-nested-git") {
				return outcome(
					"FAILED",
					candidate,
					`Rejected agy's edits because they contain nested git repositories: ${worktreeOutcome.nestedGitPaths.join(", ")}`,
					{ worktreeOutcome, ledgerEvent }
				);
			}
			if (worktreeOutcome?.kind === "rejected-glob-violation") {
				return outcome(
					"FAILED",
					candidate,
					`Rejected file edits outside allowed globs: ${worktreeOutcome.violatingFiles.join(", ")}`,
					{ worktreeOutcome, ledgerEvent }
				);
			}
			if (worktreeOutcome?.kind === "harvest-failed") {
				return outcome("FAILED", candidate, `claugle could not collect agy's edits: ${worktreeOutcome.message}`, {
					worktreeOutcome,
					ledgerEvent,
				});
			}
			const notApplied =
				worktreeOutcome?.kind === "preserved-on-branch"
					? `\n\n[claugle] These edits were not applied to your working tree (${worktreeOutcome.reason}). They are preserved on branch ${worktreeOutcome.branchName}.`
					: "";
			const substituted =
				request.preferredModel && candidate.modelSlug !== request.preferredModel
					? `[claugle] ${request.preferredModel} did not answer, so ${candidate.modelSlug} answered instead. ${errors.join(" | ")}\n\n`
					: "";
			return outcome("COMPLETED", candidate, `${substituted}${execResult.payload.response}${notApplied}`, {
				...(worktreeOutcome ? { worktreeOutcome } : {}),
				ledgerEvent,
			});
		}

		if (lease) {
			abortWorktreeLease(lease);
		}

		if (stoppedEarly) {
			recordRunUsage("ERROR");
			errors.push(
				`${candidate.provider}:${candidate.modelSlug} stopped without a response: ${execResult.stderr || "empty response."}`
			);
			continue;
		}

		errors.push(
			`${candidate.provider}:${candidate.modelSlug} failed (${execResult.reason}): ${execResult.message}`
		);

		if (execResult.reason === "QUOTA_EXHAUSTED" || execResult.reason === "RATE_LIMITED") {
			recordCircuitBreakerOpen({
				pluginDataDir: env.pluginDataDir,
				provider: candidate.provider,
				quotaPool: candidate.quotaPool,
				binaryPath: providerHealth.binaryPath,
				reason: execResult.reason,
				nowMs,
				cooldownMs: thresholds.circuitBreakerCooldownMs,
			});
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
					status: execResult.reason === "QUOTA_EXHAUSTED" ? "QUOTA_EXHAUSTED" : "ERROR",
				},
			});
		}
	}

	const hostCandidate = plan.candidates.find((candidate) => candidate.provider === "claude-native");
	if (hostCandidate) {
		attemptedTargets.push(hostCandidate);
		const failures = errors.length > 0 ? ` External candidates failed: ${errors.join(" | ")}` : "";
		return outcome(
			"DELEGATE_TO_HOST",
			hostCandidate,
			`[claugle] Delegated to host Claude Code session (${hostCandidate.effort} effort). ` +
				`QuotaState=${plan.quotaState}, TaskKind=${plan.classification.taskKind}.${failures}`
		);
	}

	return outcome(
		"FAILED",
		attemptedTargets[attemptedTargets.length - 1] ?? plan.candidates[0],
		`All routed candidates failed. Errors: ${errors.join(" | ")}`
	);
}

const BUDGET_ENV_BY_POOL = Object.freeze({
	"claude-code-native": "CLAUGLE_CLAUDE_WEEKLY_TOKEN_BUDGET",
	"agy-claude-pool": "CLAUGLE_AGY_CLAUDE_WEEKLY_TOKEN_BUDGET",
	"agy-gemini-pool": "CLAUGLE_AGY_GEMINI_WEEKLY_TOKEN_BUDGET",
	"gemini-cli-pool": "CLAUGLE_GEMINI_CLI_WEEKLY_TOKEN_BUDGET",
});

// Bash commands launched by slash commands and agents get neither CLAUDE_PLUGIN_DATA nor the
// CLAUDE_PLUGIN_OPTION_* values, so they would read another ledger with default budgets.
function persistPluginDataEnvVar(envFile, pluginDataDir, weeklyBudgets = {}) {
	if (!envFile) return false;
	const parentDir = path.dirname(envFile);
	if (!fs.existsSync(parentDir)) return false;
	const existing = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
	const exports = [["CLAUDE_PLUGIN_DATA", pluginDataDir]];
	for (const [pool, name] of Object.entries(BUDGET_ENV_BY_POOL)) {
		if (Number.isInteger(weeklyBudgets[pool])) exports.push([name, String(weeklyBudgets[pool])]);
	}
	const lines = exports
		.filter(([name]) => !new RegExp(`(^|\\n)export ${name}=`).test(existing))
		.map(([name, value]) => `export ${name}=${JSON.stringify(value)}`);
	if (lines.length > 0) {
		const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
		fs.appendFileSync(envFile, `${prefix}${lines.join("\n")}\n`, "utf8");
	}
	return true;
}

const TRANSCRIPT_READ_BUDGET_BYTES = 32 * 1024 * 1024;

function readRange(fd, start, end) {
	const buffer = Buffer.alloc(end - start);
	let filled = 0;
	while (filled < buffer.length) {
		const count = fs.readSync(fd, buffer, filled, buffer.length - filled, start + filled);
		if (count === 0) break;
		filled += count;
	}
	return buffer.subarray(0, filled);
}

function readCompleteLines(fd, start, size) {
	let end = Math.min(size, start + TRANSCRIPT_READ_BUDGET_BYTES);
	let buffer = readRange(fd, start, end);
	while (buffer.lastIndexOf(0x0a) < 0 && end < size) {
		const next = Math.min(size, end + TRANSCRIPT_READ_BUDGET_BYTES);
		buffer = Buffer.concat([buffer, readRange(fd, end, next)]);
		end = next;
	}
	return buffer.subarray(0, buffer.lastIndexOf(0x0a) + 1);
}

// Claude Code writes each subagent's transcript beside the session transcript. Both spend the same quota.
function sessionTranscripts(transcriptPath) {
	const subagentDir = path.join(path.dirname(transcriptPath), path.basename(transcriptPath, ".jsonl"), "subagents");
	let names = [];
	try {
		names = fs.readdirSync(subagentDir).filter((name) => name.endsWith(".jsonl"));
	} catch {}
	return [transcriptPath, ...names.map((name) => path.join(subagentDir, name))];
}

function recordTranscriptUsage({ pluginDataDir, transcriptPath, sessionId, nowMs }) {
	const cursorFile = path.join(
		pluginDataDir,
		"transcript-cursors",
		`${crypto.createHash("sha256").update(transcriptPath).digest("hex").slice(0, 32)}.json`
	);
	let cursor = {};
	try {
		cursor = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
	} catch {}

	let fd;
	try {
		fd = fs.openSync(transcriptPath, "r");
	} catch (err) {
		if (err?.code === "ENOENT") return;
		throw err;
	}
	try {
		const { size, ino } = fs.fstatSync(fd);
		const start = cursor.ino === ino && Number.isInteger(cursor.offset) && cursor.offset <= size ? cursor.offset : 0;
		const chunk = readCompleteLines(fd, start, size);
		const seen = new Set();
		for (const line of chunk.toString("utf8").split("\n")) {
			if (!line.includes('"assistant"')) continue;
			let entry;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			const message = entry?.message;
			const usage = message?.usage;
			if (entry?.type !== "assistant" || typeof message?.id !== "string" || !usage || seen.has(message.id)) continue;
			seen.add(message.id);
			if (entry.isApiErrorMessage === true && (entry.apiError === "usage_limit_reached" || entry.quotaLimits?.status === "rejected")) {
				const hitAt = Date.parse(entry.timestamp);
				appendUsageEvent({
					pluginDataDir,
					pid: "native",
					event: {
						eventId: `claude-native-limit-${message.id}`,
						sessionId,
						recordedAt: Number.isFinite(hitAt) ? hitAt : nowMs,
						provider: "claude-native",
						quotaPool: "claude-code-native",
						modelSlug: "claude-host",
						totalTokens: 0,
						status: "QUOTA_EXHAUSTED",
					},
				});
				continue;
			}
			if (message.model === "<synthetic>" || resolveModelAndEffort(message.model)) continue;
			const recordedAt = Date.parse(entry.timestamp);
			appendUsageEvent({
				pluginDataDir,
				pid: "native",
				event: {
					eventId: `claude-native-${message.id}`,
					sessionId,
					recordedAt: Number.isFinite(recordedAt) ? recordedAt : nowMs,
					provider: "claude-native",
					quotaPool: "claude-code-native",
					modelSlug: message.model,
					inputTokens: (Number(usage.input_tokens) || 0) + (Number(usage.cache_creation_input_tokens) || 0),
					outputTokens: Number(usage.output_tokens) || 0,
					cacheReadTokens: Number(usage.cache_read_input_tokens) || 0,
					status: "SUCCESS",
				},
			});
		}
		writeJsonAtomic(cursorFile, { offset: start + chunk.length, ino });
	} finally {
		fs.closeSync(fd);
	}
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
		persistPluginDataEnvVar(env.envFile, env.pluginDataDir, env.weeklyBudgets);

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

	if (eventName === "Stop") {
		const transcript = parseAbsolutePath(payload.transcript_path);
		if (transcript.kind === "error") {
			return { continue: true };
		}
		try {
			for (const transcriptPath of sessionTranscripts(transcript.value)) {
				recordTranscriptUsage({
					pluginDataDir: env.pluginDataDir,
					transcriptPath,
					sessionId: payload.session_id ?? env.sessionId,
					nowMs,
				});
			}
			return { continue: true };
		} catch (err) {
			return { continue: true, systemMessage: `[claugle] Could not record native Claude Code usage: ${errorMessage(err)}` };
		}
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
