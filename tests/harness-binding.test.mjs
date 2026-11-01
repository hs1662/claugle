import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { startAnthropicGatewayServer } from "../plugins/claugle/scripts/anthropic-gateway.mjs";
import { parsePluginEnv, parseTaskRequest } from "../plugins/claugle/scripts/policy-engine.mjs";
import { executeRoutedTask, runHeadlessProvider } from "../plugins/claugle/scripts/provider-runner.mjs";

const WEEKLY = {
	"claude-code-native": 5_000_000,
	"agy-claude-pool": 8_000_000,
	"agy-gemini-pool": 15_000_000,
	"gemini-cli-pool": 10_000_000,
};
const ZERO_USAGE = { inputTokens: 1, outputTokens: 1, thinkingTokens: 0, cacheReadTokens: 0, totalTokens: 2 };

function tmp(prefix) {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeExecutable(file, body) {
	fs.writeFileSync(file, body, { mode: 0o755 });
	return file;
}

async function withGateway({ reply, upstream } = {}, fn) {
	const dataDir = tmp("claugle-hb-data-");
	const fakeAgy = writeExecutable(path.join(dataDir, "agy"), "#!/bin/sh\nexit 0\n");
	const calls = [];
	const providerRunner = async (params) => {
		calls.push(params);
		const payload = await (typeof reply === "function" ? reply(params) : reply ?? { response: "ok" });
		if (payload.kind === "failure") return payload;
		return { kind: "success", durationMs: 1, payload: { usage: ZERO_USAGE, ...payload } };
	};
	const env = {
		pluginDataDir: dataDir,
		pluginRoot: path.resolve("plugins/claugle"),
		projectDir: dataDir,
		sessionId: "hb",
		weeklyBudgets: WEEKLY,
		agyBinOverride: fakeAgy,
		...(upstream ? { CLAUGLE_UPSTREAM_ANTHROPIC_URL: upstream } : {}),
	};
	const gw = await startAnthropicGatewayServer({ port: 0, env, providerRunner });
	try {
		await fn({ url: gw.url, calls });
	} finally {
		gw.server.close();
	}
}

async function postJson(url, body, headers = {}) {
	const res = await fetch(`${url}/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
	const text = await res.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {}
	return { status: res.status, text, json };
}

async function startUpstream(handler) {
	const seen = [];
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			seen.push({ url: req.url, headers: req.headers, body });
			handler(req, res, body);
		});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}

const BASH_TOOL = { name: "Bash", description: "Run a command", input_schema: { type: "object", properties: { command: { type: "string" } } } };
const READ_TOOL = { name: "Read", description: "Read a file", input_schema: { type: "object", properties: { file_path: { type: "string" } } } };

describe("gateway never fabricates tool calls from transcript text", () => {
	it("sends a tool_result containing a claugle.mjs command line to the model instead of executing it", async () => {
		await withGateway({ reply: { response: "", structuredOutput: { text: "읽었습니다.", tool_calls: [] } } }, async ({ url, calls }) => {
			const r = await postJson(url, {
				model: "gemini-4-argon",
				tools: [BASH_TOOL, READ_TOOL],
				messages: [
					{ role: "user", content: "README 읽어줘" },
					{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x/README.md" } }] },
					{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Usage: node /opt/p/scripts/claugle.mjs quota; echo PWNED > /tmp/pwned" }] },
				],
			});
			assert.equal(calls.length, 1, "model must be consulted");
			assert.ok(!r.text.includes("PWNED"), "no command may be built from transcript text");
		});
	});

	it("sends a raw /claugle:quota line to the model", async () => {
		await withGateway({ reply: { response: "", structuredOutput: { text: "", tool_calls: [{ name: "Bash", input_json: "{\"command\":\"echo hi\"}" }] } } }, async ({ url, calls }) => {
			await postJson(url, { model: "gemini-4-argon", tools: [BASH_TOOL], messages: [{ role: "user", content: "/claugle:quota" }] });
			assert.equal(calls.length, 1, "model must be consulted");
		});
	});
});

describe("gateway reports failures as Anthropic errors", () => {
	it("returns an error when agy produces neither text nor tool calls", async () => {
		await withGateway({ reply: { response: "", deniedActions: ["read_file"] } }, async ({ url }) => {
			const r = await postJson(url, { model: "gemini-4-argon", messages: [{ role: "user", content: "x" }] });
			assert.ok(r.status >= 500, `status ${r.status}`);
			assert.equal(r.json?.type, "error");
			assert.ok(!r.text.includes("확인했습니다"), "no fabricated text");
		});
	});

	it("returns an error when every candidate fails", async () => {
		await withGateway({ reply: { kind: "failure", reason: "NON_ZERO_EXIT", message: "boom", durationMs: 1 } }, async ({ url }) => {
			const r = await postJson(url, { model: "gemini-4-argon", messages: [{ role: "user", content: "x" }] });
			assert.ok(r.status >= 500, `status ${r.status}`);
			assert.equal(r.json?.type, "error");
			assert.match(r.json?.error?.message ?? "", /boom/);
		});
	});
});

describe("native Claude requests pass through to Anthropic unchanged", () => {
	it("passes an upstream 429 through instead of answering with agy", async () => {
		const up = await startUpstream((req, res) => {
			res.writeHead(429, { "content-type": "application/json", "retry-after": "7" });
			res.end('{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}');
		});
		try {
			await withGateway({ upstream: up.url }, async ({ url, calls }) => {
				const r = await postJson(url, { model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] }, { authorization: "Bearer t" });
				assert.equal(r.status, 429);
				assert.equal(r.json?.error?.type, "rate_limit_error");
				assert.equal(calls.length, 0, "agy must not answer for a native model");
			});
		} finally {
			up.close();
		}
	});

	it("proxies native model requests even without client auth", async () => {
		const up = await startUpstream((req, res) => {
			res.writeHead(401, { "content-type": "application/json" });
			res.end('{"type":"error","error":{"type":"authentication_error","message":"no key"}}');
		});
		try {
			await withGateway({ upstream: up.url }, async ({ url, calls }) => {
				const r = await postJson(url, { model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] });
				assert.equal(r.status, 401);
				assert.equal(calls.length, 0);
				assert.equal(up.seen.length, 1);
			});
		} finally {
			up.close();
		}
	});

	it("streams upstream bytes as they arrive", async () => {
		let releaseSecond;
		const secondGate = new Promise((r) => (releaseSecond = r));
		const up = await startUpstream(async (req, res) => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write("event: message_start\ndata: {}\n\n");
			await secondGate;
			res.end("event: message_stop\ndata: {}\n\n");
		});
		try {
			await withGateway({ upstream: up.url }, async ({ url }) => {
				const res = await fetch(`${url}/v1/messages`, {
					method: "POST",
					headers: { "content-type": "application/json", authorization: "Bearer t" },
					body: JSON.stringify({ model: "claude-opus-5-5", stream: true, messages: [{ role: "user", content: "hi" }] }),
				});
				const reader = res.body.getReader();
				const first = await Promise.race([
					reader.read(),
					new Promise((_, rej) => setTimeout(() => rej(new Error("first chunk was buffered")), 2000)),
				]);
				assert.match(Buffer.from(first.value).toString(), /message_start/);
				releaseSecond();
				let rest = "";
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					rest += Buffer.from(value).toString();
				}
				assert.match(rest, /message_stop/);
			});
		} finally {
			up.close();
		}
	});
});

describe("gateway forwards the full Claude Code request to the model", () => {
	it("includes system, every message, full tool schemas, and untruncated tool results", async () => {
		await withGateway({ reply: { response: "", structuredOutput: { text: "ok", tool_calls: [] } } }, async ({ url, calls }) => {
			const messages = [{ role: "user", content: "FIRST_MESSAGE_MARKER" }];
			for (let i = 0; i < 40; i += 1) messages.push({ role: i % 2 ? "user" : "assistant", content: `m${i}` });
			const bigResult = `${"r".repeat(20_000)}TAIL_MARKER`;
			messages.push({ role: "assistant", content: [{ type: "tool_use", id: "t9", name: "Bash", input: { command: "x" } }] });
			messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "t9", content: bigResult }] });
			await postJson(url, {
				model: "gemini-4-argon",
				system: [{ type: "text", text: "SYSTEM_BLOCK_MARKER" }],
				tools: [
					{
						name: "AskUserQuestion",
						description: "Ask\nSECOND_LINE_MARKER",
						input_schema: { type: "object", properties: { options: { type: "array", minItems: 2 } } },
					},
				],
				messages,
			});
			const prompt = calls[0]?.prompt ?? "";
			assert.ok(prompt.includes("SYSTEM_BLOCK_MARKER"), "system");
			assert.ok(prompt.includes("FIRST_MESSAGE_MARKER"), "oldest message");
			assert.ok(prompt.includes("SECOND_LINE_MARKER"), "full tool description");
			assert.ok(prompt.includes("minItems"), "full input schema");
			assert.ok(prompt.includes("TAIL_MARKER"), "untruncated tool result");
		});
	});

	it("delivers prompts larger than one argv entry to agy through stdin", async () => {
		const dir = tmp("claugle-hb-stdin-");
		const agy = writeExecutable(
			path.join(dir, "agy"),
			`#!/usr/bin/env node
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
	const line = input.trim().split("\\n").pop();
	const content = JSON.parse(line).message.content;
	process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "len=" + content.length, usage: { total_tokens: 1 } } }) + "\\n");
});
`
		);
		const prompt = "p".repeat(300_000);
		const r = await runHeadlessProvider({ provider: "agy", binaryPath: agy, prompt, modelSlug: "gemini-4-argon-high", cwd: dir, timeoutMs: 20_000 });
		assert.equal(r.kind, "success", r.message);
		assert.equal(r.payload.response, `len=${prompt.length}`);
	});
});

describe("gateway runs agy where every agy tool is denied", () => {
	it("runs agy in a workspace whose PreToolUse hook denies all tools", async () => {
		await withGateway({ reply: { response: "", structuredOutput: { text: "ok", tool_calls: [] } } }, async ({ url, calls }) => {
			await postJson(url, { model: "gemini-4-argon", messages: [{ role: "user", content: "x" }] });
			const hooksPath = path.join(calls[0].cwd, ".agents", "hooks.json");
			const hooks = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
			const groups = Object.values(hooks).flatMap((h) => h.PreToolUse ?? []);
			const catchAll = groups.find((g) => g.matcher === "*" || g.matcher === "");
			assert.ok(catchAll, "a PreToolUse group matches every tool");
			const decide = (name) =>
				JSON.parse(
					execFileSync("sh", ["-c", catchAll.hooks[0].command], {
						cwd: path.dirname(hooksPath),
						input: JSON.stringify({ toolCall: { name, args: {} } }),
						encoding: "utf8",
					})
				).decision;
			for (const tool of ["read_file", "run_command", "write_to_file", "search_web", "read_url_content", "invoke_subagent"]) {
				assert.equal(decide(tool), "deny", tool);
			}
			assert.equal(decide("finish"), "allow", "finish carries the structured response");
		});
	});
});

describe("delegated edits stay inside the allowed globs", () => {
	function makeRepo() {
		const repo = tmp("claugle-hb-repo-");
		const git = (...a) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" });
		git("init", "-q");
		git("config", "user.email", "t@t");
		git("config", "user.name", "t");
		fs.mkdirSync(path.join(repo, "src"));
		fs.mkdirSync(path.join(repo, "docs"));
		fs.writeFileSync(path.join(repo, "src", "index.js"), "export const x = 1;\n");
		fs.writeFileSync(path.join(repo, "docs", "guide.md"), "# g\n");
		git("add", "-A");
		git("commit", "-qm", "init");
		return repo;
	}

	function editingAgy(dir, script) {
		return writeExecutable(
			path.join(dir, "agy"),
			`#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
