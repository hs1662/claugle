import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { parsePluginEnv, parseTaskRequest } from "../plugins/claugle/scripts/policy-engine.mjs";
import { buildAgyCliArgs, executeRoutedTask } from "../plugins/claugle/scripts/provider-runner.mjs";

const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

function gitRepo(files = {}) {
	const repo = tmp("claugle-iso-repo-");
	const git = (...a) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" });
	git("init", "-q");
	for (const [rel, body] of Object.entries({ "README.md": "hi\n", ...files })) {
		fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
		fs.writeFileSync(path.join(repo, rel), body);
	}
	git("add", "-A");
	git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
	return repo;
}

function stubAgy(body) {
	const file = path.join(tmp("claugle-iso-bin-"), "agy");
	fs.writeFileSync(
		file,
		`#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const a = process.argv.slice(2);
const addDirs = a.flatMap((v, i) => (a[i - 1] === "--add-dir" ? [v] : []));
fs.appendFileSync(__filename + ".starts", "x");
const record = (value) => fs.writeFileSync(__filename + ".record", JSON.stringify(value));
const reply = (response) => process.stdout.write(JSON.stringify({ response, usage: {} }) + "\\n");
process.stdin.resume();
process.stdin.on("end", () => {
${body}
});
`,
		{ mode: 0o755 }
	);
	return { file, started: () => fs.existsSync(`${file}.starts`), recorded: () => JSON.parse(fs.readFileSync(`${file}.record`, "utf8")) };
}

const envFor = (repo, agy) =>
	parsePluginEnv({ CLAUDE_PLUGIN_DATA: tmp("claugle-iso-data-"), CLAUDE_PROJECT_DIR: repo, CLAUGLE_AGY_BIN: agy, CLAUGLE_GEMINI_BIN: "/nonexistent/gemini" }).value;

const AGY_PERMISSION_ACTIONS = ["command", "read_file", "write_file", "read_url", "mcp", "execute_url", "unsandboxed"];

describe("agy gets only deny rules it accepts", () => {
	it("every deny entry names an action agy accepts, in plan and accept-edits modes", () => {
		for (const mode of ["plan", "accept-edits"]) {
			const args = buildAgyCliArgs({ prompt: "x", modelSlug: "gemini-3.8-flash-low", mode, cwd: os.tmpdir(), hostRepoRoot: "/home/u/project" });
			const deny = JSON.parse(args[args.indexOf("--settings") + 1]).permissions.deny;
			assert.ok(deny.includes("command(*)"), `${mode}: ${JSON.stringify(deny)}`);
			assert.deepEqual(deny.filter((entry) => !AGY_PERMISSION_ACTIONS.includes(entry.slice(0, entry.indexOf("(")))), [], mode);
		}
	});
});

describe("edit runs cannot plant agy customizations in the host repo", () => {
	it("the gate denies writes into every agy customization folder, and the harvest rejects them when written anyway", async () => {
		const planted = [".agent/hooks.json", "_agents/x", "_agent/x"];
		const repo = gitRepo();
		const agy = stubAgy(`
const gate = path.join(addDirs[0], ".agents");
const ask = (rel) => JSON.parse(cp.execFileSync(process.execPath, ["tool-gate.cjs"], { cwd: gate, input: JSON.stringify({ toolCall: { name: "write_to_file", args: { TargetFile: path.join(process.cwd(), rel), CodeContent: "{}" } } }) })).decision;
const verdicts = Object.fromEntries(["notes.txt", ...${JSON.stringify(planted)}].map((rel) => [rel, ask(rel)]));
for (const rel of ${JSON.stringify(planted)}) {
	fs.mkdirSync(path.dirname(rel), { recursive: true });
	fs.writeFileSync(rel, "{}");
}
record(verdicts);
reply("done");`);
		const out = await executeRoutedTask({ request: parseTaskRequest({ prompt: "tidy the readme", explicitTaskKind: "docs", allowFileEdits: true, cwd: repo }).value, env: envFor(repo, agy.file) });
		assert.deepEqual(agy.recorded(), { "notes.txt": "allow", ".agent/hooks.json": "deny", "_agents/x": "deny", "_agent/x": "deny" });
		assert.equal(out.worktreeOutcome?.kind, "rejected-glob-violation");
		assert.deepEqual([...out.worktreeOutcome.violatingFiles].sort(), [...planted].sort());
		for (const rel of planted) assert.equal(fs.existsSync(path.join(repo, rel)), false, rel);
	});
});

describe("agy never starts where any agy customization folder would run commands", () => {
	const hook = JSON.stringify({ x: { SessionStart: [{ type: "command", command: "true" }] } });
	const cases = {
		".agent/hooks.json": { ".agent/hooks.json": hook },
		"_agents/hooks.json": { "_agents/hooks.json": hook },
		"_agent/mcp_config.json": { "_agent/mcp_config.json": JSON.stringify({ mcpServers: { x: { command: "true" } } }) },
		".agents/plugins.json": { ".agents/plugins.json": JSON.stringify({ entries: [{ path: "tools/plug" }] }), "tools/plug/kit/plugin.json": "{}", "tools/plug/kit/hooks.json": hook },
	};
	for (const [name, files] of Object.entries(cases)) {
		it(`hands a read run back to the host when the repo has ${name}`, async () => {
			const repo = gitRepo(files);
			const agy = stubAgy(`reply("AGY_STARTED");`);
			const out = await executeRoutedTask({ request: parseTaskRequest({ prompt: "Review this diff", explicitTaskKind: "review", cwd: repo }).value, env: envFor(repo, agy.file) });
			assert.equal(out.status, "DELEGATE_TO_HOST", out.responseText);
			assert.equal(agy.started(), false);
		});
	}

	it("starts agy in a repo whose agy folders hold only rules and skills", async () => {
		const repo = gitRepo({ ".agent/rules/style.md": "x\n", "_agents/skills/s/SKILL.md": "x\n" });
		const agy = stubAgy(`reply("AGY_STARTED");`);
		const out = await executeRoutedTask({ request: parseTaskRequest({ prompt: "Review this diff", explicitTaskKind: "review", cwd: repo }).value, env: envFor(repo, agy.file) });
		assert.equal(out.status, "COMPLETED", out.responseText);
		assert.equal(agy.started(), true);
	});
});
