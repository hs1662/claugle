import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendUsageEvent, loadRollingQuotaSnapshot } from "./ledger-store.mjs";
import {
	DEFAULT_POLICY_MATRIX,
	MODEL_CAPABILITIES,
	classifyTask,
	createTaskExecutionId,
	parsePluginEnv,
	 parseTaskRequest,
	resolveModelAlias,
	resolveRoutePlan,
} from "./policy-engine.mjs";
import { detectProviderHealth, runHeadlessProvider } from "./provider-runner.mjs";

export const DEFAULT_GATEWAY_PORT = 18789;

export const GATEWAY_TURN_JSON_SCHEMA = Object.freeze({
	type: "object",
	properties: Object.freeze({
		text: Object.freeze({ type: "string" }),
		tool_calls: Object.freeze({
			type: "array",
			items: Object.freeze({
				type: "object",
				properties: Object.freeze({
					name: Object.freeze({ type: "string" }),
					input_json: Object.freeze({ type: "string" }),
				}),
				required: Object.freeze(["name", "input_json"]),
			}),
		}),
	}),
	required: Object.freeze(["text", "tool_calls"]),
});

function extractTextFromContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
}

function extractToolResultText(block) {
	if (!block || typeof block !== "object") return "";
	if (typeof block.content === "string") return block.content;
	if (Array.isArray(block.content)) {
		return block.content
			.map((item) => (item && typeof item.text === "string" ? item.text : ""))
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

export function extractSlashCommandFastPath(body, pluginRoot) {
	const messages = Array.isArray(body?.messages) ? body.messages : [];
	if (messages.length === 0) return null;

	const lastMsg = messages[messages.length - 1];
	if (!lastMsg || lastMsg.role !== "user") return null;

	if (Array.isArray(lastMsg.content) && messages.length >= 2) {
		const prevMsg = messages[messages.length - 2];
		const toolResultBlock = lastMsg.content.find((b) => b && b.type === "tool_result");
		if (toolResultBlock && prevMsg && prevMsg.role === "assistant" && Array.isArray(prevMsg.content)) {
			const matchingToolUse = prevMsg.content.find(
				(b) =>
					b &&
					b.type === "tool_use" &&
					b.id === toolResultBlock.tool_use_id &&
					b.name === "Bash" &&
					typeof b.input?.command === "string" &&
					b.input.command.includes("claugle.mjs")
			);
			if (matchingToolUse) {
				const outputText = extractToolResultText(toolResultBlock).trim() || "{}";
				const formattedText =
					`요청하신 실행 결과는 아래와 같습니다.\n\n\`\`\`json\n${outputText}\n\`\`\``;
				return {
					kind: "slash-turn-2-result",
					text: formattedText,
					toolCalls: [],
				};
			}
		}
	}

	const hasBashTool =
		Array.isArray(body?.tools) &&
		body.tools.some((t) => t && t.name === "Bash");
	if (!hasBashTool) return null;

	const combinedUserText = [
		extractTextFromContent(lastMsg.content),
		...(Array.isArray(lastMsg.content)
			? lastMsg.content
					.filter((b) => b && b.type === "tool_result")
					.map((b) => extractToolResultText(b))
			: []),
	].join("\n");

	const resolvedPluginRoot =
		pluginRoot ||
		path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const scriptPath = path.join(resolvedPluginRoot, "scripts", "claugle.mjs");

	const cmdMatch =
		/node\s+"?\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/claugle\.mjs"?\s+([^\n`]+)/.exec(combinedUserText) ||
		/node\s+"?([^"\s]+\/scripts\/claugle\.mjs)"?\s+([^\n`]+)/.exec(combinedUserText);

	if (cmdMatch) {
		const rawTail = (cmdMatch[2] ? cmdMatch[2] : cmdMatch[1]).trim();
		const cleanedTail = rawTail.replace(/^"\$ARGUMENTS"$/, "").trim();
		const command = cleanedTail
			? `node ${JSON.stringify(scriptPath)} ${cleanedTail}`
			: `node ${JSON.stringify(scriptPath)} quota`;
		return {
			kind: "slash-turn-1-exec",
			text: "",
			toolCalls: [
				{
					id: `toolu_${crypto.randomBytes(8).toString("hex")}`,
					name: "Bash",
					input: {
						command,
						description: "claugle 명령 실행",
					},
				},
			],
		};
	}

	const rawSlashMatch =
		/(?:^|\n)\s*\/claugle:(quota|explain|write|review|task)(?:\s+([^\n]+))?\s*$/.exec(
			combinedUserText.trim()
		);
	if (rawSlashMatch) {
		const sub = rawSlashMatch[1] === "task" ? "run" : rawSlashMatch[1];
		const rest = (rawSlashMatch[2] || "").trim();
		const command = rest
			? `node ${JSON.stringify(scriptPath)} ${sub} ${JSON.stringify(rest)}`
			: `node ${JSON.stringify(scriptPath)} ${sub}`;
		return {
			kind: "slash-turn-1-exec",
			text: "",
			toolCalls: [
				{
					id: `toolu_${crypto.randomBytes(8).toString("hex")}`,
					name: "Bash",
					input: {
						command,
						description: "claugle 명령 실행",
					},
				},
			],
		};
	}

	return null;
}

function makeGatewayTarget(modelSlug) {
	const cap = MODEL_CAPABILITIES[modelSlug];
	if (!cap) return null;
	return Object.freeze({
		provider: cap.provider,
		quotaPool: cap.quotaPool,
		modelSlug: cap.slug,
		family: cap.family,
		effort: cap.defaultEffort,
		agyMode: "plan",
		isolation: Object.freeze({ kind: "read-only" }),
		timeoutMs: 180_000,
	});
}

export function resolveGatewayCandidates({
	rawModel,
	messages = [],
	tools = [],
	maxTokens = 4096,
	snapshot,
	health,
}) {
	const fallbackSlugs = [
		"gemini-4-argon-high",
		"gemini-3.8-flash-high",
		"claude-sonnet-5-5-high",
		"claude-opus-5-5-high",
	];

	const resolvedAlias = resolveModelAlias(rawModel);
	if (resolvedAlias) {
		const orderedSlugs = [
			resolvedAlias,
			...fallbackSlugs.filter((s) => s !== resolvedAlias),
		];
		return orderedSlugs.map(makeGatewayTarget).filter(Boolean);
	}

	const modelLower = String(rawModel || "").toLowerCase();
	const hasTools = Array.isArray(tools) && tools.length > 0;
	if (modelLower.includes("haiku") && (!hasTools || Number(maxTokens) <= 300)) {
		return [
			makeGatewayTarget("gemini-3.8-flash-low"),
			makeGatewayTarget("gemini-4-argon-low"),
		].filter(Boolean);
	}

	let latestUserPrompt = "Assist with the current software engineering task.";
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		if (messages[i]?.role === "user") {
			const extracted = extractTextFromContent(messages[i].content).trim();
			if (extracted) {
				latestUserPrompt = extracted;
				break;
			}
		}
	}

	const reqRes = parseTaskRequest({
		prompt: latestUserPrompt,
		cwd: process.cwd(),
	});
	if (reqRes.kind === "ok" && snapshot && health) {
		const plan = resolveRoutePlan({
			request: reqRes.value,
			quotaState: snapshot.quotaState,
			metrics: snapshot.metrics,
			health,
		});
		const externalCandidates = plan.candidates.filter(
			(c) => c.provider !== "claude-native"
		);
		if (externalCandidates.length > 0) {
			return externalCandidates;
		}
	}

	const defaultChain =
		DEFAULT_POLICY_MATRIX.OVERFLOW_TO_AGY[
			classifyTask(latestUserPrompt).taskKind
		] ?? fallbackSlugs.map(makeGatewayTarget);
	return defaultChain.filter((c) => c && c.provider !== "claude-native");
}

export function buildGatewayPrompt(body) {
	const sections = [
		"You are the model engine running inside the Claude Code harness.",
		"규칙 1: 모든 답변과 설명은 반드시 한국어로만 작성한다. 영어 문장을 출력하지 않는다.",
		"규칙 2: 도구 호출 시 description 등 설명 필드는 반드시 한국어로 작성한다.",
		"규칙 3: 도구 출력에 없는 구체적인 수치나 식별자를 본문에 쓸 때는 (추론) 또는 (제안) 라벨을 붙인다.",
		"규칙 4: 완료했습니다, 해결했습니다, 성공했습니다, 동작합니다 같은 판정어 대신 확인했습니다, 정리했습니다, 작성했습니다를 사용한다.",
		"Do NOT invoke any internal Antigravity tools. Only produce the response for the Claude Code harness.",
	];

	const tools = Array.isArray(body?.tools) ? body.tools : [];
	if (tools.length > 0) {
		sections.push(
			"Return a JSON object matching the schema {\"text\": string, \"tool_calls\": [{\"name\": string, \"input_json\": string}]}.",
			"When you need the Claude Code harness to execute a tool from the catalog below, add an entry to tool_calls with the exact tool name and a JSON-encoded object string in input_json matching that tool's parameters.",
			"When no tool call is needed, set tool_calls to [] and write your Korean response in text.",
			"",
			"Available Claude Code harness tools:"
		);
		for (const tool of tools) {
			if (!tool || typeof tool.name !== "string") continue;
			const desc = typeof tool.description === "string"
				? tool.description.split("\n")[0].slice(0, 180)
				: "";
			const props = tool.input_schema?.properties
				? Object.keys(tool.input_schema.properties).join(", ")
				: "";
			const reqs = Array.isArray(tool.input_schema?.required)
				? tool.input_schema.required.join(", ")
				: "";
			sections.push(
				`- ${tool.name}: ${desc} (params: [${props}]; required: [${reqs}])`
			);
		}
	}

	sections.push("", "Conversation transcript:");
	const messages = Array.isArray(body?.messages) ? body.messages : [];
	const recentMessages = messages.slice(-16);
	for (const msg of recentMessages) {
		if (!msg || typeof msg !== "object") continue;
		const roleLabel = msg.role === "assistant" ? "ASSISTANT" : "USER";
		if (typeof msg.content === "string") {
			sections.push(`\n[${roleLabel}]\n${msg.content}`);
			continue;
		}
		if (Array.isArray(msg.content)) {
			const blocks = [];
			for (const block of msg.content) {
				if (!block || typeof block !== "object") continue;
				if (block.type === "text" && typeof block.text === "string") {
					blocks.push(block.text);
				} else if (block.type === "tool_use") {
					blocks.push(
						`[tool_use id=${block.id} name=${block.name} input=${JSON.stringify(block.input ?? {})}]`
					);
				} else if (block.type === "tool_result") {
					const resultText = extractToolResultText(block).slice(0, 12_000);
					blocks.push(
						`[tool_result tool_use_id=${block.tool_use_id} is_error=${Boolean(block.is_error)}]\n${resultText}`
					);
				}
			}
			if (blocks.length > 0) {
				sections.push(`\n[${roleLabel}]\n${blocks.join("\n")}`);
			}
		}
	}

	return sections.join("\n");
}

function parseStructuredGatewayOutput(payload, expectStructured) {
	const structured =
		payload?.structuredOutput && typeof payload.structuredOutput === "object"
			? payload.structuredOutput
			: null;

	let parsedObj = structured;
	if (!parsedObj && expectStructured && typeof payload?.response === "string") {
		const trimmed = payload.response.trim();
		if (trimmed.startsWith("{")) {
			try {
				parsedObj = JSON.parse(trimmed);
			} catch {
				parsedObj = null;
			}
		}
	}

	if (parsedObj && typeof parsedObj === "object") {
		const text = typeof parsedObj.text === "string" ? parsedObj.text : "";
		const rawCalls = Array.isArray(parsedObj.tool_calls) ? parsedObj.tool_calls : [];
		const toolCalls = [];
		for (const call of rawCalls) {
			if (!call || typeof call.name !== "string" || !call.name.trim()) continue;
			let inputObj = {};
			if (typeof call.input_json === "string" && call.input_json.trim()) {
				try {
					const candidate = JSON.parse(call.input_json);
					if (candidate && typeof candidate === "object") {
						inputObj = candidate;
					}
				} catch {
					inputObj = {};
				}
			} else if (call.input && typeof call.input === "object") {
				inputObj = call.input;
			}
			toolCalls.push({
				id: `toolu_${crypto.randomBytes(8).toString("hex")}`,
				name: call.name.trim(),
				input: inputObj,
			});
		}
		return { text, toolCalls };
	}

	return {
		text: typeof payload?.response === "string" ? payload.response : "",
		toolCalls: [],
	};
}

export function formatAnthropicJsonResponse({
	messageId = `msg_${crypto.randomBytes(8).toString("hex")}`,
	model = "gemini-4-argon-high",
	text = "",
	toolCalls = [],
	inputTokens = 100,
	outputTokens = 30,
}) {
	const content = [];
	if (text && text.length > 0) {
		content.push({ type: "text", text });
	}
	for (const call of toolCalls) {
		content.push({
			type: "tool_use",
			id: call.id || `toolu_${crypto.randomBytes(8).toString("hex")}`,
			name: call.name,
			input: call.input ?? {},
		});
	}
	if (content.length === 0) {
		content.push({ type: "text", text: "확인했습니다." });
	}

	const stopReason = toolCalls.length > 0 ? "tool_use" : "end_turn";
	return {
		id: messageId,
		type: "message",
		role: "assistant",
		model,
		content,
		stop_reason: stopReason,
		stop_sequence: null,
		usage: {
			input_tokens: inputTokens,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
			output_tokens: outputTokens,
		},
	};
}

export function writeAnthropicSseResponse(res, params) {
	const msg = formatAnthropicJsonResponse(params);
	res.writeHead(200, {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});

	const writeEvent = (event, data) => {
		res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	};

	writeEvent("message_start", {
		type: "message_start",
		message: {
			id: msg.id,
			type: "message",
			role: "assistant",
			model: msg.model,
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: {
				input_tokens: msg.usage.input_tokens,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
				output_tokens: 1,
			},
		},
	});

	msg.content.forEach((block, index) => {
		if (block.type === "text") {
			writeEvent("content_block_start", {
				type: "content_block_start",
				index,
				content_block: { type: "text", text: "" },
			});
			writeEvent("content_block_delta", {
				type: "content_block_delta",
				index,
				delta: { type: "text_delta", text: block.text },
			});
			writeEvent("content_block_stop", {
				type: "content_block_stop",
				index,
			});
		} else if (block.type === "tool_use") {
			writeEvent("content_block_start", {
				type: "content_block_start",
				index,
				content_block: {
					type: "tool_use",
					id: block.id,
					name: block.name,
					input: {},
				},
			});
			writeEvent("content_block_delta", {
				type: "content_block_delta",
				index,
				delta: {
					type: "input_json_delta",
					partial_json: JSON.stringify(block.input ?? {}),
				},
			});
			writeEvent("content_block_stop", {
				type: "content_block_stop",
				index,
			});
		}
	});

	writeEvent("message_delta", {
		type: "message_delta",
		delta: {
			stop_reason: msg.stop_reason,
			stop_sequence: null,
		},
		usage: {
			output_tokens: msg.usage.output_tokens,
		},
	});
	writeEvent("message_stop", { type: "message_stop" });
	res.end();
}

function getIsolatedGatewayCwd() {
	const dir = path.join(os.tmpdir(), "claugle-gateway-empty");
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

export function startAnthropicGatewayServer({
	port = DEFAULT_GATEWAY_PORT,
	host = "127.0.0.1",
	env: rawEnv = process.env,
	providerRunner = runHeadlessProvider,
} = {}) {
	const parsedEnv = rawEnv?.pluginDataDir ? { kind: "ok", value: rawEnv } : parsePluginEnv(rawEnv);
	const env =
		parsedEnv.kind === "ok"
			? parsedEnv.value
			: {
					pluginRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
					pluginDataDir: path.join(os.homedir(), ".claude", "plugins", "data", "claugle-claugle"),
					projectDir: process.cwd(),
					sessionId: "gateway-session",
					weeklyBudgets: {
						"claude-code-native": 5_000_000,
						"agy-claude-pool": 8_000_000,
						"agy-gemini-pool": 15_000_000,
						"gemini-cli-pool": 10_000_000,
					},
					defaultAgyMode: "plan",
				};

	const server = http.createServer((req, res) => {
		const urlPath = (req.url || "/").split("?")[0];

		if (urlPath === "/api/hello" || urlPath === "/health") {
			res.writeHead(200, { "Content-Type": "application/json" });
			if (req.method === "HEAD") {
				res.end();
				return;
			}
			res.end(
				JSON.stringify({
					status: "ok",
					service: "claugle-gateway",
					defaultModel: "gemini-4-argon-high",
				})
			);
			return;
		}

		let rawBody = "";
		req.on("data", (chunk) => {
			rawBody += chunk.toString("utf8");
		});

		req.on("end", async () => {
			if (urlPath === "/v1/messages/count_tokens") {
				const est = Math.max(1, Math.ceil(Buffer.byteLength(rawBody, "utf8") / 4));
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ input_tokens: est }));
				return;
			}

			if (urlPath !== "/v1/messages" || req.method !== "POST") {
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: { type: "not_found_error", message: "Not found" } }));
				return;
			}

			let body;
			try {
				body = JSON.parse(rawBody || "{}");
			} catch {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "Invalid JSON" } }));
				return;
			}

			const requestedModel = String(body.model || "gemini-4-argon-high");
			const stream = Boolean(body.stream);

			const fastPath = extractSlashCommandFastPath(body, env.pluginRoot);
			if (fastPath) {
				const respParams = {
					model: resolveModelAlias(requestedModel) || requestedModel,
					text: fastPath.text,
					toolCalls: fastPath.toolCalls,
					inputTokens: 64,
					outputTokens: 32,
				};
				if (stream) {
					writeAnthropicSseResponse(res, respParams);
				} else {
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify(formatAnthropicJsonResponse(respParams)));
				}
				return;
			}

			const nowMs = Date.now();
			const snapshot = loadRollingQuotaSnapshot({
				pluginDataDir: env.pluginDataDir,
				weeklyBudgets: env.weeklyBudgets,
				nowMs,
			});
			const health = detectProviderHealth(env, nowMs);
			const candidates = resolveGatewayCandidates({
				rawModel: requestedModel,
				messages: body.messages,
				tools: body.tools,
				maxTokens: body.max_tokens,
				snapshot,
				health,
			});

			const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
			const promptText = buildGatewayPrompt(body);
			const gatewayCwd = getIsolatedGatewayCwd();
			const errors = [];

			for (const candidate of candidates) {
				const providerHealth = health[candidate.provider];
				if (!providerHealth || providerHealth.kind !== "healthy") {
					errors.push(`${candidate.provider} unavailable`);
					continue;
				}

				const execResult = await providerRunner({
					provider: candidate.provider,
					binaryPath: providerHealth.binaryPath,
					prompt: promptText,
					modelSlug: candidate.modelSlug,
					effort: candidate.effort,
					mode: "plan",
					cwd: gatewayCwd,
					jsonSchema: hasTools && candidate.provider === "agy" ? GATEWAY_TURN_JSON_SCHEMA : undefined,
					timeoutMs: candidate.timeoutMs ?? 180_000,
				});

				if (execResult.kind === "success") {
					const parsedOut = parseStructuredGatewayOutput(
						execResult.payload,
						Boolean(hasTools && candidate.provider === "agy")
					);

					appendUsageEvent({
						pluginDataDir: env.pluginDataDir,
						event: {
							eventId: createTaskExecutionId(nowMs),
							sessionId: env.sessionId,
							recordedAt: nowMs,
							provider: candidate.provider,
							quotaPool: candidate.quotaPool,
							modelSlug: candidate.modelSlug,
							taskKind: "coding-complex",
							inputTokens: execResult.payload.usage.inputTokens,
							outputTokens: execResult.payload.usage.outputTokens,
							thinkingTokens: execResult.payload.usage.thinkingTokens,
							cacheReadTokens: execResult.payload.usage.cacheReadTokens,
							totalTokens: execResult.payload.usage.totalTokens,
							durationMs: execResult.durationMs,
							status: "SUCCESS",
						},
					});

					const respParams = {
						model: candidate.modelSlug,
						text: parsedOut.text,
						toolCalls: parsedOut.toolCalls,
						inputTokens: execResult.payload.usage.inputTokens || 100,
						outputTokens: execResult.payload.usage.outputTokens || 30,
					};

					if (stream) {
						writeAnthropicSseResponse(res, respParams);
					} else {
						res.writeHead(200, { "Content-Type": "application/json" });
						res.end(JSON.stringify(formatAnthropicJsonResponse(respParams)));
					}
					return;
				}

				errors.push(`${candidate.modelSlug}: ${execResult.message}`);
			}

			const fallbackResp = {
				model: resolveModelAlias(requestedModel) || "gemini-4-argon-high",
				text: `[claugle gateway] 모델 호출에 실패했습니다: ${errors.join(" | ")}`,
				toolCalls: [],
				inputTokens: 10,
				outputTokens: 20,
			};
			if (stream) {
				writeAnthropicSseResponse(res, fallbackResp);
			} else {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(formatAnthropicJsonResponse(fallbackResp)));
			}
		});
	});

	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			const addr = server.address();
			const boundPort = typeof addr === "object" && addr ? addr.port : port;
			resolve({
				server,
				port: boundPort,
				host,
				url: `http://${host}:${boundPort}`,
			});
		});
	});
}

