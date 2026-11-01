import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { parseCliSubcommandArgs } from "../plugins/claugle/scripts/claugle.mjs";
import { appendUsageEvent } from "../plugins/claugle/scripts/ledger-store.mjs";
import { parsePluginEnv } from "../plugins/claugle/scripts/policy-engine.mjs";

describe("slash command text keeps prose flags as prose", () => {
	const parse = (text) => {
		const { options, prompt } = parseCliSubcommandArgs(["--args-stdin"], text);
		return { prompt, model: options.preferredModel, effort: options.preferredEffort, contextFiles: options.contextFiles, edits: options.allowFileEdits };
	};

	it("does not read short flags in the middle of a question", () => {
		assert.deepEqual(parse("why does git commit -m fail here"), {
			prompt: "why does git commit -m fail here",
			model: undefined,
			effort: undefined,
			contextFiles: [],
			edits: false,
		});
		assert.deepEqual(parse("explain grep -e usage and python -c tricks").prompt, "explain grep -e usage and python -c tricks");
		assert.deepEqual(parse("explain grep -e usage and python -c tricks").contextFiles, []);
	});

	it("still reads leading flags and trailing long flags", () => {
		assert.deepEqual(parse("-m flash 문서 써줘"), { prompt: "문서 써줘", model: "flash", effort: undefined, contextFiles: [], edits: false });
		assert.deepEqual(parse("fix the parser --model flash --allow-edits"), { prompt: "fix the parser", model: "flash", effort: undefined, contextFiles: [], edits: true });
		assert.deepEqual(parse("fix the user's parser --allow-edits").prompt, "fix the user's parser");
	});
});

describe("plugin options that Claude Code left unsubstituted", () => {
	it("falls back to the default budget instead of failing every command", () => {
		const r = parsePluginEnv({
			CLAUDE_PLUGIN_DATA: fs.mkdtempSync(path.join(os.tmpdir(), "claugle-rf-")),
			CLAUDE_PLUGIN_OPTION_CLAUDE_WEEKLY_TOKEN_BUDGET: "${user_config.claude_weekly_token_budget}",
		});
		assert.equal(r.kind, "ok", r.message);
		assert.equal(r.value.weeklyBudgets["claude-code-native"], 5_000_000);
	});
});

describe("ledger appends always terminate", () => {
	it("gives up re-appending when the filesystem reports a different inode every time", () => {
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "claugle-rf-ledger-"));
		const realStat = fs.statSync;
		let fake = 0;
		fs.statSync = (p, opts) => {
			const st = realStat(p, opts);
			if (st && String(p).includes(`${path.sep}ledger${path.sep}shard-`)) {
				fake += 1;
				return { ...st, ino: -fake, dev: st.dev };
			}
			return st;
		};
		try {
			const started = Date.now();
			const out = appendUsageEvent({
				pluginDataDir: dataDir,
				event: { sessionId: "s", provider: "agy", quotaPool: "agy-gemini-pool", modelSlug: "gemini-4-argon-high", totalTokens: 1, status: "SUCCESS" },
			});
			assert.ok(Date.now() - started < 2000);
			assert.ok(fs.readFileSync(out.shardPath, "utf8").includes(out.event.eventId));
		} finally {
			fs.statSync = realStat;
		}
	});
});

import { execFileSync, spawn } from "node:child_process";
import { buildAgyCliArgs, executeRoutedTask, runHeadlessProvider } from "../plugins/claugle/scripts/provider-runner.mjs";
import { loadRollingQuotaSnapshot } from "../plugins/claugle/scripts/ledger-store.mjs";
import { parseAgyOutputJson, parseTaskRequest, transitionQuotaState, DEFAULT_GOVERNOR_THRESHOLDS } from "../plugins/claugle/scripts/policy-engine.mjs";

