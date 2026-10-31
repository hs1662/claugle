import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { parseCliSubcommandArgs } from "../plugins/claugle/scripts/claugle.mjs";
import { isReplaceableLocalBaseUrl } from "../plugins/claugle/scripts/anthropic-gateway.mjs";
import { parsePluginEnv, parseTaskRequest } from "../plugins/claugle/scripts/policy-engine.mjs";
import { executeRoutedTask } from "../plugins/claugle/scripts/provider-runner.mjs";

const PLUGIN_ROOT = path.resolve("plugins/claugle");
const CLI = path.join(PLUGIN_ROOT, "scripts", "claugle.mjs");
const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

describe("a bare -- in the middle never hides options on either side", () => {
	it("refuses known options before a mid-text --", () => {
		assert.throws(() => parseCliSubcommandArgs(["--args-stdin"], "fix the intro --allow-edits -- keep the title"), /--/);
		assert.throws(() => parseCliSubcommandArgs(["--args-stdin"], "fix it --allow-edits --glob docs/** -- keep the title"), /--/);
	});
});

describe("a slow local proxy is not mistaken for a dead claugle gateway", () => {
	it("keeps a loopback URL whose server is alive but slow", async () => {
		const slow = http.createServer((req, res) => setTimeout(() => res.end("{}"), 1500));
		await new Promise((r) => slow.listen(0, "127.0.0.1", r));
		try {
			assert.equal(await isReplaceableLocalBaseUrl(`http://127.0.0.1:${slow.address().port}`), false);
		} finally {
			slow.closeAllConnections?.();
			slow.close();
		}
	});

	it("still replaces a loopback URL where nothing listens", async () => {
		const probe = http.createServer();
		await new Promise((r) => probe.listen(0, "127.0.0.1", r));
		const port = probe.address().port;
		await new Promise((r) => probe.close(r));
		assert.equal(await isReplaceableLocalBaseUrl(`http://127.0.0.1:${port}`), true);
	});
});

describe("claugle model honors the configured gateway port", () => {
	it("writes the configured port into settings", () => {
		const dir = tmp("claugle-r4-model-");
		const settings = path.join(dir, "settings.json");
		fs.writeFileSync(settings, "{}\n");
		const r = spawnSync(process.execPath, [CLI, "model", "argon", "low"], {
			env: { ...process.env, CLAUDE_PLUGIN_DATA: dir, CLAUGLE_GATEWAY_PORT: "19999", CLAUGLE_CLAUDE_SETTINGS_PATH: settings },
			encoding: "utf8",
		});
		assert.equal(r.status, 0, r.stderr);
		assert.equal(JSON.parse(fs.readFileSync(settings, "utf8")).env.ANTHROPIC_BASE_URL, "http://127.0.0.1:19999");
	});
});

describe("task requests name a folder that exists", () => {
	it("rejects a cwd that does not exist", () => {
		const r = parseTaskRequest({ prompt: "look at this", cwd: path.join(os.tmpdir(), "claugle-r4-missing", "typo") });
		assert.equal(r.kind, "error");
		assert.match(r.message, /cwd/);
	});
});

describe("symlinks inside .agents count as customizations", () => {
	it("does not start agy when .agents/plugins is a symlink to a folder with hooks", async () => {
		const repo = tmp("claugle-r4-repo-");
		execFileSync("git", ["-C", repo, "init", "-q"]);
		const elsewhere = tmp("claugle-r4-kit-");
		fs.mkdirSync(path.join(elsewhere, "kit"));
		fs.writeFileSync(path.join(elsewhere, "kit", "hooks.json"), "{}\n");
		fs.mkdirSync(path.join(repo, ".agents"));
		fs.symlinkSync(elsewhere, path.join(repo, ".agents", "plugins"));
		const binDir = tmp("claugle-r4-bin-");
		const marker = path.join(binDir, "started");
		const agy = path.join(binDir, "agy");
		fs.writeFileSync(agy, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\ncat >/dev/null\necho '{"response":"ran","usage":{}}'\n`, { mode: 0o755 });
		const env = parsePluginEnv({ CLAUDE_PLUGIN_DATA: tmp("claugle-r4-data-"), CLAUDE_PROJECT_DIR: repo, CLAUGLE_AGY_BIN: agy, CLAUGLE_GEMINI_BIN: "/nonexistent/gemini" }).value;
		await executeRoutedTask({ request: parseTaskRequest({ prompt: "Review this diff", explicitTaskKind: "review", cwd: repo }).value, env });
		assert.equal(fs.existsSync(marker), false);
	});
});

describe("odd inputs at the CLI, task request and gateway probe", () => {
	it("keeps a mid-text -- in the prompt when no option is near it", () => {
		assert.equal(parseCliSubcommandArgs(["--args-stdin"], "explain why git checkout main -- src/ restores only src").prompt, "explain why git checkout main -- src/ restores only src");
	});
	it("returns an error, not a throw, for a cwd the filesystem rejects", () => {
		assert.equal(parseTaskRequest({ prompt: "x", cwd: path.join(os.tmpdir(), "n".repeat(5000)) }).kind, "error");
	});
	it("ignores an invalid CLAUGLE_GATEWAY_PORT", () => {
		const dir = tmp("claugle-r4b-");
		const settings = path.join(dir, "settings.json");
		fs.writeFileSync(settings, "{}\n");
		spawnSync(process.execPath, [CLI, "model", "argon", "low"], { env: { ...process.env, CLAUDE_PLUGIN_DATA: dir, CLAUGLE_GATEWAY_PORT: "19999.5", CLAUGLE_CLAUDE_SETTINGS_PATH: settings }, encoding: "utf8" });
		assert.equal(JSON.parse(fs.readFileSync(settings, "utf8")).env.ANTHROPIC_BASE_URL, "http://127.0.0.1:18789");
	});
	it("finishes the probe when the server drops the connection mid-body", async () => {
		const s = http.createServer((req, res) => { res.writeHead(200); res.write("{"); setTimeout(() => res.destroy(), 50); });
		await new Promise((r) => s.listen(0, "127.0.0.1", r));
		const started = Date.now();
		await isReplaceableLocalBaseUrl(`http://127.0.0.1:${s.address().port}`);
		s.close();
		assert.ok(Date.now() - started < 1500);
	});
});
