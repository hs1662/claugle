import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { startAnthropicGatewayServer } from "../plugins/claugle/scripts/anthropic-gateway.mjs";
import { parsePluginEnv, parseTaskRequest } from "../plugins/claugle/scripts/policy-engine.mjs";
import { buildAgyCliArgs, executeRoutedTask } from "../plugins/claugle/scripts/provider-runner.mjs";

const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

const agentProbe = (dir) => {
	const file = path.join(dir, "agy");
	fs.writeFileSync(
		file,
		`#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const a = process.argv.slice(2);
const agent = a.includes("--agent") ? a[a.indexOf("--agent") + 1] : null;
const roots = [process.cwd(), ...a.flatMap((v, i) => (a[i - 1] === "--add-dir" ? [v] : []))];
const def = agent && roots.map((r) => path.join(r, ".agents", "agents", agent, "agent.md")).find((f) => fs.existsSync(f));
const body = def ? fs.readFileSync(def, "utf8") : "";
const tools = [...body.matchAll(/^  - (\\S+)$/gm)].map((m) => m[1]);
const namesProject = body.includes(process.cwd());
const front = (body.split("---")[1] ?? "").split("\\n");
const optsOut = ["excludeDefaultComponents: true", "skills: []", "rules: []", "agents: []", "plugins: []"].every((line) => front.includes(line));
process.stdin.resume();
process.stdin.on("end", () => {
  const response = JSON.stringify({ agent, tools, namesProject, optsOut });
  process.stdout.write(JSON.stringify({ response, structured_output: { text: response, tool_calls: [] }, usage: {} }) + "\\n");
});
`,
		{ mode: 0o755 }
	);
	return file;
};

describe("claugle runs agy as a minimal custom agent with only the tools each path needs and none of agy's ambient rules, skills, agents or plugins", () => {
	it("passes --agent to agy and rejects names that are not plain identifiers", () => {
		const args = buildAgyCliArgs({ prompt: "x", modelSlug: "gemini-4-argon-high", effort: "high", mode: "plan", cwd: os.tmpdir(), agent: "claugle-reader" });
		assert.equal(args[args.indexOf("--agent") + 1], "claugle-reader");
		assert.throws(() => buildAgyCliArgs({ prompt: "x", modelSlug: "gemini-4-argon-high", cwd: os.tmpdir(), agent: "../evil" }));
	});

	it("the gateway's agent has only finish", async () => {
		const data = tmp("claugle-agent-data-");
		const agy = agentProbe(data);
		const gw = await startAnthropicGatewayServer({
			port: 0,
			env: { pluginDataDir: data, pluginRoot: path.resolve("plugins/claugle"), projectDir: data, sessionId: "a", weeklyBudgets: { "claude-code-native": 5e6, "agy-claude-pool": 8e6, "agy-gemini-pool": 15e6, "gemini-cli-pool": 1e7 }, agyBinOverride: agy },
		});
		let body;
		try {
			const res = await fetch(`${gw.url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gemini-4-argon", messages: [{ role: "user", content: "x" }] }) });
			body = await res.json();
		} finally {
			gw.server.close();
		}
		assert.deepEqual(JSON.parse(body.content[0].text), { agent: "claugle-gateway", tools: ["finish"], namesProject: false, optsOut: true });
	});

	it("delegated runs get read tools, plus write tools only for edit runs, and are told which folder is the project", async () => {
		const repo = tmp("claugle-agent-repo-");
		const { execFileSync } = await import("node:child_process");
		execFileSync("git", ["-C", repo, "init", "-q"]);
		fs.mkdirSync(path.join(repo, "docs"));
		fs.writeFileSync(path.join(repo, "docs", "guide.md"), "# g\n");
		execFileSync("git", ["-C", repo, "add", "-A"]);
		execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
		const agy = agentProbe(tmp("claugle-agent-bin-"));
		const env = parsePluginEnv({ CLAUDE_PLUGIN_DATA: tmp("claugle-agent-data-"), CLAUDE_PROJECT_DIR: repo, CLAUGLE_AGY_BIN: agy, CLAUGLE_GEMINI_BIN: "/nonexistent/gemini" }).value;
		const read = await executeRoutedTask({ request: parseTaskRequest({ prompt: "Review this diff", explicitTaskKind: "review", cwd: repo }).value, env });
		assert.deepEqual(JSON.parse(read.responseText), { agent: "claugle-reader", tools: ["view_file", "list_dir", "grep_search", "find_by_name"], namesProject: true, optsOut: true });
		const edit = await executeRoutedTask({ request: parseTaskRequest({ prompt: "update docs/guide.md", explicitTaskKind: "docs", allowFileEdits: true, allowedEditGlobs: ["docs/**"], cwd: repo }).value, env });
		assert.deepEqual(JSON.parse(edit.responseText.split("\n")[0]), {
			agent: "claugle-editor",
			tools: ["view_file", "list_dir", "grep_search", "find_by_name", "write_to_file", "replace_file_content", "multi_replace_file_content"],
			namesProject: true,
			optsOut: true,
		});
	});
});
