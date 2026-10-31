import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { parseCliSubcommandArgs } from "../plugins/claugle/scripts/claugle.mjs";
import { syncClaudeModelPickerSettings } from "../plugins/claugle/scripts/anthropic-gateway.mjs";
import { parsePluginEnv, parseTaskRequest } from "../plugins/claugle/scripts/policy-engine.mjs";
import { executeRoutedTask, writeAgyToolGate } from "../plugins/claugle/scripts/provider-runner.mjs";
import { acquireWorktreeLease, harvestAndReleaseWorktree } from "../plugins/claugle/scripts/worktree-sandbox.mjs";

const PLUGIN_ROOT = path.resolve("plugins/claugle");
const CLI = path.join(PLUGIN_ROOT, "scripts", "claugle.mjs");
const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

function gitRepo(files = {}) {
	const repo = tmp("claugle-r3-repo-");
	const git = (...a) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" });
	git("init", "-q");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	for (const [rel, body] of Object.entries({ "docs/guide.md": "# g\n", ...files })) {
		fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
		fs.writeFileSync(path.join(repo, rel), body);
	}
	git("add", "-A");
	git("commit", "-qm", "init");
	return repo;
}

function recordingAgy() {
	const dir = tmp("claugle-r3-bin-");
	const log = path.join(dir, "calls.jsonl");
	const file = path.join(dir, "agy");
	fs.writeFileSync(
		file,
		`#!/usr/bin/env node
require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd() }) + "\\n");
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write(JSON.stringify({ response: "ran", usage: {} }) + "\\n"));`,
		{ mode: 0o755 }
	);
	return { file, starts: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length : 0) };
}

const envFor = (repo, agy) =>
	parsePluginEnv({ CLAUDE_PLUGIN_DATA: tmp("claugle-r3-data-"), CLAUDE_PROJECT_DIR: repo, CLAUGLE_AGY_BIN: agy, CLAUGLE_GEMINI_BIN: "/nonexistent/gemini" }).value;

function gateDecision(dir, toolCall) {
	const agentsDir = path.join(dir, ".agents");
	const hooks = JSON.parse(fs.readFileSync(path.join(agentsDir, "hooks.json"), "utf8"));
	const command = Object.values(hooks)[0].PreToolUse[0].hooks[0].command;
	const r = spawnSync("sh", ["-c", command], { cwd: agentsDir, input: JSON.stringify({ toolCall }), encoding: "utf8" });
	return r.stdout ? JSON.parse(r.stdout).decision : `crashed(${r.status}): ${r.stderr.split("\n")[0]}`;
}

describe("edits can never change the harness configuration", () => {
	it("the gate denies writes to Claude Code, agy, and gemini configuration", () => {
		const root = tmp("claugle-r3-root-");
		const gate = tmp("claugle-r3-gate-");
		writeAgyToolGate(gate, { readRoots: [root], writeRoots: [root], denyReason: "no" });
		for (const rel of [".claude/settings.json", ".claude/settings.local.json", ".mcp.json", ".gemini/settings.json", "sub/.claude/commands/x.md"]) {
			assert.equal(gateDecision(gate, { name: "write_file", args: { Path: path.join(root, rel) } }), "deny", rel);
		}
	});

	it("harvest rejects Claude Code configuration the model wrote, even under **/*", () => {
		const repo = gitRepo();
		for (const rel of [".claude/settings.json", ".mcp.json"]) {
			const lease = acquireWorktreeLease({ taskId: `task-r3cfg${rel.length}`, hostRepoRoot: repo, pluginDataDir: tmp("claugle-r3-lease-"), allowedGlobs: ["**/*"] });
			fs.mkdirSync(path.dirname(path.join(lease.worktreePath, rel)), { recursive: true });
			fs.writeFileSync(path.join(lease.worktreePath, rel), '{"permissions":{"defaultMode":"bypassPermissions"}}\n');
			const outcome = harvestAndReleaseWorktree(lease);
			assert.notEqual(outcome.kind, "applied-to-host", `${rel}: ${JSON.stringify(outcome)}`);
			assert.equal(fs.existsSync(path.join(repo, rel)), false, rel);
		}
	});
});

describe("agy never starts where the workspace it would load carries command-running customizations", () => {
	it("checks the worktree agy runs in, not only the host checkout", async () => {
		const repo = gitRepo({ ".agents/hooks.json": JSON.stringify({ x: { SessionStart: [{ type: "command", command: "true" }] } }) });
		fs.rmSync(path.join(repo, ".agents"), { recursive: true });
		const agy = recordingAgy();
		await executeRoutedTask({
			request: parseTaskRequest({ prompt: "update docs/guide.md", explicitTaskKind: "docs", allowFileEdits: true, allowedEditGlobs: ["docs/**"], cwd: repo }).value,
			env: envFor(repo, agy.file),
		});
		assert.equal(agy.starts(), 0);
	});

	it("refuses agy plugin hooks and MCP server configs as well", async () => {
		for (const rel of [".agents/plugins/kit/hooks.json", ".agents/mcp_config.json"]) {
			const repo = gitRepo({ [rel]: "{}\n" });
			const agy = recordingAgy();
			await executeRoutedTask({ request: parseTaskRequest({ prompt: "Review this diff", explicitTaskKind: "review", cwd: repo }).value, env: envFor(repo, agy.file) });
			assert.equal(agy.starts(), 0, rel);
		}
	});
});

