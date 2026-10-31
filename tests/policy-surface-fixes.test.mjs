import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	appendUsageEvent,
	compactExpiredLedgerShards,
	loadRollingQuotaSnapshot,
} from "../plugins/claugle/scripts/ledger-store.mjs";
import { handleMcpJsonRpcRequest } from "../plugins/claugle/scripts/mcp-server.mjs";
import {
	AGY_EXECUTION_MODES,
	ALL_QUOTA_STATES,
	ALL_TASK_KINDS,
	parseTaskRequest,
	resolveRoutePlan,
} from "../plugins/claugle/scripts/policy-engine.mjs";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(REPO_ROOT, "plugins", "claugle");
const CLI = path.join(PLUGIN_ROOT, "scripts", "claugle.mjs");
const MCP_SERVER = path.join(PLUGIN_ROOT, "scripts", "mcp-server.mjs");
const LEDGER_MODULE = path.join(PLUGIN_ROOT, "scripts", "ledger-store.mjs");
const ORIGINAL_SRC = "export const x = 1;\n";
const EDITED_SRC = "export const x = 'edited by agy';\n";
const HEALTHY = Object.freeze({
	"claude-native": { kind: "healthy", binaryPath: "/usr/bin/claude" },
	agy: { kind: "healthy", binaryPath: "/usr/bin/agy" },
	"gemini-cli": { kind: "healthy", binaryPath: "/usr/bin/gemini" },
});

