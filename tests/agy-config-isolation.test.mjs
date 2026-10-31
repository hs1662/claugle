import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { startAnthropicGatewayServer } from "../plugins/claugle/scripts/anthropic-gateway.mjs";
import { parsePluginEnv, parseTaskRequest } from "../plugins/claugle/scripts/policy-engine.mjs";
import { buildAgyCliArgs, executeRoutedTask, prepareAgyHome } from "../plugins/claugle/scripts/provider-runner.mjs";

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

const TOKEN = ".gemini/antigravity-cli/antigravity-oauth-token";
const AGY_GLOBAL_CUSTOMIZATIONS = [
	".gemini/GEMINI.md",
	".gemini/AGENTS.md",
	".gemini/config/GEMINI.md",
	".gemini/config/AGENTS.md",
	".gemini/config/rules/r.md",
	".gemini/config/skills/s/SKILL.md",
	".gemini/config/skills.json",
	".gemini/config/rules.json",
	".gemini/config/plugins.json",
	".gemini/config/agents.json",
	".gemini/config/workflows/w.md",
	".gemini/config/global_workflows/w.md",
	".gemini/config/sidecars/s/sidecar.json",
	".gemini/antigravity-cli/hooks.json",
	".gemini/config/plugins/p/plugin.json",
	".gemini/config/mcp_config.json",
	".gemini/config/hooks.json",
	".gemini/config/config.json",
];

function fakeRealHome() {
	const home = tmp("claugle-iso-realhome-");
	for (const rel of [TOKEN, ".gitconfig", ".gemini/config/.migrated", ...AGY_GLOBAL_CUSTOMIZATIONS]) {
		fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
		fs.writeFileSync(path.join(home, rel), rel === TOKEN ? "token" : "x");
	}
	return home;
}

function snapshot(root) {
	const out = {};
	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			const rel = path.relative(root, full);
			if (entry.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(full)}`;
			else if (entry.isDirectory()) {
				out[rel] = "dir";
				walk(full);
			} else out[rel] = `file:${fs.readFileSync(full, "base64")}`;
		}
	};
	walk(root);
	return out;
}

const linksIn = (root) => Object.entries(snapshot(root)).filter(([, v]) => v.startsWith("link:")).map(([rel]) => rel);

describe("agy runs in a home that carries only the login token", () => {
	it("exposes the token and none of agy's global rules, skills, plugins, hooks or MCP servers", () => {
		const real = fakeRealHome();
		const home = prepareAgyHome(tmp("claugle-iso-data-"), real);
		for (const rel of [...AGY_GLOBAL_CUSTOMIZATIONS, ".gitconfig"]) assert.equal(fs.existsSync(path.join(home, rel)), false, rel);
		assert.equal(fs.realpathSync(path.join(home, TOKEN)), path.join(real, TOKEN));
		assert.equal(fs.readFileSync(path.join(home, ".gemini/config/.migrated"), "utf8"), "");
		assert.deepEqual(linksIn(home), [TOKEN]);
	});

	it("converges a home the old mirror left behind and never changes the real home", () => {
		const real = fakeRealHome();
		const before = snapshot(real);
		const data = tmp("claugle-iso-data-");
		const home = path.join(data, "agy-home");
		fs.mkdirSync(path.join(home, ".gemini", "config"), { recursive: true });
		fs.symlinkSync(path.join(real, ".gitconfig"), path.join(home, ".gitconfig"));
		fs.symlinkSync(path.join(real, ".gemini", "antigravity-cli"), path.join(home, ".gemini", "antigravity-cli"));
		fs.symlinkSync(path.join(real, ".gemini", "GEMINI.md"), path.join(home, ".gemini", "GEMINI.md"));
		for (const name of ["rules", "skills", "skills.json", "plugins.json", "sidecars", ".migrated"]) {
			fs.symlinkSync(path.join(real, ".gemini", "config", name), path.join(home, ".gemini", "config", name));
		}
		fs.symlinkSync(path.join(real, "gone"), path.join(home, ".gemini", "config", "stale"));
		fs.writeFileSync(path.join(home, ".gemini", "config", "config.json"), "agy");
		fs.mkdirSync(path.join(home, ".gemini", "brain", "b1"), { recursive: true });
		fs.writeFileSync(path.join(home, ".gemini", "brain", "b1", "note"), "agy");

		prepareAgyHome(data, real);
		assert.deepEqual(linksIn(home), [TOKEN]);
		assert.equal(fs.lstatSync(path.join(home, ".gemini", "antigravity-cli")).isDirectory(), true);
		assert.equal(fs.readFileSync(path.join(home, TOKEN), "utf8"), "token");
		for (const rel of AGY_GLOBAL_CUSTOMIZATIONS.filter((r) => r !== ".gemini/config/config.json")) assert.equal(fs.existsSync(path.join(home, rel)), false, rel);
		assert.equal(fs.readFileSync(path.join(home, ".gemini", "config", "config.json"), "utf8"), "agy");
		assert.equal(fs.readFileSync(path.join(home, ".gemini", "brain", "b1", "note"), "utf8"), "agy");
		assert.equal(fs.readFileSync(path.join(home, ".gemini/config/.migrated"), "utf8"), "");

		fs.rmSync(path.join(home, TOKEN));
		fs.writeFileSync(path.join(home, TOKEN), "stale copy");
		prepareAgyHome(data, real);
		assert.equal(fs.realpathSync(path.join(home, TOKEN)), path.join(real, TOKEN), "a replaced token link is linked again");
		fs.rmSync(path.join(home, TOKEN));
		prepareAgyHome(data, real);
		assert.equal(fs.realpathSync(path.join(home, TOKEN)), path.join(real, TOKEN), "a missing token link is linked again");

		assert.deepEqual(snapshot(real), before);
	});
});

const gitTop = (dir) => {
	try {
		return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return null;
	}
};

async function gatewayRequest(data, agy) {
	const gw = await startAnthropicGatewayServer({
		port: 0,
		env: { pluginDataDir: data, pluginRoot: path.resolve("plugins/claugle"), projectDir: data, sessionId: "iso", weeklyBudgets: { "claude-code-native": 5e6, "agy-claude-pool": 8e6, "agy-gemini-pool": 15e6, "gemini-cli-pool": 1e7 }, agyBinOverride: agy },
	});
	try {
		const res = await fetch(`${gw.url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gemini-4-argon", messages: [{ role: "user", content: "x" }] }) });
		return { status: res.status, body: await res.json() };
	} finally {
		gw.server.close();
	}
}

