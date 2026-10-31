import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadRollingQuotaSnapshot } from "../plugins/claugle/scripts/ledger-store.mjs";
import { parsePluginEnv, parseTaskRequest } from "../plugins/claugle/scripts/policy-engine.mjs";
import {
	buildAgyCliArgs,
	detectProviderHealth,
	evaluateHookEvent,
	executeRoutedTask,
	runHeadlessProvider,
} from "../plugins/claugle/scripts/provider-runner.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugins/claugle");
const TOOL_CATEGORIES = ["write_file", "command", "browser", "mcp", "subagent", "url", "read_url"];

const createdDirs = [];
after(() => {
	for (const dir of createdDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	createdDirs.push(dir);
	return dir;
}

function git(dir, ...args) {
	return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function makeRepo() {
	const repo = tmp("claugle-rt-repo-");
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "t@t");
	git(repo, "config", "user.name", "t");
	fs.mkdirSync(path.join(repo, "docs"));
	fs.mkdirSync(path.join(repo, "pkg"));
	fs.writeFileSync(path.join(repo, "docs", "guide.md"), "line 1\nline 2\nline 3\n");
	fs.writeFileSync(path.join(repo, "pkg", "a.txt"), "a\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "init");
	return repo;
}

// A stand-in for agy. It honors deny rules the way real agy does (`<category>(*)` matches every
// target and `write_file(<dir>)` matches paths under dir), logs each call, then runs `behavior`.
function stubAgy(behavior) {
	const dir = tmp("claugle-rt-bin-");
	const file = path.join(dir, "agy");
	fs.writeFileSync(
		file,
		`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const model = flag("--model");
const mode = flag("--mode");
const deny = (JSON.parse(flag("--settings") || "{}").permissions || {}).deny || [];
const allowed = (category, target) =>
	!deny.includes(category + "(*)") &&
	!deny.some((rule) => rule.startsWith(category + "(/") && (target + "/").startsWith(rule.slice(category.length + 1, -1) + "/"));
let stdin = "";
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
	const prompt = JSON.parse(stdin.split("\\n")[0]).message.content;
	fs.appendFileSync(path.join(__dirname, "calls.jsonl"), JSON.stringify({ model, mode, cwd: process.cwd(), deny, prompt }) + "\\n");
	const write = (file, text) => { if (allowed("write_file", path.resolve(file))) fs.writeFileSync(file, text); };
	const reply = (response) => process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", response, usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } }) + "\\n");
	${behavior}
});
`,
		{ mode: 0o755 }
	);
	const calls = () =>
		fs.existsSync(path.join(dir, "calls.jsonl"))
			? fs.readFileSync(path.join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
			: [];
	return { file, dir, calls };
}

function shellStub(body) {
	const dir = tmp("claugle-rt-sh-");
	const file = path.join(dir, "agy");
	fs.writeFileSync(file, `#!/bin/bash\nDIR="${dir}"\n${body}\n`, { mode: 0o755 });
	return { file, dir };
}

function envFor(cwd, agyPath, dataDir = tmp("claugle-rt-data-")) {
	const res = parsePluginEnv({
		CLAUDE_PLUGIN_DATA: dataDir,
		CLAUDE_PROJECT_DIR: cwd,
		CLAUDE_SESSION_ID: "rt",
		CLAUGLE_AGY_BIN: agyPath,
		CLAUGLE_GEMINI_BIN: "/nonexistent/gemini",
	});
	assert.equal(res.kind, "ok", res.message);
	return res.value;
}

async function runTask(cwd, agyPath, request, { env = envFor(cwd, agyPath), nowMs } = {}) {
	const req = parseTaskRequest({ cwd, ...request });
	assert.equal(req.kind, "ok", req.message);
	return executeRoutedTask({ request: req.value, env, ...(nowMs ? { nowMs } : {}) });
}

// A killed process stays visible as a zombie until it is reaped, so a zombie counts as gone.
function isAlive(pid) {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	try {
		return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
	} catch {
		return true;
	}
}

async function exitsWithin(pid, ms) {
	const deadline = Date.now() + ms;
	while (isAlive(pid)) {
		if (Date.now() > deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return true;
}

function settleWithin(promise, ms) {
	return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve("still pending"), ms))]);
}

describe("R1. delegated agy runs are bound by deny rules", () => {
	it("a read-only run cannot write, and every run denies commands, browser, MCP, subagents and URLs", async () => {
		const repo = makeRepo();
		const agy = stubAgy(`write("agy-wrote.txt", "agy wrote this\\n"); reply("ok");`);

		const review = await runTask(repo, agy.file, { prompt: "Review this diff for bugs", explicitTaskKind: "review" });
		assert.equal(review.status, "COMPLETED");
		assert.equal(fs.existsSync(path.join(repo, "agy-wrote.txt")), false, "a plan-mode run wrote into the host repo");

		const edit = await runTask(repo, agy.file, {
			prompt: "Update the docs",
			explicitTaskKind: "docs",
			allowFileEdits: true,
		});
		assert.equal(edit.worktreeOutcome?.kind, "applied-to-host");
		assert.equal(fs.readFileSync(path.join(repo, "agy-wrote.txt"), "utf8"), "agy wrote this\n");

		const [planCall, editCall] = agy.calls();
		const deniedIn = (call) => TOOL_CATEGORIES.filter((c) => call.deny.includes(`${c}(*)`));
		assert.deepEqual(deniedIn(planCall), TOOL_CATEGORIES);
		assert.deepEqual(deniedIn(editCall), TOOL_CATEGORIES.filter((c) => c !== "write_file"));
	});
});

describe("R1b. edit runs cannot write outside their worktree", () => {
	it("cannot write straight into the host repository", async () => {
		const repo = makeRepo();
		const agy = stubAgy(`
const host = path.dirname(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim());
write(path.join(host, "direct.txt"), "skipped the glob check\\n");
write("docs/guide.md", "line 1\\nchanged\\nline 3\\n");
reply("ok");`);
		const out = await runTask(repo, agy.file, {
			prompt: "Update the docs",
			explicitTaskKind: "docs",
			allowFileEdits: true,
			allowedEditGlobs: ["docs/**"],
		});
		assert.equal(fs.existsSync(path.join(repo, "direct.txt")), false, "agy wrote into the host repo directly");
		assert.equal(out.worktreeOutcome?.kind, "applied-to-host");
	});

	it("denies the temp dir, which agy writes without asking, unless the worktree lives there", () => {
		const denyFor = (cwd) => {
			const args = buildAgyCliArgs({ prompt: "x", modelSlug: "gemini-3.8-flash-low", mode: "accept-edits", cwd, hostRepoRoot: "/home/u/project" });
			return args.includes("--settings") ? JSON.parse(args[args.indexOf("--settings") + 1]).permissions.deny : [];
		};
		const home = denyFor("/home/u/.claude/plugins/data/claugle/worktrees/task-1/pkg");
		assert.ok(home.includes("write_file(/tmp)"));
		assert.ok(home.includes("write_file(/home/u/project)"));
		assert.ok(!denyFor("/tmp/data/worktrees/task-1").includes("write_file(/tmp)"), "would also deny the worktree itself");
	});
});

describe("R2. edits requested from a repo subfolder", () => {
	it("run agy in the matching worktree subfolder and apply relative to that subfolder", async () => {
		const repo = makeRepo();
		const agy = stubAgy(`write("note.txt", "from agy\\n"); reply("ok");`);
		const out = await runTask(path.join(repo, "pkg"), agy.file, {
			prompt: "Add a note",
			explicitTaskKind: "docs",
			allowFileEdits: true,
			allowedEditGlobs: ["*.txt"],
		});
		assert.equal(out.worktreeOutcome?.kind, "applied-to-host");
		assert.deepEqual(out.worktreeOutcome.modifiedFiles, ["note.txt"]);
		assert.equal(fs.readFileSync(path.join(repo, "pkg", "note.txt"), "utf8"), "from agy\n");
		assert.equal(fs.existsSync(path.join(repo, "note.txt")), false);
	});

	it("treat a change outside the subfolder as a glob violation and leave the host untouched", async () => {
		const repo = makeRepo();
		const agy = stubAgy(`
const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
write(path.join(top, "outside.txt"), "escaped\\n");
write("inside.txt", "fine\\n");
reply("ok");`);
		const out = await runTask(path.join(repo, "pkg"), agy.file, {
			prompt: "Add a note",
			explicitTaskKind: "docs",
			allowFileEdits: true,
		});
		assert.equal(out.worktreeOutcome?.kind, "rejected-glob-violation");
		assert.deepEqual(out.worktreeOutcome.violatingFiles, ["../outside.txt"]);
		assert.equal(out.status, "FAILED");
		assert.equal(fs.existsSync(path.join(repo, "outside.txt")), false);
		assert.equal(fs.existsSync(path.join(repo, "pkg", "inside.txt")), false);
	});
});

describe("R3. applying edits to the host", () => {
	it("changes the working tree only and leaves the host index untouched", async () => {
		const repo = makeRepo();
		const agy = stubAgy(`write("docs/guide.md", "line 1\\nchanged\\nline 3\\n"); reply("ok");`);
		const out = await runTask(repo, agy.file, { prompt: "Update the docs", explicitTaskKind: "docs", allowFileEdits: true });
		assert.equal(out.worktreeOutcome?.kind, "applied-to-host");
		assert.equal(fs.readFileSync(path.join(repo, "docs", "guide.md"), "utf8"), "line 1\nchanged\nline 3\n");
		assert.equal(git(repo, "diff", "--cached", "--name-only"), "", "host index must stay as the user left it");
		assert.equal(git(repo, "status", "--porcelain"), " M docs/guide.md\n");
	});
});

describe("R4. provider timeouts", () => {
	it("kill an agy that ignores SIGTERM, together with its children, and resolve promptly", async () => {
		const stub = shellStub(`trap '' TERM\necho $$ > "$DIR/agy.pid"\nsleep 30 &\necho $! > "$DIR/child.pid"\nwait`);
		const started = Date.now();
		const run = runHeadlessProvider({
			provider: "agy",
			binaryPath: stub.file,
			prompt: "x",
			modelSlug: "gemini-3.8-flash-low",
			effort: "low",
			cwd: stub.dir,
			timeoutMs: 300,
		});
		try {
			const res = await settleWithin(run, 5_000);
			assert.notEqual(res, "still pending", "runner did not resolve within 5s of a 300ms timeout");
			assert.equal(res.reason, "TIMEOUT");
			assert.ok(Date.now() - started < 5_000);
			for (const name of ["agy.pid", "child.pid"]) {
				const pid = Number(fs.readFileSync(path.join(stub.dir, name), "utf8"));
				assert.equal(await exitsWithin(pid, 2_000), true, `${name} survived the timeout`);
			}
		} finally {
			for (const name of ["agy.pid", "child.pid"]) {
				try {
					process.kill(Number(fs.readFileSync(path.join(stub.dir, name), "utf8")), "SIGKILL");
				} catch {}
			}
		}
	});

	it("resolve with the result when agy exits but a leftover child still holds its stdout", async () => {
		const stub = shellStub(
			`sleep 30 &\necho $! > "$DIR/child.pid"\necho '{"event":"result","result":{"status":"SUCCESS","response":"done","usage":{"total_tokens":1}}}'\nexit 0`
		);
		const run = runHeadlessProvider({
			provider: "agy",
			binaryPath: stub.file,
			prompt: "x",
			modelSlug: "gemini-3.8-flash-low",
			effort: "low",
			cwd: stub.dir,
			timeoutMs: 20_000,
		});
		const childPid = () => Number(fs.readFileSync(path.join(stub.dir, "child.pid"), "utf8"));
		try {
			const res = await settleWithin(run, 5_000);
			assert.notEqual(res, "still pending", "runner waited on a pipe held by an orphaned child");
			assert.equal(res.kind, "success");
			assert.equal(res.payload.response, "done");
			assert.equal(await exitsWithin(childPid(), 2_000), true, "the orphaned child was left running");
		} finally {
			try {
				process.kill(childPid(), "SIGKILL");
			} catch {}
		}
	});
});

describe("R5. circuit breaker", () => {
	const quotaOnSonnet = `if (model === "claude-sonnet-5-5-high") { process.stderr.write("Error: QUOTA_EXHAUSTED for " + model + "\\n"); process.exit(1); } reply("answered by " + model);`;

	it("stops calling an exhausted pool until its exhaustion window passes, while other pools keep serving", async () => {
		const repo = makeRepo();
		const agy = stubAgy(quotaOnSonnet);
		const env = envFor(repo, agy.file);
		const t0 = Date.now();
		const review = { prompt: "Review this diff for bugs", explicitTaskKind: "review" };

		const first = await runTask(repo, agy.file, review, { env, nowMs: t0 });
		assert.equal(first.responseText, "answered by gemini-4-argon-high");
		const second = await runTask(repo, agy.file, review, { env, nowMs: t0 + 1_000 });
		assert.equal(second.responseText, "answered by gemini-4-argon-high");
		assert.deepEqual(
			agy.calls().map((c) => c.model),
			["claude-sonnet-5-5-high", "gemini-4-argon-high", "gemini-4-argon-high"],
			"the exhausted model was called again inside the cooldown"
		);

		await runTask(repo, agy.file, review, { env, nowMs: t0 + 6 * 60 * 1000 });
		assert.equal(agy.calls()[3].model, "gemini-4-argon-high", "an exhausted quota outlasts the circuit cooldown");
		await runTask(repo, agy.file, review, { env, nowMs: t0 + 5 * 60 * 60 * 1000 + 60_000 });
		assert.equal(agy.calls()[4].model, "claude-sonnet-5-5-high", "the pool is tried again once the exhaustion window passes");
	});

	it("reports the provider unavailable once every pool it serves is rate limited", async () => {
		const repo = makeRepo();
		const agy = stubAgy(`process.stderr.write("HTTP 429 Too Many Requests\\n"); process.exit(1);`);
		const env = envFor(repo, agy.file);
		const t0 = Date.now();
		await runTask(repo, agy.file, { prompt: "Review this diff", explicitTaskKind: "review" }, { env, nowMs: t0 });
		assert.equal(detectProviderHealth(env, t0 + 1_000).agy.kind, "circuit-open");

		const callsBefore = agy.calls().length;
		const next = await runTask(repo, agy.file, { prompt: "Review this diff", explicitTaskKind: "review" }, { env, nowMs: t0 + 2_000 });
		assert.equal(agy.calls().length, callsBefore, "agy was called while its circuit was open");
		assert.ok(next.plan.skippedCandidates.some((s) => s.skipReason === "CIRCUIT_OPEN"));
		assert.equal(detectProviderHealth(env, t0 + 6 * 60 * 1000).agy.kind, "healthy");
	});
});

describe("R6. failed delegation", () => {
	it("hands the task back to Claude after every external candidate fails", async () => {
		const repo = makeRepo();
		const agy = stubAgy(`process.stderr.write("agy crashed\\n"); process.exit(3);`);
		const out = await runTask(repo, agy.file, { prompt: "Review this diff", explicitTaskKind: "review" });
		assert.equal(out.status, "DELEGATE_TO_HOST");
		assert.deepEqual(
			out.attemptedTargets.map((t) => t.provider),
			["agy", "agy", "claude-native"],
			"external candidates must be tried before handing back"
		);
		assert.match(out.responseText, /agy crashed/);
	});
});

describe("R7. repositories without commits", () => {
	it("refuse edit candidates with a clear error instead of crashing", async () => {
		const repo = tmp("claugle-rt-empty-");
		git(repo, "init", "-q");
		const agy = stubAgy(`write("x.txt", "x"); reply("ok");`);
		const out = await runTask(repo, agy.file, { prompt: "Update the docs", explicitTaskKind: "docs", allowFileEdits: true });
		assert.notEqual(out.status, "COMPLETED");
		assert.match(out.responseText, /no commits/i);
		assert.equal(agy.calls().length, 0, "agy must not run without an isolated worktree");
		assert.deepEqual(fs.readdirSync(repo), [".git"]);
	});
});

describe("R8. SessionStart environment", () => {
	it("does not point nested claude processes at the gateway", () => {
		const data = tmp("claugle-rt-data-");
		const envFile = path.join(data, "claude.env");
		evaluateHookEvent({
			hookStdinJson: JSON.stringify({ hook_event_name: "SessionStart" }),
			env: { CLAUDE_PLUGIN_DATA: data, CLAUDE_PROJECT_DIR: data, CLAUDE_ENV_FILE: envFile },
		});
		const written = fs.readFileSync(envFile, "utf8");
		assert.match(written, /CLAUDE_PLUGIN_DATA=/);
		assert.doesNotMatch(written, /ANTHROPIC_BASE_URL/);
	});
});

describe("R9. Stop hook records native Claude Code usage", () => {
	function assistantLine(id, model, usage, timestamp = new Date().toISOString()) {
		return `${JSON.stringify({ type: "assistant", timestamp, message: { id, model, role: "assistant", usage, content: [] } })}\n`;
	}
	const usage = { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 5000, output_tokens: 30 };

	function runStopHook(data, payload) {
		const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8")).hooks;
		assert.ok(hooks.Stop, "hooks.json registers no Stop hook");
		const [{ command, timeout }] = hooks.Stop.flatMap((group) => group.hooks);
		const started = Date.now();
		const res = spawnSync("sh", ["-c", command], {
			input: JSON.stringify(payload),
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_PLUGIN_DATA: data, CLAUGLE_SKIP_GATEWAY_AUTOSTART: "1" },
		});
		assert.equal(res.status, 0, res.stderr);
		assert.ok(Date.now() - started < (timeout * 1000) / 3, "Stop hook ran too close to its timeout");
		return JSON.parse(res.stdout);
	}

	const native = (data) => loadRollingQuotaSnapshot({ pluginDataDir: data }).metrics.pools["claude-code-native"];

	it("appends one event per new native assistant message, skips gateway models, and is idempotent", () => {
		const data = tmp("claugle-rt-data-");
		const projects = tmp("claugle-rt-transcripts-");
		const transcript = path.join(projects, "sess-1.jsonl");
		fs.writeFileSync(
			transcript,
			`${JSON.stringify({ type: "user", message: { role: "user", content: "hi" } })}\n` +
				assistantLine("msg_native_1", "claude-opus-5-5", usage) +
				assistantLine("msg_native_1", "claude-opus-5-5", usage) +
				assistantLine("msg_gw_1", "gemini-4-argon-high", usage) +
				assistantLine("msg_gw_2", "claugle-auto", usage) +
				assistantLine("msg_synth", "<synthetic>", { input_tokens: 0, output_tokens: 0 })
		);
		const pending = assistantLine("msg_native_2", "claude-sonnet-5-5", { input_tokens: 1, output_tokens: 9 });
		fs.appendFileSync(transcript, pending.slice(0, 40));
		const subagents = path.join(projects, "sess-1", "subagents");
		fs.mkdirSync(subagents, { recursive: true });
		fs.writeFileSync(path.join(subagents, "agent-a1.jsonl"), assistantLine("msg_sub_1", "claude-opus-5-5", { input_tokens: 4, output_tokens: 6 }));

		const payload = { hook_event_name: "Stop", session_id: "sess-1", transcript_path: transcript, stop_hook_active: false };
		const out = runStopHook(data, payload);
		assert.notEqual(out.decision, "block");
		assert.equal(native(data).requestCount, 2, "expected msg_native_1 and the subagent message");
		assert.equal(native(data).consumedTokens, 240 + 10);

		runStopHook(data, payload);
		assert.equal(native(data).requestCount, 2, "a second Stop must not double count");
		assert.equal(native(data).consumedTokens, 250);

		fs.appendFileSync(transcript, pending.slice(40));
		runStopHook(data, payload);
		assert.equal(native(data).requestCount, 3);
		assert.equal(native(data).consumedTokens, 260);
	});
});

describe("R10. context files", () => {
	it("are read only when their real path stays inside the task cwd", async () => {
		const cwd = tmp("claugle-rt-cwd-");
		const outside = tmp("claugle-rt-secret-");
		fs.writeFileSync(path.join(cwd, "inside.txt"), "INSIDE-CONTENT\n");
		fs.writeFileSync(path.join(outside, "secret.txt"), "SECRET-CONTENT\n");
		fs.symlinkSync(path.join(outside, "secret.txt"), path.join(cwd, "link.txt"));
		fs.symlinkSync(outside, path.join(cwd, "ext"));
		const agy = stubAgy(`reply("ok");`);
		const request = {
			taskId: "task-1-abcdef",
			prompt: "Review these files",
			explicitTaskKind: "review",
			cwd,
			contextFiles: ["inside.txt", "link.txt", "ext/secret.txt", path.join(outside, "secret.txt")],
			allowFileEdits: false,
			allowedEditGlobs: ["**/*"],
			applyStrategy: "patch-if-clean",
		};
		const out = await executeRoutedTask({ request, env: envFor(cwd, agy.file) });
		assert.equal(out.status, "COMPLETED");
		const { prompt } = agy.calls()[0];
		assert.match(prompt, /INSIDE-CONTENT/);
		assert.doesNotMatch(prompt, /SECRET-CONTENT/, "a context file outside the cwd reached the model");
	});
});

describe("R11. more runner and sandbox defects", () => {
	const run = (stub) =>
		runHeadlessProvider({
			provider: "agy",
			binaryPath: stub.file,
			prompt: "x",
			modelSlug: "gemini-3.8-flash-low",
			effort: "low",
			cwd: stub.dir,
			timeoutMs: 10_000,
		});
	const textEvent = (text) =>
		JSON.stringify({ event: "step_update", step_update: { state: "DONE", step_type: "agent_response", text_delta: text } });

	it("does not classify a failure from the model's own words", async () => {
		const modelText = textEvent("Return HTTP 429 when the rate limit is hit and 401 when the token is missing; quota exhausted is a 403.");
		const crashed = await run(shellStub(`echo '${modelText}'\necho 'agy: internal error' >&2\nexit 1`));
		assert.equal(crashed.reason, "NON_ZERO_EXIT");
		const truncated = await run(shellStub(`echo '${modelText}'\nexit 0`));
		assert.equal(truncated.reason, "MALFORMED_JSON");
	});

	it("recognizes agy's own quota messages", async () => {
		for (const message of ["You have exhausted your quota on this model.", "individual quota reached"]) {
			const res = await run(shellStub(`echo '${message}' >&2\nexit 1`));
			assert.equal(res.reason, "QUOTA_EXHAUSTED", message);
		}
	});

	it("keeps multi-byte characters that straddle two stdout chunks", async () => {
		const stub = stubAgy(`
const line = Buffer.from(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "한국어 응답", usage: {} } }) + "\\n");
const cut = line.indexOf(Buffer.from("국")) + 1;
process.stdout.write(line.subarray(0, cut));
setTimeout(() => process.stdout.write(line.subarray(cut)), 100);`);
		const res = await run(stub);
		assert.equal(res.kind, "success");
		assert.equal(res.payload.response, "한국어 응답");
	});

	it("does not let a rewritten worktree .git file point claugle's git at another repository", async () => {
		const repo = makeRepo();
		const victim = makeRepo();
		const agy = stubAgy(`
write(".git", "gitdir: ${victim}/.git\\n");
write("docs/guide.md", "line 1\\nchanged\\nline 3\\n");
reply("ok");`);
		const out = await runTask(repo, agy.file, { prompt: "Update the docs", explicitTaskKind: "docs", allowFileEdits: true });
		assert.equal(git(victim, "status", "--porcelain"), "", "claugle staged files into a different repository");
		assert.equal(out.worktreeOutcome?.kind, "applied-to-host");
		assert.equal(fs.readFileSync(path.join(repo, "docs", "guide.md"), "utf8"), "line 1\nchanged\nline 3\n");
	});

	it("builds a real patch when the user configured diff.external", async () => {
		const repo = makeRepo();
		const differ = path.join(tmp("claugle-rt-differ-"), "difft");
		fs.writeFileSync(differ, "#!/bin/sh\necho 'side-by-side view, not a patch'\n", { mode: 0o755 });
		git(repo, "config", "diff.external", differ);
		const agy = stubAgy(`write("docs/guide.md", "line 1\\nchanged\\nline 3\\n"); reply("ok");`);
		const out = await runTask(repo, agy.file, { prompt: "Update the docs", explicitTaskKind: "docs", allowFileEdits: true });
		assert.equal(out.worktreeOutcome?.kind, "applied-to-host");
		assert.equal(fs.readFileSync(path.join(repo, "docs", "guide.md"), "utf8"), "line 1\nchanged\nline 3\n");
	});

	it("reports a git failure while harvesting as a failed task instead of throwing", async () => {
		const repo = makeRepo();
		git(repo, "branch", "claugle");
		const agy = stubAgy(`write("docs/guide.md", "line 1\\nchanged\\nline 3\\n"); reply("ok");`);
		const env = envFor(repo, agy.file);
		const out = await runTask(
			repo,
			agy.file,
			{ prompt: "Update the docs", explicitTaskKind: "docs", allowFileEdits: true, applyStrategy: "branch-only" },
			{ env }
		);
		assert.equal(out.status, "FAILED");
		assert.match(out.responseText, /cannot lock ref/);
		const pool = loadRollingQuotaSnapshot({ pluginDataDir: env.pluginDataDir }).metrics.pools["agy-gemini-pool"];
		assert.equal(pool.requestCount, 1, "the tokens agy spent must still reach the ledger");
	});

	it("applies edits to files with non-ASCII names inside the allowed globs", async () => {
		const repo = makeRepo();
		fs.writeFileSync(path.join(repo, "docs", "가이드.md"), "원본\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "ko");
		const agy = stubAgy(`write("docs/가이드.md", "수정됨\\n"); reply("ok");`);
		const out = await runTask(repo, agy.file, {
			prompt: "Update the docs",
			explicitTaskKind: "docs",
			allowFileEdits: true,
			allowedEditGlobs: ["docs/**"],
		});
		assert.equal(out.worktreeOutcome?.kind, "applied-to-host");
		assert.deepEqual(out.worktreeOutcome.modifiedFiles, ["docs/가이드.md"]);
		assert.equal(fs.readFileSync(path.join(repo, "docs", "가이드.md"), "utf8"), "수정됨\n");
	});

	it("never runs a repository hook the model rewrote while preserving its edits", async () => {
		const repo = makeRepo();
		fs.mkdirSync(path.join(repo, ".githooks"));
		fs.writeFileSync(path.join(repo, ".githooks", "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "hooks");
		git(repo, "config", "core.hooksPath", ".githooks");
		const marker = path.join(tmp("claugle-rt-marker-"), "hook-ran");
		const agy = stubAgy(`write(".githooks/pre-commit", "#!/bin/sh\\ntouch ${marker}\\n"); write("docs/guide.md", "x\\n"); reply("ok");`);
		const out = await runTask(repo, agy.file, {
			prompt: "Update the docs",
			explicitTaskKind: "docs",
			allowFileEdits: true,
			applyStrategy: "branch-only",
		});
		assert.equal(out.worktreeOutcome?.kind, "preserved-on-branch");
		assert.equal(fs.existsSync(marker), false, "claugle executed a hook script written by the model");
	});

	it("says so in the response text when edits were preserved on a branch instead of applied", async () => {
		const repo = makeRepo();
		fs.writeFileSync(path.join(repo, "docs", "guide.md"), "line 1\nhost edit\nline 3\n");
		const agy = stubAgy(`write("docs/guide.md", "line 1\\nagy edit\\nline 3\\n"); reply("I updated docs/guide.md.");`);
		const out = await runTask(repo, agy.file, { prompt: "Update the docs", explicitTaskKind: "docs", allowFileEdits: true });
		assert.equal(out.worktreeOutcome?.kind, "preserved-on-branch");
		assert.match(out.responseText, /not applied/i);
		assert.ok(out.responseText.includes(out.worktreeOutcome.branchName));
		assert.equal(fs.readFileSync(path.join(repo, "docs", "guide.md"), "utf8"), "line 1\nhost edit\nline 3\n");
	});
});

describe("R11b. a run headless agy stopped early", () => {
	it("is not reported as completed, and its partial edits are discarded", async () => {
		const repo = makeRepo();
		const agy = stubAgy(`
write("docs/guide.md", "half done\\n");
process.stderr.write('jetski: no output produced — a tool required the "write_file" permission that headless mode cannot prompt for, so it was auto-denied.\\n');
process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "", usage: { input_tokens: 12866, output_tokens: 34, total_tokens: 12900 }, denied_actions: [{ action: "write_file", display_name: "WriteFile" }] } }) + "\\n");`);
		const env = envFor(repo, agy.file);
		const out = await runTask(repo, agy.file, { prompt: "Update the docs", explicitTaskKind: "docs", allowFileEdits: true }, { env });
		assert.notEqual(out.status, "COMPLETED");
		assert.match(out.responseText, /no output produced/);
		assert.equal(fs.readFileSync(path.join(repo, "docs", "guide.md"), "utf8"), "line 1\nline 2\nline 3\n");
		const pool = loadRollingQuotaSnapshot({ pluginDataDir: env.pluginDataDir }).metrics.pools["agy-gemini-pool"];
		assert.equal(pool.consumedTokens, 12900, "the tokens agy spent must still reach the ledger");
	});
});