const tempDirs = [];
after(() => {
	for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `claugle-psf-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

function isolatedEnv(extra = {}) {
	const home = tmp("home");
	return {
		PATH: process.env.PATH,
		HOME: home,
		CLAUDE_PLUGIN_DATA: path.join(home, "data"),
		CLAUDE_PROJECT_DIR: home,
		CLAUGLE_CLAUDE_SETTINGS_PATH: path.join(home, "settings.json"),
		CLAUGLE_AGY_BIN: "/nonexistent/agy",
		CLAUGLE_GEMINI_BIN: "/nonexistent/gemini",
		...extra,
	};
}

function runCli(args, env, input = "") {
	return spawnSync(process.execPath, [CLI, ...args], { env, input, encoding: "utf8", cwd: env.HOME });
}

function makeRepo() {
	const repo = tmp("repo");
	const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
	git("init", "-q", "-b", "main");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "Test User");
	git("config", "commit.gpgsign", "false");
	fs.mkdirSync(path.join(repo, "src"));
	fs.mkdirSync(path.join(repo, "docs"));
	fs.writeFileSync(path.join(repo, "src", "index.js"), ORIGINAL_SRC);
	fs.writeFileSync(path.join(repo, "docs", "guide.md"), "# guide\n");
	git("add", "-A");
	git("commit", "-qm", "init");
	return repo;
}

function mockAgy() {
	const dir = tmp("agy");
	const log = path.join(dir, "calls.jsonl");
	const agyPath = path.join(dir, "agy");
	fs.writeFileSync(
		agyPath,
		`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
	let prompt = null;
	for (const line of input.split("\\n")) {
		try {
			const ev = JSON.parse(line);
			if (ev.event === "user") prompt = ev.message.content;
		} catch {}
	}
	const call = { model: flag("--model"), mode: flag("--mode"), prompt };
	fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(call) + "\\n");
	const target = path.join(process.cwd(), "src", "index.js");
	if (call.mode !== "plan" && fs.existsSync(target)) fs.writeFileSync(target, ${JSON.stringify(EDITED_SRC)});
	process.stdout.write(JSON.stringify({ response: "ok from " + call.model, usage: { total_tokens: 10 } }) + "\\n");
});
`,
		{ mode: 0o755 }
	);
	const calls = () =>
		fs.existsSync(log)
			? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
			: [];
	return { agyPath, calls };
}

function mcpEnv(repo, agyPath) {
	return {
		CLAUDE_PLUGIN_DATA: tmp("data"),
		CLAUDE_PROJECT_DIR: repo,
		CLAUGLE_AGY_BIN: agyPath,
		CLAUGLE_GEMINI_BIN: "/nonexistent/gemini",
	};
}

async function callTool(name, args, rawEnv) {
	const res = await handleMcpJsonRpcRequest(
		{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
		rawEnv
	);
	return res.result;
}

function readHostSrc(repo) {
	return fs.readFileSync(path.join(repo, "src", "index.js"), "utf8");
}

function recordAt(pluginDataDir, event) {
	appendUsageEvent({ pluginDataDir, event: { sessionId: "psf", ...event } });
}

describe("agy edits files only when the caller allows edits", () => {
	it("claugle_run with {prompt: 'refactor the parser'} leaves the host checkout untouched", async () => {
		const repo = makeRepo();
		const { agyPath, calls } = mockAgy();
		const rawEnv = mcpEnv(repo, agyPath);

		const denied = await callTool("claugle_run", { prompt: "refactor the parser" }, rawEnv);
		assert.equal(readHostSrc(repo), ORIGINAL_SRC, "host file must not change without allowFileEdits");
		assert.deepEqual(calls().map((c) => c.mode), ["plan"]);
		assert.equal(JSON.parse(denied.content[0].text).worktreeOutcome, undefined);

		const granted = await callTool("claugle_run", { prompt: "refactor the parser", allowFileEdits: true }, rawEnv);
		assert.equal(JSON.parse(granted.content[0].text).worktreeOutcome.kind, "applied-to-host");
		assert.equal(readHostSrc(repo), EDITED_SRC, "explicit allowFileEdits still edits through the worktree");
	});

	it("no route plan in any quota state picks an edit mode while allowFileEdits is false", () => {
		const prompts = [
			...ALL_TASK_KINDS.map((kind) => ({ prompt: "do the task", explicitTaskKind: kind })),
			{ prompt: "refactor the parser" },
			{ prompt: "Fix typo and rename constant in helper" },
			{ prompt: "update the README" },
		];
		for (const quotaState of ALL_QUOTA_STATES) {
			for (const raw of prompts) {
				const request = parseTaskRequest({ ...raw, cwd: "/tmp" }).value;
				const plan = resolveRoutePlan({ request, quotaState, metrics: { pools: {} }, health: HEALTHY });
				for (const target of plan.candidates.filter((c) => c.provider === "agy")) {
					assert.deepEqual(
						[target.agyMode, target.isolation.kind],
						["plan", "read-only"],
						`${quotaState} / ${raw.explicitTaskKind ?? raw.prompt} chose ${target.modelSlug} in ${target.agyMode}`
					);
				}
			}
		}
	});
});

describe("hysteresis survives between snapshot loads", () => {
	it("stays in CONSERVE_CLAUDE when host usage drops from 0.71 to 0.66 and leaves once it falls below 0.65", () => {
		const dataDir = tmp("p2");
		const t0 = 1_800_000_000_000;
		recordAt(dataDir, { eventId: "p2-a", provider: "claude-native", quotaPool: "claude-code-native", totalTokens: 250_000, recordedAt: t0 });
		recordAt(dataDir, { eventId: "p2-b", provider: "claude-native", quotaPool: "claude-code-native", totalTokens: 3_300_000, recordedAt: t0 + DAY });

		const entering = loadRollingQuotaSnapshot({ pluginDataDir: dataDir, nowMs: t0 + DAY + HOUR });
		assert.equal(entering.metrics.pools["claude-code-native"].consumedRatio, 0.71);
		assert.equal(entering.quotaState, "CONSERVE_CLAUDE");

		const insideBand = loadRollingQuotaSnapshot({ pluginDataDir: dataDir, nowMs: t0 + 7 * DAY + HOUR });
		assert.equal(insideBand.metrics.pools["claude-code-native"].consumedRatio, 0.66);
		assert.equal(insideBand.quotaState, "CONSERVE_CLAUDE", "0.66 is inside the [0.65, 0.70) band");

		const belowExit = loadRollingQuotaSnapshot({ pluginDataDir: dataDir, nowMs: t0 + 8 * DAY + 2 * HOUR });
		assert.equal(belowExit.metrics.pools["claude-code-native"].consumedRatio, 0);
		assert.equal(belowExit.quotaState, "NORMAL");
	});
});

describe("exhaustion signals drive and then release the governor", () => {
	const now = 1_800_000_000_000;
	const stateAfter = (pool, provider, ageMs) => {
		const dataDir = tmp("signal");
		recordAt(dataDir, {
			eventId: `hit-${pool}`,
			provider,
			quotaPool: pool,
			totalTokens: 0,
			status: "QUOTA_EXHAUSTED",
			recordedAt: now - ageMs,
		});
		return loadRollingQuotaSnapshot({ pluginDataDir: dataDir, nowMs: now }).quotaState;
	};

	it("enters FALLBACK_GEMINI_CLI only when every agy pool reported exhaustion within the last 5 hours", () => {
		assert.equal(stateAfter("agy-gemini-pool", "agy", HOUR), "NORMAL");
		assert.equal(stateAfter("agy-claude-pool", "agy", HOUR), "NORMAL");
		const dataDir = tmp("both-pools");
		for (const pool of ["agy-claude-pool", "agy-gemini-pool"]) {
			recordAt(dataDir, { eventId: `hit-${pool}`, provider: "agy", quotaPool: pool, totalTokens: 0, status: "QUOTA_EXHAUSTED", recordedAt: now - HOUR });
		}
		assert.equal(loadRollingQuotaSnapshot({ pluginDataDir: dataDir, nowMs: now }).quotaState, "FALLBACK_GEMINI_CLI");
		assert.equal(loadRollingQuotaSnapshot({ pluginDataDir: dataDir, nowMs: now + 4 * HOUR + 60_000 }).quotaState, "NORMAL");
	});

	it("skips the candidates of a pool that reported exhaustion within the last 5 hours", () => {
		const dataDir = tmp("one-pool");
		recordAt(dataDir, { eventId: "hit-claude", provider: "agy", quotaPool: "agy-claude-pool", totalTokens: 0, status: "QUOTA_EXHAUSTED", recordedAt: now - HOUR });
		const plan = (atMs) => {
			const snap = loadRollingQuotaSnapshot({ pluginDataDir: dataDir, nowMs: atMs });
			const req = parseTaskRequest({ prompt: "Review this diff for bugs", explicitTaskKind: "review", cwd: dataDir });
			return resolveRoutePlan({
				request: req.value,
				quotaState: snap.quotaState,
				metrics: snap.metrics,
				health: { agy: { kind: "healthy", binaryPath: "/x/agy" }, "gemini-cli": { kind: "unavailable" }, "claude-native": { kind: "healthy", binaryPath: "/x/claude" } },
			});
		};
		const during = plan(now);
		assert.ok(during.candidates.every((c) => c.quotaPool !== "agy-claude-pool"), JSON.stringify(during.candidates.map((c) => c.modelSlug)));
		assert.ok(during.skippedCandidates.some((s) => s.target.quotaPool === "agy-claude-pool" && s.skipReason === "POOL_EXHAUSTED"));
		assert.ok(plan(now + 4 * HOUR + 60_000).candidates.some((c) => c.quotaPool === "agy-claude-pool"));
	});

	it("enters OVERFLOW_TO_AGY on a recent host limit hit but not on one 6.5 days old", () => {
		assert.equal(stateAfter("claude-code-native", "claude-native", HOUR), "OVERFLOW_TO_AGY");
		assert.equal(stateAfter("claude-code-native", "claude-native", 5 * HOUR + 60_000), "NORMAL");
		assert.equal(stateAfter("claude-code-native", "claude-native", 6.5 * DAY), "NORMAL");
	});

	it("returns to NORMAL in the same data dir once the signal is older than 5 hours", () => {
		const dataDir = tmp("decay");
		recordAt(dataDir, { eventId: "hit", provider: "claude-native", quotaPool: "claude-code-native", totalTokens: 0, status: "QUOTA_EXHAUSTED", recordedAt: now });
		assert.equal(loadRollingQuotaSnapshot({ pluginDataDir: dataDir, nowMs: now + HOUR }).quotaState, "OVERFLOW_TO_AGY");
		assert.equal(loadRollingQuotaSnapshot({ pluginDataDir: dataDir, nowMs: now + 6 * HOUR }).quotaState, "NORMAL");
	});
});

describe("compaction never loses events from live shards", () => {
	it("keeps every fresh event while four processes append and compaction runs in a loop", async () => {
		const dataDir = tmp("p5");
		const writers = 4;
		const perWriter = 300;
		const writerScript = `