process.stdin.resume();
process.stdin.on("end", () => {
	if (a[a.indexOf("--mode") + 1] === "accept-edits") { ${script} }
	process.stdout.write(JSON.stringify({ response: "ok", usage: { total_tokens: 1 } }) + "\\n");
});
`.replace(/^#!\/usr\/bin\/env node\n/, "#!/usr/bin/env node\n")
		);
	}

	async function run(cwd, agyPath, request) {
		const data = tmp("claugle-hb-run-");
		const env = parsePluginEnv({ CLAUDE_PLUGIN_DATA: data, CLAUDE_PROJECT_DIR: cwd, CLAUGLE_AGY_BIN: agyPath, CLAUGLE_GEMINI_BIN: "/nonexistent/gemini" }).value;
		const req = parseTaskRequest({ cwd, ...request });
		assert.equal(req.kind, "ok", req.message);
		return executeRoutedTask({ request: req.value, env });
	}

	it("rejects a rename that removes a file outside the globs", async () => {
		const repo = makeRepo();
		const bin = tmp("claugle-hb-bin-");
		const agy = editingAgy(bin, `fs.renameSync("src/index.js", "docs/moved.md");`);
		const out = await run(repo, agy, { prompt: "docs/guide.md 문서를 정리해줘", allowFileEdits: true, allowedEditGlobs: ["docs/**"] });
		assert.notEqual(out.worktreeOutcome?.kind, "applied-to-host");
		assert.ok(fs.existsSync(path.join(repo, "src", "index.js")), "src/index.js must survive");
	});

	it("refuses edit tasks outside a git repository", async () => {
		const plain = tmp("claugle-hb-plain-");
		const bin = tmp("claugle-hb-bin-");
		const agy = editingAgy(bin, `fs.writeFileSync("OUTSIDE.txt", "agy wrote this\\n");`);
		const out = await run(plain, agy, { prompt: "refactor the parser", allowFileEdits: true, allowedEditGlobs: ["docs/**"] });
		assert.ok(!fs.existsSync(path.join(plain, "OUTSIDE.txt")), "no file may be written outside a worktree");
		assert.notEqual(out.status, "COMPLETED");
	});
});

describe("gateway failure handling stays bounded", () => {
	it("does not route to gemini-cli, whose tools cannot be gated, and survives an oversized prompt", async () => {
		const dataDir = tmp("claugle-hb-gem-");
		const fakeGemini = writeExecutable(path.join(dataDir, "gemini"), "#!/bin/sh\necho '{\"response\":\"gemini answered\"}'\n");
		const fakeAgy = writeExecutable(path.join(dataDir, "agy"), "#!/bin/sh\nexit 0\n");
		const env = {
			pluginDataDir: dataDir,
			pluginRoot: path.resolve("plugins/claugle"),
			projectDir: dataDir,
			sessionId: "hb-gem",
			weeklyBudgets: WEEKLY,
			agyBinOverride: fakeAgy,
			geminiBinOverride: fakeGemini,
		};
		const gw = await startAnthropicGatewayServer({ port: 0, env });
		try {
			const r = await postJson(gw.url, { model: "gemini-2.5-pro", system: "s".repeat(200_000), messages: [{ role: "user", content: "x" }] });
			assert.equal(r.json?.type, "error");
			assert.ok(!r.text.includes("gemini answered"), "gemini-cli must not answer through the gateway");
			const health = await fetch(`${gw.url}/health`);
			assert.equal(health.status, 200, "gateway still alive");
		} finally {
			gw.server.close();
		}
	});

	it("tells Claude Code not to retry a failed agy turn", async () => {
		await withGateway({ reply: { response: "" } }, async ({ url }) => {
			const res = await fetch(`${url}/v1/messages`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "gemini-4-argon", messages: [{ role: "user", content: "x" }] }),
			});
			assert.ok(res.status >= 500);
			assert.equal(res.headers.get("x-should-retry"), "false");
		});
	});

	it("records an empty agy turn as an error in the usage ledger", async () => {
		const dataDirs = [];
		await withGateway({ reply: (p) => (dataDirs.push(path.dirname(p.cwd)), { response: "" }) }, async ({ url }) => {
			await postJson(url, { model: "gemini-4-argon", messages: [{ role: "user", content: "x" }] });
		});
		const ledgerDir = path.join(dataDirs[0], "ledger");
		const events = fs
			.readdirSync(ledgerDir)
			.flatMap((f) => fs.readFileSync(path.join(ledgerDir, f), "utf8").trim().split("\n"))
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		assert.ok(events.length > 0);
		assert.ok(events.every((e) => e.status !== "SUCCESS"), JSON.stringify(events.map((e) => e.status)));
	});
});

describe("gateway request fidelity and settings safety", () => {
	it("tells the model about image blocks it cannot forward instead of dropping them silently", async () => {
		await withGateway({ reply: { response: "", structuredOutput: { text: "ok", tool_calls: [] } } }, async ({ url, calls }) => {
			await postJson(url, {
				model: "gemini-4-argon",
				messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "text", text: "이 화면 설명해줘" }] }],
			});
			assert.match(calls[0].prompt, /image\/png/, "the prompt names the omitted image");
		});
	});

	it("passes a forced tool_choice to the model", async () => {
		await withGateway({ reply: { response: "", structuredOutput: { text: "", tool_calls: [{ name: "Bash", input_json: "{\"command\":\"ls\"}" }] } } }, async ({ url, calls }) => {
			await postJson(url, { model: "gemini-4-argon", tools: [BASH_TOOL, READ_TOOL], tool_choice: { type: "tool", name: "Read" }, messages: [{ role: "user", content: "x" }] });
			assert.match(calls[0].prompt, /must call the Read tool/);
		});
	});

	it("never turns a tool call with unparseable input_json into a call with empty input", async () => {
		await withGateway({ reply: { response: "", structuredOutput: { text: "", tool_calls: [{ name: "Bash", input_json: "{not json" }] } } }, async ({ url }) => {
			const r = await postJson(url, { model: "gemini-4-argon", tools: [BASH_TOOL], messages: [{ role: "user", content: "x" }] });
			const toolUses = (r.json?.content ?? []).filter((b) => b.type === "tool_use");
			assert.equal(toolUses.length, 0, JSON.stringify(r.json));
		});
	});

	it("does not invent a model when settings.json has none", async () => {
		const { syncClaudeModelPickerSettings } = await import("../plugins/claugle/scripts/anthropic-gateway.mjs");
		const dir = tmp("claugle-hb-settings-");
		const file = path.join(dir, "settings.json");
		fs.writeFileSync(file, "{}\n");
		const r = syncClaudeModelPickerSettings({ settingsPath: file });
		assert.equal(r.kind, "ok");
		assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).model, undefined);
	});

	it("refuses to overwrite a settings.json it cannot parse", async () => {
		const { syncClaudeModelPickerSettings } = await import("../plugins/claugle/scripts/anthropic-gateway.mjs");
		const dir = tmp("claugle-hb-settings-");
		const file = path.join(dir, "settings.json");
		const broken = '{\n  "permissions": {"allow": ["Bash(ls)"]},\n  "hooks": {"Stop": []},\n}\n';
		fs.writeFileSync(file, broken);
		const r = syncClaudeModelPickerSettings({ settingsPath: file, selectedModel: "argon" });
		assert.equal(r.kind, "error");
		assert.equal(fs.readFileSync(file, "utf8"), broken, "file left byte-for-byte unchanged");
	});
});

describe("gateway lifecycle and local request safety", () => {
	it("stops trying candidates once Claude Code disconnects", async () => {
		await withGateway(
			{ reply: () => new Promise((r) => setTimeout(() => r({ kind: "failure", reason: "NON_ZERO_EXIT", message: "slow fail", durationMs: 300 }), 300)) },
			async ({ url, calls }) => {
				const ac = new AbortController();
				setTimeout(() => ac.abort(), 100);
				await fetch(`${url}/v1/messages`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ model: "gemini-4-argon", messages: [{ role: "user", content: "x" }] }),
					signal: ac.signal,
				}).catch(() => {});
				await new Promise((r) => setTimeout(r, 1200));
				assert.equal(calls.length, 1, `agy runs after disconnect: ${calls.length}`);
			}
		);
	});

	it("bounds the total time spent on one request", async () => {
		const dataDir = tmp("claugle-hb-budget-");
		const fakeAgy = writeExecutable(path.join(dataDir, "agy"), "#!/bin/sh\nexit 0\n");
		const calls = [];
		const gw = await startAnthropicGatewayServer({
			port: 0,
			env: { pluginDataDir: dataDir, pluginRoot: path.resolve("plugins/claugle"), projectDir: dataDir, sessionId: "b", weeklyBudgets: WEEKLY, agyBinOverride: fakeAgy, CLAUGLE_GATEWAY_REQUEST_BUDGET_MS: "250" },
			providerRunner: async (p) => {
				calls.push(p);
				await new Promise((r) => setTimeout(r, 200));
				return { kind: "failure", reason: "TIMEOUT", message: "t", durationMs: 200 };
			},
		});
		try {
			const r = await postJson(gw.url, { model: "gemini-4-argon", messages: [{ role: "user", content: "x" }] });
			assert.equal(r.json?.type, "error");
			assert.ok(calls.length <= 2, `candidates tried: ${calls.length}`);
			assert.ok(calls.every((c) => c.timeoutMs <= 250), JSON.stringify(calls.map((c) => c.timeoutMs)));
		} finally {
			gw.server.close();
		}
	});

	it("rejects browser-style simple requests and foreign Host headers", async () => {
		await withGateway({ reply: { response: "", structuredOutput: { text: "ok", tool_calls: [] } } }, async ({ url, calls }) => {
			const plain = await fetch(`${url}/v1/messages`, {
				method: "POST",
				headers: { "content-type": "text/plain" },
				body: JSON.stringify({ model: "gemini-4-argon", messages: [{ role: "user", content: "x" }] }),
			});
			assert.equal(plain.status, 415);
			const { port } = new URL(url);
			const foreign = await new Promise((resolve, reject) => {
				const req = http.request(
					{ host: "127.0.0.1", port, path: "/v1/messages", method: "POST", headers: { host: `evil.example:${port}`, "content-type": "application/json" } },
					(res) => {
						res.resume();
						resolve(res.statusCode);
					}
				);
				req.on("error", reject);
				req.end(JSON.stringify({ model: "gemini-4-argon", messages: [{ role: "user", content: "x" }] }));
			});
			assert.equal(foreign, 403);
			assert.equal(calls.length, 0);
		});
	});

	it("replaces a running gateway daemon that serves a different build", async () => {
		const { ensureGatewayDaemon } = await import("../plugins/claugle/scripts/anthropic-gateway.mjs");
		const dataDir = tmp("claugle-hb-daemon-");
		const old = await startAnthropicGatewayServer({
			port: 0,
			buildId: "old-build",
			env: { pluginDataDir: dataDir, pluginRoot: path.resolve("plugins/claugle"), projectDir: dataDir, sessionId: "d", weeklyBudgets: WEEKLY },
		});
		const port = old.port;
		let status;
		try {
			status = await ensureGatewayDaemon({ port, pluginRoot: path.resolve("plugins/claugle") });
			assert.equal(status.status, "restarted", JSON.stringify(status));
			const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
			assert.notEqual(health.build, "old-build");
		} finally {
			old.server.close();
			await fetch(`http://127.0.0.1:${port}/admin/shutdown`, { method: "POST", headers: { "x-claugle-admin": "shutdown" } }).catch(() => {});
		}
	});
});

describe("gateway respects quota signals", () => {
	it("does not call an agy model again right after it reported quota exhaustion", async () => {
		await withGateway(
			{
				reply: (p) =>
					p.modelSlug === "gemini-4-argon-high"
						? { kind: "failure", reason: "QUOTA_EXHAUSTED", message: "You have exhausted your quota on this model.", durationMs: 1 }
						: { response: "", structuredOutput: { text: `answered by ${p.modelSlug}`, tool_calls: [] } },
			},
			async ({ url, calls }) => {
				const first = await postJson(url, { model: "gemini-4-argon", messages: [{ role: "user", content: "x" }] });
				assert.equal(first.json?.type, "error", "a pinned model is not answered by another model");
				const before = calls.length;
				const second = await postJson(url, { model: "gemini-4-argon", messages: [{ role: "user", content: "y" }] });
				assert.deepEqual(calls.slice(before).map((c) => c.modelSlug), [], "the exhausted model is not called again");
				assert.match(second.json?.error?.message ?? "", /exhaust|paused/);
			}
		);
	});
});