function probeGatewayHealth(host, port, timeoutMs = 400) {
	return new Promise((resolve) => {
		const req = http.request(
			{
				host,
				port,
				path: "/api/hello",
				method: "GET",
				timeout: timeoutMs,
			},
			(res) => {
				res.resume();
				resolve(res.statusCode === 200);
			}
		);
		req.on("error", () => resolve(false));
		req.on("timeout", () => {
			req.destroy();
			resolve(false);
		});
		req.end();
	});
}

export async function ensureGatewayDaemon({
	port = DEFAULT_GATEWAY_PORT,
	host = "127.0.0.1",
	pluginRoot,
} = {}) {
	const url = `http://${host}:${port}`;
	if (await probeGatewayHealth(host, port)) {
		return { status: "already-running", port, host, url };
	}

	const resolvedPluginRoot =
		pluginRoot ||
		path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const cliPath = path.join(resolvedPluginRoot, "scripts", "claugle.mjs");

	const child = spawn(process.execPath, [cliPath, "gateway", "--port", String(port)], {
		detached: true,
		stdio: "ignore",
		env: {
			...process.env,
			CLAUDE_PLUGIN_ROOT: resolvedPluginRoot,
		},
	});
	child.unref();

	for (let i = 0; i < 20; i += 1) {
		await new Promise((r) => setTimeout(r, 125));
		if (await probeGatewayHealth(host, port)) {
			return { status: "started", pid: child.pid, port, host, url };
		}
	}

	return { status: "failed-to-start", port, host, url };
}