describe("the gate always answers, and only for real paths", () => {
	it("prints deny instead of crashing on paths the filesystem rejects", () => {
		const root = tmp("claugle-r3-root-");
		fs.writeFileSync(path.join(root, "file.txt"), "x\n");
		fs.symlinkSync(path.join(root, "loop-b"), path.join(root, "loop-a"));
		fs.symlinkSync(path.join(root, "loop-a"), path.join(root, "loop-b"));
		const gate = tmp("claugle-r3-gate-");
		writeAgyToolGate(gate, { readRoots: [root], writeRoots: [root], denyReason: "no" });
		for (const target of [path.join(root, "a\u0000b"), path.join(root, "file.txt", "child"), path.join(root, "loop-a", "x"), path.join(root, "n".repeat(5000))]) {
			assert.equal(gateDecision(gate, { name: "write_file", args: { Path: target } }), "deny", JSON.stringify(target.slice(-40)));
		}
	});

	it("works when a root path contains $ characters", () => {
		const parent = tmp("claugle-r3-dollar-");
		const root = path.join(parent, "a$'b$&c");
		fs.mkdirSync(root);
		const gate = tmp("claugle-r3-gate-");
		writeAgyToolGate(gate, { readRoots: [root], writeRoots: [root], denyReason: "no" });
		assert.equal(gateDecision(gate, { name: "write_file", args: { Path: path.join(root, "ok.txt") } }), "allow");
	});

	it("denies paths that climb with ..", () => {
		const root = tmp("claugle-r3-root-");
		const gate = tmp("claugle-r3-gate-");
		writeAgyToolGate(gate, { readRoots: [root], writeRoots: [root], denyReason: "no" });
		assert.equal(gateDecision(gate, { name: "read_file", args: { Path: `${root}/sub/../ok.txt` } }), "deny");
	});
});

describe("ambiguous slash command text is refused instead of guessed", () => {
	it("refuses flags that follow a bare -- in the middle of the text", () => {
		assert.throws(() => parseCliSubcommandArgs(["--args-stdin"], "--allow-edits fix the typo -- it is in the intro --glob docs/**"), /--/);
		assert.throws(() => parseCliSubcommandArgs(["--args-stdin"], "explain what -- --allow-edits does"), /--/);
		assert.equal(parseCliSubcommandArgs(["--args-stdin"], "write docs -- then stop").prompt, "write docs -- then stop");
	});
});

describe("settings follow the gateway port and never kill the hook", () => {
	it("moves a stale claugle URL to the configured port but keeps a foreign proxy", async () => {
		const dir = tmp("claugle-r3-settings-");
		const file = path.join(dir, "settings.json");
		fs.writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:18789" } }));
		assert.equal(syncClaudeModelPickerSettings({ settingsPath: file, gatewayUrl: "http://127.0.0.1:18932", replaceLocalBaseUrl: true }).kind, "ok");
		assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).env.ANTHROPIC_BASE_URL, "http://127.0.0.1:18932");
		fs.writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://corp-proxy.example/v1" } }));
		syncClaudeModelPickerSettings({ settingsPath: file, gatewayUrl: "http://127.0.0.1:18932", replaceLocalBaseUrl: true });
		assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).env.ANTHROPIC_BASE_URL, "https://corp-proxy.example/v1");
	});

	it("the SessionStart hook replaces a dead claugle URL and reports a settings write failure instead of exiting", async () => {
		const probe = http.createServer();
		await new Promise((r) => probe.listen(0, "127.0.0.1", r));
		const deadPort = probe.address().port;
		await new Promise((r) => probe.close(r));
		const dir = tmp("claugle-r3-hook-");
		const settings = path.join(dir, "settings.json");
		fs.writeFileSync(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${deadPort}` } }));
		const run = (settingsPath, port) =>
			spawnSync(process.execPath, [CLI, "hook"], {
				input: JSON.stringify({ hook_event_name: "SessionStart" }),
				env: { ...process.env, CLAUDE_PLUGIN_DATA: dir, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUGLE_GATEWAY_PORT: String(port), CLAUGLE_CLAUDE_SETTINGS_PATH: settingsPath },
				encoding: "utf8",
				timeout: 20_000,
			});
		const freePort = deadPort + 1;
		try {
			const ok = run(settings, freePort);
			assert.equal(ok.status, 0, ok.stderr);
			assert.equal(JSON.parse(fs.readFileSync(settings, "utf8")).env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${freePort}`);
			const blocked = path.join(dir, "not-a-dir");
			fs.writeFileSync(blocked, "x");
			const broken = run(path.join(blocked, "settings.json"), freePort);
			assert.equal(broken.status, 0, broken.stderr);
			assert.match(JSON.parse(broken.stdout.trim().split("\n").pop()).systemMessage ?? "", /settings/i);
		} finally {
			await fetch(`http://127.0.0.1:${freePort}/admin/shutdown`, { method: "POST", headers: { "x-claugle-admin": "shutdown" } }).catch(() => {});
		}
	});
});

describe("task ids", () => {
	it("an id parseTaskRequest accepts still names a usable worktree", async () => {
		const repo = gitRepo();
		const agy = recordingAgy();
		const longest = `task-${"a".repeat(200)}`.slice(0, 200);
		let taskId = longest;
		while (parseTaskRequest({ prompt: "x", taskId, cwd: repo }).kind === "error") taskId = taskId.slice(0, -1);
		const out = await executeRoutedTask({
			request: parseTaskRequest({ prompt: "update docs/guide.md", explicitTaskKind: "docs", allowFileEdits: true, allowedEditGlobs: ["docs/**"], taskId, cwd: repo }).value,
			env: envFor(repo, agy.file),
		});
		assert.doesNotMatch(out.responseText, /Unsafe worktree task id/);
		assert.equal(agy.starts(), 1);
	});
});
