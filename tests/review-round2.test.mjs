import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { parseCliSubcommandArgs } from "../plugins/claugle/scripts/claugle.mjs";
import { ensureGatewayDaemon, startAnthropicGatewayServer } from "../plugins/claugle/scripts/anthropic-gateway.mjs";
import { parsePluginEnv, parseTaskRequest } from "../plugins/claugle/scripts/policy-engine.mjs";
import { executeRoutedTask, runHeadlessProvider, writeAgyToolGate } from "../plugins/claugle/scripts/provider-runner.mjs";
import { acquireWorktreeLease, harvestAndReleaseWorktree } from "../plugins/claugle/scripts/worktree-sandbox.mjs";

const PLUGIN_ROOT = path.resolve("plugins/claugle");
const CLI = path.join(PLUGIN_ROOT, "scripts", "claugle.mjs");
const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

function gitRepo() {
	const repo = tmp("claugle-r2-repo-");
	const git = (...a) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" });
	git("init", "-q");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	fs.mkdirSync(path.join(repo, "docs"));
	fs.writeFileSync(path.join(repo, "docs", "guide.md"), "# g\n");
	git("add", "-A");
	git("commit", "-qm", "init");
	return repo;
}

function stubAgy(body) {
	const dir = tmp("claugle-r2-bin-");
	const file = path.join(dir, "agy");
	fs.writeFileSync(file, `#!/usr/bin/env node\nconst calls = ${JSON.stringify(path.join(dir, "calls.jsonl"))};\n${body}\n`, { mode: 0o755 });
	return { file, calls: () => (fs.existsSync(path.join(dir, "calls.jsonl")) ? fs.readFileSync(path.join(dir, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []) };
}

const recordingAgy = (answer) =>
	stubAgy(`const a = process.argv.slice(2);
require("node:fs").appendFileSync(calls, JSON.stringify({ model: a[a.indexOf("--model") + 1], cwd: process.cwd() }) + "\\n");
process.stdin.resume();
process.stdin.on("end", () => { ${answer} });`);

function envFor(repo, agyPath, extra = {}) {
	return parsePluginEnv({ CLAUDE_PLUGIN_DATA: tmp("claugle-r2-data-"), CLAUDE_PROJECT_DIR: repo, CLAUGLE_AGY_BIN: agyPath, CLAUGLE_GEMINI_BIN: "/nonexistent/gemini", ...extra }).value;
}

function gateDecision(dir, toolCall) {
	const agentsDir = path.join(dir, ".agents");
	const hooks = JSON.parse(fs.readFileSync(path.join(agentsDir, "hooks.json"), "utf8"));
	const command = Object.values(hooks)[0].PreToolUse[0].hooks[0].command;
	return JSON.parse(execFileSync("sh", ["-c", command], { cwd: agentsDir, input: JSON.stringify({ toolCall }), encoding: "utf8" })).decision;
}

describe("the tool gate understands every agy file-tool dialect and refuses git and agy internals", () => {
	const root = tmp("claugle-r2-root-");
	const outside = tmp("claugle-r2-out-");
	fs.mkdirSync(path.join(root, "src"));
	fs.writeFileSync(path.join(root, "src", "a.js"), "x\n");
	fs.symlinkSync(path.join(outside, "not-yet-there.txt"), path.join(root, "dangling"));
	const gate = tmp("claugle-r2-gate-");
	writeAgyToolGate(gate, { readRoots: [root], writeRoots: [root], denyReason: "no" });
	const decide = (name, args) => gateDecision(gate, { name, args });

	it("allows reads and writes inside the roots whatever the tool calls its path", () => {
		assert.equal(decide("view_file", { AbsolutePath: path.join(root, "src", "a.js") }), "allow");
		assert.equal(decide("list_dir", { DirectoryPath: path.join(root, "src") }), "allow");
		assert.equal(decide("grep_search", { SearchPath: root, Query: "x" }), "allow");
		assert.equal(decide("write_to_file", { TargetFile: path.join(root, "src", "b.js"), CodeContent: "y" }), "allow");
		assert.equal(decide("replace_file_content", { TargetFile: path.join(root, "src", "a.js") }), "allow");
	});

	it("denies a call whose path points outside, or that names no path at all", () => {
		assert.equal(decide("view_file", { AbsolutePath: path.join(outside, "x") }), "deny");
		assert.equal(decide("write_to_file", { TargetFile: path.join(root, "ok.md"), OtherFile: path.join(outside, "x") }), "deny");
		assert.equal(decide("write_file", { Content: "y" }), "deny");
		assert.equal(decide("grep_search", { Query: "x" }), "deny");
	});

	it("denies git and agy customization paths and dangling symlinks", () => {
		assert.equal(decide("write_file", { Path: path.join(root, "sub", ".git", "config") }), "deny");
		assert.equal(decide("read_file", { Path: path.join(root, ".git", "config") }), "deny");
		assert.equal(decide("write_file", { Path: path.join(root, ".agents", "hooks.json") }), "deny");
		assert.equal(decide("write_file", { Path: path.join(root, "dangling") }), "deny");
	});
});

describe("harvest never runs commands the model planted and never imports agy customizations", () => {
	it("rejects a worktree that grew a nested git repository, without running its fsmonitor", () => {
		const repo = gitRepo();
		const dataDir = tmp("claugle-r2-lease-");
		const lease = acquireWorktreeLease({ taskId: "task-r2a", hostRepoRoot: repo, pluginDataDir: dataDir, allowedGlobs: ["**/*"] });
		const nested = path.join(lease.worktreePath, "vendor", "x");
		fs.mkdirSync(nested, { recursive: true });
		execFileSync("git", ["-C", nested, "init", "-q"]);
		const marker = path.join(dataDir, "fsmonitor-ran");
		execFileSync("git", ["-C", nested, "config", "core.fsmonitor", `touch ${marker}; false`]);
		fs.writeFileSync(path.join(nested, "f.txt"), "y\n");
		fs.writeFileSync(path.join(lease.worktreePath, "docs", "guide.md"), "# changed\n");
		const outcome = harvestAndReleaseWorktree(lease);
		assert.notEqual(outcome.kind, "applied-to-host", JSON.stringify(outcome));
		assert.equal(fs.existsSync(marker), false, "fsmonitor command must not run");
		assert.equal(fs.readFileSync(path.join(repo, "docs", "guide.md"), "utf8"), "# g\n");
	});

	it("rejects changes under .agents even when the globs allow everything", () => {
		const repo = gitRepo();
		const lease = acquireWorktreeLease({ taskId: "task-r2b", hostRepoRoot: repo, pluginDataDir: tmp("claugle-r2-lease-"), allowedGlobs: ["**/*"] });
		fs.mkdirSync(path.join(lease.worktreePath, ".agents"));
		fs.writeFileSync(path.join(lease.worktreePath, ".agents", "hooks.json"), "{}\n");
		const outcome = harvestAndReleaseWorktree(lease);
		assert.notEqual(outcome.kind, "applied-to-host", JSON.stringify(outcome));
		assert.equal(fs.existsSync(path.join(repo, ".agents")), false);
	});
});

describe("delegation refuses what it cannot bind", () => {
	it("does not run agy in a repository that defines its own agy hooks", async () => {
		const repo = gitRepo();
		fs.mkdirSync(path.join(repo, ".agents"));
		fs.writeFileSync(path.join(repo, ".agents", "hooks.json"), JSON.stringify({ x: { SessionStart: [{ type: "command", command: "true" }] } }));
		const agy = recordingAgy(`process.stdout.write(JSON.stringify({ response: "ran", usage: {} }) + "\\n");`);
		const out = await executeRoutedTask({ request: parseTaskRequest({ prompt: "Review this diff", explicitTaskKind: "review", cwd: repo }).value, env: envFor(repo, agy.file) });
		assert.equal(agy.calls().length, 0, "agy must not start");
		assert.match(out.responseText, /\.agents\/hooks\.json/);
	});

	it("never runs gemini-cli, whose tools claugle cannot gate", async () => {
		const repo = gitRepo();
		const binDir = tmp("claugle-r2-gem-");
		const gemini = path.join(binDir, "gemini");
		fs.writeFileSync(gemini, `#!/bin/sh\ntouch ${JSON.stringify(path.join(binDir, "ran"))}\necho '{"response":"gemini answered"}'\n`, { mode: 0o755 });
		const agy = recordingAgy(`process.stdout.write(JSON.stringify({ response: "agy answered", usage: {} }) + "\\n");`);
		const env = envFor(repo, agy.file, { CLAUGLE_GEMINI_BIN: gemini });
		await executeRoutedTask({ request: parseTaskRequest({ prompt: "Review this diff", explicitTaskKind: "review", preferredModel: "gemini-2.5-pro", cwd: repo }).value, env });
		assert.equal(fs.existsSync(path.join(binDir, "ran")), false);
	});

	it("rejects a taskId that would leave the plugin data folder", () => {
		const r = parseTaskRequest({ prompt: "x", taskId: "task-x/../../victim", cwd: os.tmpdir() });
		assert.equal(r.kind, "error");
	});

	it("does not delete anything outside agy-gates for a raw request with a hostile taskId", async () => {
		const repo = gitRepo();
		const env = envFor(repo, recordingAgy(`process.stdout.write(JSON.stringify({ response: "ok", usage: {} }) + "\\n");`).file);
		const victim = path.join(env.pluginDataDir, "victim-1");
		fs.mkdirSync(victim, { recursive: true });
		await executeRoutedTask({ request: { prompt: "Review this diff", explicitTaskKind: "review", taskId: "task-x/../../victim", cwd: repo }, env }).catch(() => {});
		assert.equal(fs.existsSync(victim), true);
	});
});

describe("no silent model substitution", () => {
	it("the gateway does not answer a pinned model with a different one", async () => {
		const dataDir = tmp("claugle-r2-gw-");
		const fakeAgy = path.join(dataDir, "agy");
		fs.writeFileSync(fakeAgy, "#!/bin/sh\n", { mode: 0o755 });
		const calls = [];
		const gw = await startAnthropicGatewayServer({
			port: 0,
			env: { pluginDataDir: dataDir, pluginRoot: PLUGIN_ROOT, projectDir: dataDir, sessionId: "s", weeklyBudgets: { "claude-code-native": 5e6, "agy-claude-pool": 8e6, "agy-gemini-pool": 15e6, "gemini-cli-pool": 1e7 }, agyBinOverride: fakeAgy },
			providerRunner: async (p) => {
				calls.push(p.modelSlug);
				return p.modelSlug === "gemini-4-argon-high"
					? { kind: "failure", reason: "NON_ZERO_EXIT", message: "boom", durationMs: 1 }
					: { kind: "success", durationMs: 1, payload: { response: "", structuredOutput: { text: `answered by ${p.modelSlug}`, tool_calls: [] }, usage: { inputTokens: 1, outputTokens: 1, thinkingTokens: 0, cacheReadTokens: 0, totalTokens: 2 } } };
			},
		});
		try {
			const res = await fetch(`${gw.url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gemini-4-argon", messages: [{ role: "user", content: "x" }] }) });
			const body = await res.json();
			assert.equal(body.type, "error", JSON.stringify(body));
			assert.deepEqual(calls, ["gemini-4-argon-high"]);
		} finally {
			gw.server.close();
		}
	});

	it("a delegated task says so when a model other than the requested one answered", async () => {
		const repo = gitRepo();
		const agy = recordingAgy(`const m = JSON.parse(require("node:fs").readFileSync(calls, "utf8").trim().split("\\n").pop()).model;
if (m === "gemini-4-argon-high") { process.stderr.write("agy crashed\\n"); process.exit(3); }
process.stdout.write(JSON.stringify({ response: "answer from " + m, usage: {} }) + "\\n");`);
		const out = await executeRoutedTask({ request: parseTaskRequest({ prompt: "Review this diff", explicitTaskKind: "review", preferredModel: "argon", cwd: repo }).value, env: envFor(repo, agy.file) });
		assert.match(out.responseText, /gemini-4-argon-high/);
		assert.notEqual(out.selectedTarget?.modelSlug, "gemini-4-argon-high");
	});
});

describe("runner recognizes agy's real quota message", () => {
	it("classifies 'Individual quota reached' as QUOTA_EXHAUSTED", async () => {
		const agy = stubAgy(`process.stdin.resume(); process.stdin.on("end", () => {
process.stderr.write("error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 42m42s.\\n");
process.stderr.write('AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached.","status":"RESOURCE_EXHAUSTED","error_code":429}\\n');
process.exit(3); });`);
		const r = await runHeadlessProvider({ provider: "agy", binaryPath: agy.file, prompt: "x", modelSlug: "claude-sonnet-5-5-low", cwd: os.tmpdir(), timeoutMs: 20_000 });
		assert.equal(r.reason, "QUOTA_EXHAUSTED", r.message);
	});
});

describe("slash command text after a bare -- is prose", () => {
	it("never silently applies or drops flags that follow -- in the middle of the text", () => {
		assert.throws(() => parseCliSubcommandArgs(["--args-stdin"], "write docs -- --json --model flash"), /bare --/);
	});
});

describe("SessionStart keeps the gateway honest", () => {
	it("points settings at the configured gateway port and warns when an old daemon cannot be replaced", async () => {
		const squatter = http.createServer((req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ status: "ok", service: "claugle-gateway" }));
		});
		await new Promise((r) => squatter.listen(0, "127.0.0.1", r));
		const port = squatter.address().port;
		const dataDir = tmp("claugle-r2-hook-");
		const settings = path.join(dataDir, "settings.json");
		fs.writeFileSync(settings, "{}\n");
		const started = Date.now();
		const child = spawn(process.execPath, [CLI, "hook"], {
			env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUGLE_GATEWAY_PORT: String(port), CLAUGLE_CLAUDE_SETTINGS_PATH: settings },
			stdio: ["pipe", "pipe", "pipe"],
		});
		child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart" }));
		let out = "";
		child.stdout.on("data", (c) => (out += c));
		await new Promise((r) => child.on("exit", r));
		squatter.close();
		assert.ok(Date.now() - started < 9000, `hook took ${Date.now() - started}ms`);
		assert.equal(JSON.parse(fs.readFileSync(settings, "utf8")).env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${port}`);
		assert.match(out, /gateway/i);
		assert.match(JSON.parse(out.trim().split("\n").pop()).systemMessage ?? "", /gateway/i);
	});

	it("stops a pre-upgrade claugle daemon that has no shutdown route", async () => {
		const fakeRoot = tmp("claugle-r2-oldroot-");
		fs.mkdirSync(path.join(fakeRoot, "scripts"));
		const oldCli = path.join(fakeRoot, "scripts", "claugle.mjs");
		fs.writeFileSync(
			oldCli,
			`import http from "node:http";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"status":"ok","service":"claugle-gateway"}'); }).listen(port, "127.0.0.1");
`
		);
		const probe = http.createServer();
		await new Promise((r) => probe.listen(0, "127.0.0.1", r));
		const port = probe.address().port;
		await new Promise((r) => probe.close(r));
		const old = spawn(process.execPath, [oldCli, "gateway", "--port", String(port)], { stdio: "ignore", detached: true });
		old.unref();
		for (let i = 0; i < 40; i += 1) {
			const ok = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false);
			if (ok) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		let status;
		const columns = process.env.COLUMNS;
		process.env.COLUMNS = "40";
		try {
			status = await ensureGatewayDaemon({ port, pluginRoot: PLUGIN_ROOT });
			assert.equal(status.status, "restarted", JSON.stringify(status));
		} finally {
			if (columns === undefined) delete process.env.COLUMNS;
			else process.env.COLUMNS = columns;
			try {
				process.kill(old.pid, "SIGKILL");
			} catch {}
			await fetch(`http://127.0.0.1:${port}/admin/shutdown`, { method: "POST", headers: { "x-claugle-admin": "shutdown" } }).catch(() => {});
		}
	});
});