function tmpDir(prefix) {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function stub(dir, body) {
	const file = path.join(dir, "agy");
	fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
	return file;
}

describe("governor reacts to quota exhaustion, not to transient rate limits", () => {
	it("a 429 from agy does not move the governor out of NORMAL", async () => {
		const repo = tmpDir("claugle-rf-429-");
		execFileSync("git", ["-C", repo, "init", "-q"]);
		const dataDir = tmpDir("claugle-rf-429-data-");
		const agy = stub(tmpDir("claugle-rf-429-bin-"), `process.stdin.resume(); process.stdin.on("end", () => { process.stderr.write("HTTP 429 Too Many Requests\\n"); process.exit(1); });`);
		const env = parsePluginEnv({ CLAUDE_PLUGIN_DATA: dataDir, CLAUDE_PROJECT_DIR: repo, CLAUGLE_AGY_BIN: agy, CLAUGLE_GEMINI_BIN: "/nonexistent/gemini" }).value;
		const req = parseTaskRequest({ prompt: "Review this diff", explicitTaskKind: "review", cwd: repo });
		await executeRoutedTask({ request: req.value, env });
		const snap = loadRollingQuotaSnapshot({ pluginDataDir: dataDir, weeklyBudgets: env.weeklyBudgets, nowMs: Date.now() + 1000 });
		assert.equal(snap.quotaState, "NORMAL");
	});

	it("falls back to gemini-cli only when every agy pool is exhausted", () => {
		const now = 10 * 24 * 3600 * 1000;
		const pool = (lastRateLimitAt) => ({ consumedRatio: 0, rateLimitHitsInWindow: lastRateLimitAt ? 1 : 0, lastRateLimitAt });
		const metrics = (claudeAt, geminiAt) => ({
			windowEnd: now,
			pools: { "claude-code-native": pool(null), "agy-claude-pool": pool(claudeAt), "agy-gemini-pool": pool(geminiAt), "gemini-cli-pool": pool(null) },
		});
		assert.notEqual(transitionQuotaState("NORMAL", metrics(now - 60_000, null), DEFAULT_GOVERNOR_THRESHOLDS), "FALLBACK_GEMINI_CLI");
		assert.equal(transitionQuotaState("NORMAL", metrics(now - 60_000, now - 30_000), DEFAULT_GOVERNOR_THRESHOLDS), "FALLBACK_GEMINI_CLI");
	});
});

describe("agy runs end when their caller goes away", () => {
	it("treats an agy turn that hit its print timeout as a failure, not an answer", () => {
		const r = parseAgyOutputJson('{"event":"result","result":{"status":"SUCCESS","response":"partial ans","finished_reason":"print_timeout","usage":{}}}');
		assert.equal(r.kind, "error");
	});

	it("asks agy to stop on its own when the runner timeout passes", () => {
		const args = buildAgyCliArgs({ prompt: "x", modelSlug: "gemini-4-argon-high", effort: "high", mode: "plan", cwd: os.tmpdir(), timeoutMs: 90_000 });
		const i = args.indexOf("--print-timeout");
		assert.ok(i >= 0, args.join(" "));
		assert.equal(args[i + 1], "90s");
	});

	it("kills the agy process group when the caller aborts", async () => {
		const dir = tmpDir("claugle-rf-abort-");
		const pidFile = path.join(dir, "pid");
		const agy = stub(dir, `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60_000);`);
		const ac = new AbortController();
		const started = Date.now();
		const pending = runHeadlessProvider({ provider: "agy", binaryPath: agy, prompt: "x", modelSlug: "gemini-4-argon-high", cwd: dir, timeoutMs: 60_000, signal: ac.signal });
		while (!fs.existsSync(pidFile)) await new Promise((r) => setTimeout(r, 20));
		ac.abort();
		const r = await pending;
		assert.equal(r.kind, "failure");
		assert.equal(r.reason, "CANCELLED");
		assert.ok(Date.now() - started < 8000);
		const pid = Number(fs.readFileSync(pidFile, "utf8"));
		await new Promise((r) => setTimeout(r, 300));
		assert.throws(() => process.kill(pid, 0), "agy must be gone after the abort");
	});

	it("kills running agy groups when the caller process gets SIGTERM", async () => {
		const dir = tmpDir("claugle-rf-sigterm-");
		const pidFile = path.join(dir, "pid");
		const agy = stub(dir, `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60_000);`);
		const runner = path.resolve("plugins/claugle/scripts/provider-runner.mjs");
		const parent = spawn(process.execPath, [
			"--input-type=module",
			"-e",
			`const { runHeadlessProvider } = await import(${JSON.stringify(runner)}); await runHeadlessProvider({ provider: "agy", binaryPath: ${JSON.stringify(agy)}, prompt: "x", modelSlug: "gemini-4-argon-high", cwd: ${JSON.stringify(dir)}, timeoutMs: 60000 });`,
		], { stdio: "ignore" });
		while (!fs.existsSync(pidFile)) await new Promise((r) => setTimeout(r, 20));
		const pid = Number(fs.readFileSync(pidFile, "utf8"));
		parent.kill("SIGTERM");
		await new Promise((r) => parent.on("exit", r));
		await new Promise((r) => setTimeout(r, 500));
		let alive = true;
		try {
			process.kill(pid, 0);
		} catch {
			alive = false;
		}
		if (alive) process.kill(pid, "SIGKILL");
		assert.equal(alive, false, "agy outlived its caller");
	});
});

describe("delegated agy runs pass every tool call through the claugle gate", () => {
	const gateProbeAgy = (dir, calls) =>
		stub(
			dir,
			`const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
process.stdin.resume();
process.stdin.on("end", () => {
	const decisions = {};
	const i = args.indexOf("--add-dir");
	if (i >= 0) {
		const agentsDir = path.join(args[i + 1], ".agents");
		const hooks = JSON.parse(fs.readFileSync(path.join(agentsDir, "hooks.json"), "utf8"));
		const command = Object.values(hooks)[0].PreToolUse[0].hooks[0].command;
		const calls = ${JSON.stringify(calls)}.map(([name, rel]) => [name, rel && (path.isAbsolute(rel) ? rel : path.join(process.cwd(), rel))]);
		for (const [name, target] of calls) {
			const out = execFileSync("sh", ["-c", command], { cwd: agentsDir, input: JSON.stringify({ toolCall: { name, args: target ? { Path: target } : {} } }), encoding: "utf8" });
			decisions[name + ":" + (target ? path.relative(process.cwd(), target) : "")] = JSON.parse(out).decision;
		}
	}
	process.stdout.write(JSON.stringify({ response: JSON.stringify(decisions), usage: { total_tokens: 1 } }) + "\\n");
});`
		);

	function repoWithOutsideLink() {
		const repo = tmpDir("claugle-rf-gate-repo-");
		const outside = tmpDir("claugle-rf-gate-outside-");
		fs.writeFileSync(path.join(outside, "secret.txt"), "s\n");
		execFileSync("git", ["-C", repo, "init", "-q"]);
		execFileSync("git", ["-C", repo, "config", "user.email", "t@t"]);
		execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
		fs.mkdirSync(path.join(repo, "docs"));
		fs.writeFileSync(path.join(repo, "docs", "guide.md"), "# g\n");
		fs.symlinkSync(outside, path.join(repo, "escape"));
		execFileSync("git", ["-C", repo, "add", "-A"]);
		execFileSync("git", ["-C", repo, "commit", "-qm", "init"]);
		return { repo, outside };
	}

	async function run(repo, agy, request) {
		const dataDir = tmpDir("claugle-rf-gate-data-");
		const env = parsePluginEnv({ CLAUDE_PLUGIN_DATA: dataDir, CLAUDE_PROJECT_DIR: repo, CLAUGLE_AGY_BIN: agy, CLAUGLE_GEMINI_BIN: "/nonexistent/gemini" }).value;
		const out = await executeRoutedTask({ request: parseTaskRequest({ cwd: repo, ...request }).value, env });
		return { out, dataDir };
	}

	it("a read-only run may read the project and nothing else", async () => {
		const { repo, outside } = repoWithOutsideLink();
		const agy = gateProbeAgy(tmpDir("claugle-rf-gate-bin-"), [
			["read_file", "docs/guide.md"],
			["write_file", "docs/new.md"],
			["read_file", "escape/secret.txt"],
			["read_file", path.join(outside, "secret.txt")],
			["schedule", null],
			["run_command", null],
			["finish", null],
		]);
		const { out, dataDir } = await run(repo, agy, { prompt: "Review this diff for bugs", explicitTaskKind: "review" });
		assert.deepEqual(JSON.parse(out.responseText), {
			"read_file:docs/guide.md": "allow",
			"write_file:docs/new.md": "deny",
			"read_file:escape/secret.txt": "deny",
			[`read_file:${path.relative(repo, path.join(outside, "secret.txt"))}`]: "deny",
			"schedule:": "deny",
			"run_command:": "deny",
			"finish:": "allow",
		});
		assert.deepEqual(fs.readdirSync(path.join(dataDir, "agy-gates")), [], "the per-run gate is removed afterwards");
	});

	it("an edit run may write inside its worktree but not into the host repository", async () => {
		const { repo } = repoWithOutsideLink();
		const agy = gateProbeAgy(tmpDir("claugle-rf-gate-bin-"), [
			["write_file", "docs/new.md"],
			["edit_file", "docs/guide.md"],
			["write_file", path.join(repo, "docs", "direct.md")],
			["send_message", null],
		]);
		const { out } = await run(repo, agy, { prompt: "update docs/guide.md", explicitTaskKind: "docs", allowFileEdits: true, allowedEditGlobs: ["docs/**"] });
		const decisions = JSON.parse(out.responseText.split("\n")[0]);
		const direct = Object.entries(decisions).find(([key]) => key.endsWith(path.join("docs", "direct.md")));
		assert.equal(decisions["write_file:docs/new.md"], "allow");
		assert.equal(decisions["edit_file:docs/guide.md"], "allow");
		assert.equal(direct?.[1], "deny", JSON.stringify(decisions));
		assert.equal(decisions["send_message:"], "deny");
	});
});

describe("slash commands see the budgets the user configured", () => {
	it("SessionStart exports the configured budgets for Bash-launched claugle commands", () => {
		const dataDir = tmpDir("claugle-rf-envfile-");
		const envFile = path.join(dataDir, "session.env");
		const cli = path.resolve("plugins/claugle/scripts/claugle.mjs");
		const hookEnv = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_OPTION_CLAUDE_WEEKLY_TOKEN_BUDGET: "7000000", CLAUGLE_SKIP_GATEWAY_AUTOSTART: "1" };
		execFileSync(process.execPath, [cli, "hook"], { env: hookEnv, input: JSON.stringify({ hook_event_name: "SessionStart" }), encoding: "utf8" });
		const bashEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE_PLUGIN_OPTION_") && !k.startsWith("CLAUGLE_") && k !== "CLAUDE_PLUGIN_DATA"));
		const out = execFileSync("bash", ["-c", `source ${JSON.stringify(envFile)} && node ${JSON.stringify(cli)} quota`], { env: bashEnv, encoding: "utf8" });
		assert.equal(JSON.parse(out).metrics?.pools?.["claude-code-native"]?.weeklyTokenBudget ?? JSON.parse(out).pools?.["claude-code-native"]?.weeklyTokenBudget, 7_000_000, out.slice(0, 400));
	});
});