const { appendUsageEvent } = await import(${JSON.stringify(pathToFileURL(LEDGER_MODULE).href)});
const dataDir = process.argv[1];
for (let i = 0; i < ${perWriter}; i++) {
	appendUsageEvent({ pluginDataDir: dataDir, event: { eventId: "old-" + process.pid + "-" + i, recordedAt: Date.now() - 20 * 86400000, totalTokens: 1 } });
	appendUsageEvent({ pluginDataDir: dataDir, event: { eventId: "fresh-" + process.pid + "-" + i, recordedAt: Date.now(), totalTokens: 1 } });
	const until = Date.now() + 2;
	while (Date.now() < until) {}
}`;
		let running = writers;
		const exits = Array.from({ length: writers }, () => {
			const child = spawn(process.execPath, ["--input-type=module", "-e", writerScript, dataDir], { stdio: "inherit" });
			return new Promise((resolve) => child.on("exit", (code) => resolve(code)));
		});
		for (const exit of exits) exit.then(() => (running -= 1));
		while (running > 0) {
			compactExpiredLedgerShards({ pluginDataDir: dataDir });
			await new Promise((resolve) => setImmediate(resolve));
		}
		assert.deepEqual(await Promise.all(exits), Array(writers).fill(0));

		const ledgerDir = path.join(dataDir, "ledger");
		const fresh = new Set();
		for (const name of fs.readdirSync(ledgerDir).filter((n) => n.endsWith(".jsonl"))) {
			for (const line of fs.readFileSync(path.join(ledgerDir, name), "utf8").split("\n")) {
				if (line.trim() && JSON.parse(line).eventId.startsWith("fresh-")) fresh.add(JSON.parse(line).eventId);
			}
		}
		assert.equal(fresh.size, writers * perWriter);
	});
});

describe("context files stay inside the task cwd", () => {
	it("parseTaskRequest rejects absolute paths and paths that climb out of cwd", () => {
		const cwd = tmp("p6-project");
		for (const bad of ["../secret.txt", "/etc/passwd", "docs/../../secret.txt", ".."]) {
			const res = parseTaskRequest({ prompt: "x", cwd, contextFiles: [bad] });
			assert.equal(res.kind, "error", `${bad} must be rejected`);
		}
		for (const good of ["docs/guide.md", "./docs/guide.md", "docs/../README.md"]) {
			assert.equal(parseTaskRequest({ prompt: "x", cwd, contextFiles: [good] }).kind, "ok", `${good} must be accepted`);
		}
	});

	it("claugle_review never sends a file outside the project to agy", async () => {
		const repo = makeRepo();
		const secretDir = tmp("secret");
		const secretFile = path.join(secretDir, "secret.txt");
		fs.writeFileSync(secretFile, "TOP-SECRET-MARKER\n");
		const { agyPath, calls } = mockAgy();
		const rawEnv = mcpEnv(repo, agyPath);
		for (const contextFile of [path.relative(repo, secretFile), secretFile]) {
			const result = await callTool("claugle_review", { prompt: "review this code", contextFiles: [contextFile] }, rawEnv);
			assert.equal(result.isError, true, `${contextFile} must be refused`);
		}
		assert.ok(!JSON.stringify(calls()).includes("TOP-SECRET-MARKER"), "secret content reached agy");
	});
});

describe("hook setup runs only for the SessionStart event", () => {
	async function runHook(payload) {
		let probes = 0;
		const server = http.createServer((req, res) => {
			probes += 1;
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end("{}");
		});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const env = isolatedEnv({ CLAUGLE_GATEWAY_PORT: String(server.address().port) });
		const child = spawn(process.execPath, [CLI, "hook"], { env, stdio: ["pipe", "pipe", "pipe"] });
		child.stdin.end(JSON.stringify(payload));
		const code = await new Promise((resolve) => child.on("exit", resolve));
		server.close();
		return { code, probes, settingsWritten: fs.existsSync(env.CLAUGLE_CLAUDE_SETTINGS_PATH) };
	}

	it("a UserPromptSubmit that mentions SessionStart does not rewrite settings or touch the gateway", async () => {
		const out = await runHook({ hook_event_name: "UserPromptSubmit", prompt: "why does SessionStart fire twice?" });
		assert.deepEqual(out, { code: 0, probes: 0, settingsWritten: false });
	});

	it("a real SessionStart still syncs settings and checks the gateway", async () => {
		const out = await runHook({ hook_event_name: "SessionStart", source: "startup" });
		assert.equal(out.code, 0);
		assert.equal(out.settingsWritten, true);
		assert.ok(out.probes >= 1);
	});
});

describe("slash commands pass flags and prompt text intact", () => {
	function runSlashCommand(command, userText, env) {
		const body = fs.readFileSync(path.join(PLUGIN_ROOT, "commands", `${command}.md`), "utf8");
		const block = /```bash\n([\s\S]*?)```/.exec(body)[1];
		const script = block.replaceAll("${CLAUDE_PLUGIN_ROOT}", PLUGIN_ROOT).replaceAll("$ARGUMENTS", userText);
		return spawnSync("bash", ["-c", script], { env, cwd: env.CLAUDE_PROJECT_DIR, encoding: "utf8" });
	}

	function setup() {
		const repo = makeRepo();
		const { agyPath, calls } = mockAgy();
		const env = isolatedEnv({ CLAUDE_PROJECT_DIR: repo, CLAUGLE_AGY_BIN: agyPath });
		return { env, calls };
	}

	const cases = [
		["task", "fix the user's parser --allow-edits", { mode: "accept-edits", prompt: "fix the user's parser" }],
		["task", "-- explain what --json does", { mode: "plan", prompt: "explain what --json does" }],
		["write", "--model flash 문서 써줘", { model: "gemini-3.8-flash-high", mode: "plan", prompt: "문서 써줘" }],
		["write", "문서 써줘 --model flash", { model: "gemini-3.8-flash-high", mode: "plan", prompt: "문서 써줘" }],
		["review", "--model agy-sonnet fix the user's parser bug", { model: "claude-sonnet-5-5-high", mode: "plan", prompt: "fix the user's parser bug" }],
		["write", 'rename "foo" to "bar" in $HOME/notes and `date`', { mode: "plan", prompt: 'rename "foo" to "bar" in $HOME/notes and `date`' }],
	];
	for (const [command, userText, expected] of cases) {
		it(`/claugle:${command} ${userText}`, () => {
			const { env, calls } = setup();
			const result = runSlashCommand(command, userText, env);
			assert.equal(result.status, 0, result.stderr);
			const seen = calls().map((call) => Object.fromEntries(Object.keys(expected).map((key) => [key, call[key]])));
			assert.deepEqual(seen, [expected]);
		});
	}

	it("/claugle:explain summarize the parser design --kind docs --allow-edits", () => {
		const { env } = setup();
		const result = runSlashCommand("explain", "summarize the parser design --kind docs --allow-edits", env);
		assert.equal(result.status, 0, result.stderr);
		const plan = JSON.parse(result.stdout);
		assert.deepEqual([plan.classification.taskKind, plan.candidates[0].agyMode], ["docs", "accept-edits"]);
	});

	it("/claugle:model flash low", () => {
		const { env } = setup();
		const result = runSlashCommand("model", "flash low", env);
		assert.equal(result.status, 0, result.stderr);
		const synced = JSON.parse(result.stdout);
		assert.deepEqual([synced.activeModel, synced.activeEffort], ["gemini-3.8-flash", "low"]);
	});
});

describe("the MCP server stays silent on notifications", () => {
	it("answers a ping but not a notifications/progress message", async () => {
		const child = spawn(process.execPath, [MCP_SERVER], { env: isolatedEnv(), stdio: ["pipe", "pipe", "pipe"] });
		const lines = [];
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`no ping response: ${JSON.stringify(lines)}`)), 10_000);
			let buffer = "";
			child.stdout.on("data", (chunk) => {
				buffer += chunk;
				let nl;
				while ((nl = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, nl).trim();
					buffer = buffer.slice(nl + 1);
					if (!line) continue;
					const message = JSON.parse(line);
					lines.push(message);
					if (message.id === 7) {
						clearTimeout(timer);
						setTimeout(resolve, 300);
					}
				}
			});
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: 1, progress: 1 } })}\n`);
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/roots/list_changed" })}\n`);
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" })}\n`);
		});
		child.kill();
		assert.deepEqual(lines, [{ jsonrpc: "2.0", id: 7, result: {} }]);
	});
});