describe("the gateway runs agy in a workspace that is its own git repo", () => {
	it("is a git top-level even when the plugin data folder sits inside another git repo", async () => {
		const outer = gitRepo({ ".agents/skills/s/SKILL.md": "x\n" });
		const data = path.join(outer, "plugin-data");
		fs.mkdirSync(data);
		const agy = stubAgy(`record({ cwd: process.cwd(), top: cp.execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim() });
process.stdout.write(JSON.stringify({ response: "ok", usage: {} }) + "\\n");`);
		const res = await gatewayRequest(data, agy.file);
		assert.equal(res.status, 200, JSON.stringify(res.body));
		const seen = agy.recorded();
		assert.equal(seen.cwd, path.join(data, "gateway-workspace"));
		assert.equal(seen.top, seen.cwd);
		assert.equal(gitTop(path.join(data, "gateway-workspace")), path.join(data, "gateway-workspace"));
	});

	it("refuses to start agy when the workspace cannot be made its own git repo", async () => {
		const outer = gitRepo();
		const data = path.join(outer, "plugin-data");
		fs.mkdirSync(path.join(data, "gateway-workspace"), { recursive: true });
		fs.writeFileSync(path.join(data, "gateway-workspace", ".git"), "not a git file\n");
		const agy = stubAgy(`reply("ok");`);
		const res = await gatewayRequest(data, agy.file);
		assert.equal(res.status, 500, JSON.stringify(res.body));
		assert.match(res.body.error.message, /git/);
		assert.equal(agy.started(), false);
	});
});

describe("delegated runs hand agy a gate folder that is its own git repo", () => {
	it("is a git top-level even when the plugin data folder sits inside another git repo", async () => {
		const outer = gitRepo({ ".agents/skills/s/SKILL.md": "x\n" });
		const data = path.join(outer, "plugin-data");
		fs.mkdirSync(data);
		const repo = gitRepo();
		const agy = stubAgy(`record({ root: addDirs[0], top: cp.execFileSync("git", ["-C", addDirs[0], "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim() });
reply("ok");`);
		const env = parsePluginEnv({ CLAUDE_PLUGIN_DATA: data, CLAUDE_PROJECT_DIR: repo, CLAUGLE_AGY_BIN: agy.file, CLAUGLE_GEMINI_BIN: "/nonexistent/gemini" }).value;
		const out = await executeRoutedTask({ request: parseTaskRequest({ prompt: "Review this diff", explicitTaskKind: "review", cwd: repo }).value, env });
		assert.equal(out.status, "COMPLETED", out.responseText);
		const seen = agy.recorded();
		assert.ok(seen.root.startsWith(path.join(data, "agy-gates")), seen.root);
		assert.equal(seen.top, seen.root);
	});

	it("hands the run back to the host when git is missing", async () => {
		const project = tmp("claugle-iso-nogit-");
		const agy = stubAgy(`reply("AGY_STARTED");`);
		const bin = tmp("claugle-iso-path-");
		fs.symlinkSync(process.execPath, path.join(bin, "node"));
		const savedPath = process.env.PATH;
		process.env.PATH = bin;
		let out;
		try {
			out = await executeRoutedTask({ request: parseTaskRequest({ prompt: "Review this diff", explicitTaskKind: "review", cwd: project }).value, env: envFor(project, agy.file) });
		} finally {
			process.env.PATH = savedPath;
		}
		assert.equal(out.status, "DELEGATE_TO_HOST", out.responseText);
		assert.equal(agy.started(), false);
	});
});
