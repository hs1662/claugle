import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { startAnthropicGatewayServer } from "../plugins/claugle/scripts/anthropic-gateway.mjs";
import { parsePluginEnv, parseTaskRequest } from "../plugins/claugle/scripts/policy-engine.mjs";
import { executeRoutedTask, prepareAgyHome, runHeadlessProvider } from "../plugins/claugle/scripts/provider-runner.mjs";

const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

function fakeRealHome() {
	const home = tmp("claugle-home-real-");
	fs.mkdirSync(path.join(home, ".gemini", "antigravity-cli"), { recursive: true });
	fs.writeFileSync(path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"), "token");
	return home;
}

describe("claugle runs agy in a home without the user's global agy plugins, MCP servers and hooks", () => {
	it("starts agy with that home", async () => {
		const dir = tmp("claugle-agyhome-bin-");
		const agy = path.join(dir, "agy");
		fs.writeFileSync(agy, `#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdin.on("end", () => process.stdout.write(JSON.stringify({ response: process.env.HOME, usage: {} }) + "\\n"));\n`, { mode: 0o755 });
		const home = prepareAgyHome(tmp("claugle-data-"), fakeRealHome());
		const r = await runHeadlessProvider({ provider: "agy", binaryPath: agy, prompt: "x", modelSlug: "gemini-4-argon-high", cwd: dir, timeoutMs: 20_000, agyHome: home });
		assert.equal(r.kind, "success", r.message);
		assert.equal(r.payload.response, home);
	});

	it("the gateway and delegated runs both hand agy the isolated home", async () => {
		const data = tmp("claugle-data-");
		const fakeAgy = path.join(data, "agy");
		fs.writeFileSync(fakeAgy, "#!/bin/sh\n", { mode: 0o755 });
		const seen = [];
		const gw = await startAnthropicGatewayServer({
			port: 0,
			env: { pluginDataDir: data, pluginRoot: path.resolve("plugins/claugle"), projectDir: data, sessionId: "h", weeklyBudgets: { "claude-code-native": 5e6, "agy-claude-pool": 8e6, "agy-gemini-pool": 15e6, "gemini-cli-pool": 1e7 }, agyBinOverride: fakeAgy },
			providerRunner: async (p) => {
				seen.push(p.agyHome);
				return { kind: "success", durationMs: 1, payload: { response: "ok", usage: { inputTokens: 1, outputTokens: 1, thinkingTokens: 0, cacheReadTokens: 0, totalTokens: 2 } } };
			},
		});
		try {
			await fetch(`${gw.url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gemini-4-argon", messages: [{ role: "user", content: "x" }] }) });
		} finally {
			gw.server.close();
		}
		assert.equal(seen[0], path.join(data, "agy-home"));

		const repo = tmp("claugle-agyhome-repo-");
		const bin = tmp("claugle-agyhome-bin-");
		const agy = path.join(bin, "agy");
		fs.writeFileSync(agy, `#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdin.on("end", () => process.stdout.write(JSON.stringify({ response: process.env.HOME, usage: {} }) + "\\n"));\n`, { mode: 0o755 });
		const env = parsePluginEnv({ CLAUDE_PLUGIN_DATA: data, CLAUDE_PROJECT_DIR: repo, CLAUGLE_AGY_BIN: agy, CLAUGLE_GEMINI_BIN: "/nonexistent/gemini" }).value;
		const out = await executeRoutedTask({ request: parseTaskRequest({ prompt: "Review this diff", explicitTaskKind: "review", cwd: repo }).value, env });
		assert.equal(out.responseText.trim(), path.join(data, "agy-home"));
	});
});