describe("every plugin setting does something", () => {
	const manifest = () => JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
	const observe = (extra) => {
		const env = isolatedEnv(extra);
		const quota = runCli(["quota"], env);
		const plan = runCli(["explain", "--kind", "docs", "--allow-edits", "update the guide"], env);
		return JSON.stringify([quota.status, quota.stdout, quota.stderr, plan.status, plan.stdout, plan.stderr]);
	};

	it("changing any userConfig option changes the quota report or the route plan", () => {
		const baseline = observe({});
		for (const [key, spec] of Object.entries(manifest().userConfig)) {
			const probe =
				spec.type === "number"
					? String(spec.default * 2)
					: (spec.options ?? AGY_EXECUTION_MODES).find((value) => value !== spec.default);
			const observed = observe({ [`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`]: probe });
			assert.notEqual(observed, baseline, `${key}=${probe} has no observable effect`);
		}
	});

	it("an unused default_agy_mode value cannot break every claugle command", () => {
		const result = runCli(["quota"], isolatedEnv({ CLAUDE_PLUGIN_OPTION_DEFAULT_AGY_MODE: "bogus" }));
		assert.equal(result.status, 0, result.stderr);
	});
});

describe("CLI and MCP boundaries", () => {
	it("allowFileEdits: 'false' from an MCP client does not turn edits on", async () => {
		const repo = makeRepo();
		const { agyPath, calls } = mockAgy();
		const result = await callTool(
			"claugle_write",
			{ prompt: "Update the guide", allowFileEdits: "false" },
			mcpEnv(repo, agyPath)
		);
		assert.equal(readHostSrc(repo), ORIGINAL_SRC, "host file edited although allowFileEdits was 'false'");
		assert.equal(result.isError, true);
		assert.deepEqual(calls(), []);
	});

	it("a string allowedEditGlobs is refused instead of widening edits to every file", async () => {
		const repo = makeRepo();
		const { agyPath, calls } = mockAgy();
		const result = await callTool(
			"claugle_write",
			{ prompt: "Update the guide", allowFileEdits: true, allowedEditGlobs: "docs/**/*.md" },
			mcpEnv(repo, agyPath)
		);
		assert.equal(readHostSrc(repo), ORIGINAL_SRC, "edit outside docs/**/*.md reached the host");
		assert.equal(result.isError, true);
		assert.deepEqual(calls(), []);
	});

	it("record-native refuses unknown pools and token counts and files gemini-cli usage under gemini-cli", () => {
		const env = isolatedEnv();
		const ledgerEvents = () => {
			const dir = path.join(env.CLAUDE_PLUGIN_DATA, "ledger");
			if (!fs.existsSync(dir)) return [];
			return fs
				.readdirSync(dir)
				.filter((n) => n.endsWith(".jsonl"))
				.flatMap((n) => fs.readFileSync(path.join(dir, n), "utf8").trim().split("\n").filter(Boolean))
				.map((line) => JSON.parse(line));
		};
		assert.equal(runCli(["record-native", "--pool", "bogus-pool", "--tokens", "100"], env).status, 1);
		assert.equal(runCli(["record-native", "--tokens", "abc"], env).status, 1);
		assert.deepEqual(ledgerEvents(), []);
		assert.equal(runCli(["record-native", "--pool", "gemini-cli-pool", "--tokens", "100"], env).status, 0);
		assert.equal(runCli(["record-native", "--tokens", "7"], env).status, 0);
		assert.deepEqual(
			ledgerEvents()
				.sort((a, b) => a.totalTokens - b.totalTokens)
				.map((e) => [e.provider, e.quotaPool, e.modelSlug, e.totalTokens]),
			[
				["claude-native", "claude-code-native", "claude-host", 7],
				["gemini-cli", "gemini-cli-pool", "gemini-2.5-pro", 100],
			]
		);
	});

	it("the MCP server sees the weekly budgets the user configured", async () => {
		const { userConfig } = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
		const server = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".mcp.json"), "utf8")).mcpServers.claugle;
		const poolByOption = {
			claude_weekly_token_budget: "claude-code-native",
			agy_claude_weekly_token_budget: "agy-claude-pool",
			agy_gemini_weekly_token_budget: "agy-gemini-pool",
			gemini_cli_weekly_token_budget: "gemini-cli-pool",
		};
		const userValues = Object.fromEntries(Object.keys(poolByOption).map((key) => [key, String(userConfig[key].default * 3)]));
		const dataDir = tmp("mcp-budgets");
		const substitute = (value) =>
			value
				.replaceAll("${CLAUDE_PLUGIN_ROOT}", PLUGIN_ROOT)
				.replaceAll("${CLAUDE_PLUGIN_DATA}", dataDir)
				.replace(/\$\{user_config\.([A-Za-z0-9_]+)\}/g, (_, key) => userValues[key] ?? String(userConfig[key]?.default ?? ""));
		const env = {
			PATH: process.env.PATH,
			HOME: tmp("mcp-home"),
			CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
			CLAUDE_PLUGIN_DATA: dataDir,
			...Object.fromEntries(Object.entries(server.env ?? {}).map(([key, value]) => [key, substitute(value)])),
		};
		const command = server.command === "node" ? process.execPath : substitute(server.command);
		const child = spawn(command, server.args.map(substitute), { env, stdio: ["pipe", "pipe", "pipe"] });
		const response = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("no claugle_quota response")), 10_000);
			let buffer = "";
			child.stdout.on("data", (chunk) => {
				buffer += chunk;
				const nl = buffer.indexOf("\n");
				if (nl >= 0) {
					clearTimeout(timer);
					resolve(JSON.parse(buffer.slice(0, nl)));
				}
			});
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "claugle_quota", arguments: {} } })}\n`);
		});
		child.kill();
		const pools = JSON.parse(response.result.content[0].text).pools;
		assert.deepEqual(
			Object.fromEntries(Object.entries(poolByOption).map(([key, pool]) => [key, pools[pool].weeklyTokenBudget])),
			Object.fromEntries(Object.entries(userValues).map(([key, value]) => [key, Number(value)]))
		);
	});

	it("a failing CLI command prints one [claugle] line instead of a stack trace", () => {
		const blocker = path.join(tmp("blocker"), "not-a-dir");
		fs.writeFileSync(blocker, "");
		const result = runCli(["record-native", "--tokens", "5"], isolatedEnv({ CLAUDE_PLUGIN_DATA: blocker }));
		assert.equal(result.status, 1);
		assert.match(result.stderr, /^\[claugle\] /);
		assert.doesNotMatch(result.stderr, /\n\s+at /);
	});
});