import { evaluateHookEvent } from "../plugins/claugle/scripts/provider-runner.mjs";

describe("host usage limits reach the governor", () => {
	it("a 5-hour limit error in the transcript moves the governor to OVERFLOW_TO_AGY once", () => {
		const dataDir = tmpDir("claugle-rf-limit-");
		const transcript = path.join(dataDir, "session.jsonl");
		const hitAt = Date.now() - 60_000;
		const entry = {
			type: "assistant",
			uuid: "u-limit",
			timestamp: new Date(hitAt).toISOString(),
			isApiErrorMessage: true,
			error: "rate_limit",
			apiError: "usage_limit_reached",
			apiErrorStatus: 429,
			quotaLimits: { status: "rejected", rateLimitType: "five_hour", resetsAt: Math.floor(hitAt / 1000) + 3600 },
			message: { id: "m-limit", model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "You've hit your 5-hour limit" }], usage: { input_tokens: 0, output_tokens: 0 } },
		};
		fs.writeFileSync(transcript, `${JSON.stringify(entry)}\n`);
		const env = { pluginDataDir: dataDir, sessionId: "s-limit", weeklyBudgets: { "claude-code-native": 5_000_000, "agy-claude-pool": 8_000_000, "agy-gemini-pool": 15_000_000, "gemini-cli-pool": 10_000_000 } };
		const stop = JSON.stringify({ hook_event_name: "Stop", transcript_path: transcript, session_id: "s-limit" });
		evaluateHookEvent({ hookStdinJson: stop, env });
		evaluateHookEvent({ hookStdinJson: stop, env });
		const snap = loadRollingQuotaSnapshot({ pluginDataDir: dataDir, weeklyBudgets: env.weeklyBudgets, nowMs: Date.now() });
		assert.equal(snap.quotaState, "OVERFLOW_TO_AGY");
		assert.equal(snap.metrics.pools["claude-code-native"].rateLimitHitsInWindow, 1);
	});
});
