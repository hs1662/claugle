import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { appendUsageEvent, loadRollingQuotaSnapshot } from "./ledger-store.mjs";
import {
	ANTHROPIC_BUILTIN_CATALOG,
	DEFAULT_POLICY_MATRIX,
	MODEL_CAPABILITIES,
	MODEL_FAMILY_CATALOG,
	buildClaudeModelPickerConfig,
	classifyTask,
	createTaskExecutionId,
	isPoolRecentlyExhausted,
	parsePluginEnv,
	parseTaskRequest,
	resolveBuiltinAnthropicModel,
	resolveModelAlias,
	resolveModelAndEffort,
	resolveRoutePlan,
} from "./policy-engine.mjs";
import { detectProviderHealth, prepareAgyHome, recordCircuitBreakerOpen, runHeadlessProvider, writeAgyAgent, writeAgyToolGate } from "./provider-runner.mjs";

export const DEFAULT_GATEWAY_PORT = 18789;
// Claude Code aborts a stream that stays silent for its idle timeout, which is at least 300 s.
const DEFAULT_GATEWAY_REQUEST_BUDGET_MS = 280_000;
const ADMIN_HEADER = "x-claugle-admin";

function computeGatewayBuildId(pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")) {
	const scriptsDir = path.join(pluginRoot, "scripts");
	const hash = crypto.createHash("sha256");
	for (const name of fs.readdirSync(scriptsDir).filter((f) => f.endsWith(".mjs")).sort()) {
		hash.update(name);
		hash.update(fs.readFileSync(path.join(scriptsDir, name)));
	}
	return hash.digest("hex").slice(0, 16);
}

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

function describeUnforwardableBlock(block) {
	if (block?.type === "image" || block?.type === "document") {
		const mediaType = block.source?.media_type ?? block.source?.type ?? "unknown";
		return `[${block.type} omitted: the claugle gateway cannot forward ${mediaType} ${block.type}s to agy]`;
	}
	return null;
}

function extractToolResultText(block) {
	if (!block || typeof block !== "object") return "";
	if (typeof block.content === "string") return block.content;
	if (Array.isArray(block.content)) {
		return block.content
			.map((item) =>
				item && typeof item.text === "string" ? item.text : describeUnforwardableBlock(item) ?? ""
			)
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

function makeGatewayTarget(modelSlug, effortOverride) {
	const resolved = resolveModelAndEffort(
		modelSlug,
		effortOverride,
		{ preferExplicitEffort: Boolean(effortOverride) }
	);
	const effectiveSlug = resolved?.modelSlug ?? modelSlug;
	const cap = MODEL_CAPABILITIES[effectiveSlug];
	if (!cap) return null;
	return Object.freeze({
		provider: cap.provider,
		quotaPool: cap.quotaPool,
		modelSlug: cap.slug,
		family: cap.family,
		effort: resolved?.effort ?? effortOverride ?? cap.defaultEffort,
		agyMode: "plan",
		isolation: Object.freeze({ kind: "read-only" }),
		timeoutMs: 180_000,
	});
}

export function readConfiguredModelEffort(
	rawModel,
	settingsPath = path.join(os.homedir(), ".claude", "settings.json")
) {
	try {
		if (!fs.existsSync(settingsPath)) return undefined;
		const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
		const cleaned = String(rawModel || "").trim().replace(/\[[^\]]+\]$/i, "");
		const entry =
			parsed?.modelSettings?.[cleaned] ??
			parsed?.modelSettings?.[cleaned.toLowerCase()];
		if (typeof entry?.effortLevel === "string" && entry.effortLevel.trim()) {
			return entry.effortLevel.trim().toLowerCase();
		}
		if (typeof parsed?.effortLevel === "string" && parsed.effortLevel.trim()) {
			return parsed.effortLevel.trim().toLowerCase();
		}
	} catch {
		return undefined;
	}
	return undefined;
}

const LOOPBACK_URL = /^http:\/\/(127\.0\.0\.1|localhost):(\d+)\/?$/i;

export function parseGatewayPort(raw) {
	const port = Number(raw);
	return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_GATEWAY_PORT;
}

export function readSettingsBaseUrl(settingsPath = path.join(os.homedir(), ".claude", "settings.json")) {
	try {
		const url = JSON.parse(fs.readFileSync(settingsPath, "utf8"))?.env?.ANTHROPIC_BASE_URL;
		return typeof url === "string" ? url : undefined;
	} catch {
		return undefined;
	}
}

export async function isReplaceableLocalBaseUrl(url) {
	const match = LOOPBACK_URL.exec(String(url ?? ""));
	if (!match) return false;
	const probe = await new Promise((resolve) => {
		const req = http.request({ host: match[1], port: Number(match[2]), path: "/health", method: "GET", timeout: 1000, agent: false }, (res) => {
			let text = "";
			res.on("data", (chunk) => (text += chunk));
			res.on("end", () => {
				try {
					resolve({ kind: "answered", service: JSON.parse(text)?.service });
				} catch {
					resolve({ kind: "answered" });
				}
			});
		});
		req.on("timeout", () => {
			req.destroy();
			resolve({ kind: "slow" });
		});
		req.on("error", (err) => resolve({ kind: err?.code === "ECONNREFUSED" ? "refused" : "unknown" }));
		req.on("close", () => resolve({ kind: "unknown" }));
		req.end();
	});
	return probe.kind === "refused" || (probe.kind === "answered" && probe.service === "claugle-gateway");
}

export function syncClaudeModelPickerSettings({
	settingsPath = path.join(os.homedir(), ".claude", "settings.json"),
	selectedModel,
	selectedEffort,
	gatewayUrl = `http://127.0.0.1:${DEFAULT_GATEWAY_PORT}`,
	replaceLocalBaseUrl = false,
} = {}) {
	let current = {};
	if (fs.existsSync(settingsPath)) {
		try {
			current = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
		} catch (err) {
			return {
				kind: "error",
				message: `settings.json을 해석할 수 없어 변경하지 않았습니다 (${settingsPath}): ${err instanceof Error ? err.message : String(err)}`,
			};
		}
		if (!current || typeof current !== "object" || Array.isArray(current)) {
			return {
				kind: "error",
				message: `settings.json이 JSON 객체가 아니라서 변경하지 않았습니다 (${settingsPath}).`,
			};
		}
	}

	const pickerConfig = buildClaudeModelPickerConfig();
	const mergedModelSettings = {
		...pickerConfig.modelSettings,
		...(current.modelSettings && typeof current.modelSettings === "object"
			? current.modelSettings
			: {}),
	};

	for (const [key, defaults] of Object.entries(pickerConfig.modelSettings)) {
		const existing = mergedModelSettings[key];
		mergedModelSettings[key] = {
			...(existing && typeof existing === "object" ? existing : {}),
			effortLevel:
				existing && typeof existing.effortLevel === "string"
					? existing.effortLevel
					: defaults.effortLevel,
			maxEffortLevel: defaults.maxEffortLevel,
		};
	}

	let activeFamilyOrModel =
		typeof current.model === "string" && current.model.trim()
			? current.model.trim()
			: undefined;
	let activeEffort = activeFamilyOrModel
		? mergedModelSettings[activeFamilyOrModel]?.effortLevel ?? "high"
		: undefined;

	if (selectedModel !== undefined && selectedModel !== null && String(selectedModel).trim() !== "") {
		const resolved =
			resolveModelAndEffort(
				String(selectedModel),
				selectedEffort,
				{ preferExplicitEffort: Boolean(selectedEffort) }
			) ?? resolveBuiltinAnthropicModel(String(selectedModel), selectedEffort);
		if (!resolved) {
			return {
				kind: "error",
				message: `지원하지 않는 모델입니다: "${selectedModel}"`,
			};
		}
		activeFamilyOrModel = resolved.familyId;
		activeEffort = resolved.effort;
		const maxEffort =
			pickerConfig.modelSettings[activeFamilyOrModel]?.maxEffortLevel ?? "high";
		mergedModelSettings[activeFamilyOrModel] = {
			...(mergedModelSettings[activeFamilyOrModel] || {}),
			effortLevel: activeEffort,
			maxEffortLevel: maxEffort,
		};
		if (resolved.modelSlug) {
			mergedModelSettings[resolved.modelSlug] = {
				...(mergedModelSettings[resolved.modelSlug] || {}),
				effortLevel: activeEffort,
				maxEffortLevel: maxEffort,
			};
		}
	} else if (selectedEffort !== undefined && selectedEffort !== null && String(selectedEffort).trim() !== "") {
		if (!activeFamilyOrModel) {
			return {
				kind: "error",
				message: "현재 설정된 모델이 없어 강도만 바꿀 수 없습니다. 모델과 강도를 함께 지정하세요.",
			};
		}
		const resolved =
			resolveModelAndEffort(
				activeFamilyOrModel,
				selectedEffort,
				{ preferExplicitEffort: true }
			) ?? resolveBuiltinAnthropicModel(activeFamilyOrModel, selectedEffort);
		if (resolved) {
			activeFamilyOrModel = resolved.familyId;
			activeEffort = resolved.effort;
			const maxEffort =
				pickerConfig.modelSettings[activeFamilyOrModel]?.maxEffortLevel ?? "high";
			mergedModelSettings[activeFamilyOrModel] = {
				...(mergedModelSettings[activeFamilyOrModel] || {}),
				effortLevel: activeEffort,
				maxEffortLevel: maxEffort,
			};
		}
	}

	const updated = {
		...current,
		env: {
			...(current.env && typeof current.env === "object" ? current.env : {}),
			ANTHROPIC_BASE_URL:
				current.env?.ANTHROPIC_BASE_URL && !(replaceLocalBaseUrl && LOOPBACK_URL.test(current.env.ANTHROPIC_BASE_URL))
					? current.env.ANTHROPIC_BASE_URL
					: gatewayUrl,
			CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
			CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: "1",
		},
		...(activeFamilyOrModel ? { model: activeFamilyOrModel } : {}),
		modelPicker: pickerConfig.modelPicker,
		modelSettings: mergedModelSettings,
	};

	const tmpPath = `${settingsPath}.tmp-${process.pid}-${Date.now()}`;
	try {
		fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
		fs.writeFileSync(tmpPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
		fs.renameSync(tmpPath, settingsPath);
	} catch (err) {
		try {
			fs.rmSync(tmpPath, { force: true });
		} catch {}
		return {
			kind: "error",
			message: `settings.json을 쓸 수 없어 변경하지 않았습니다 (${settingsPath}): ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	const effectiveResolved = activeFamilyOrModel
		? resolveModelAndEffort(activeFamilyOrModel, activeEffort, { preferExplicitEffort: true }) ??
			resolveBuiltinAnthropicModel(activeFamilyOrModel, activeEffort)
		: null;

	return {
		kind: "ok",
		settingsPath,
		activeModel: activeFamilyOrModel ?? null,
		activeEffort: activeEffort ?? null,
		resolvedModelSlug: effectiveResolved?.modelSlug ?? null,
		routingMode: effectiveResolved?.mode ?? (activeFamilyOrModel ? "pinned" : "claude-native"),
		availableFamilies: [...ANTHROPIC_BUILTIN_CATALOG, ...MODEL_FAMILY_CATALOG].map((f) => ({
			familyId: f.familyId,
			label: f.label,
			provider: f.provider,
			defaultEffort: f.defaultEffort,
			supportedEfforts: f.supportedEfforts,
			variantsByEffort: f.variantsByEffort,
		})),
	};
}

export function resolveGatewayCandidates({
	rawModel,
	rawEffort,
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

	const resolvedSelection = resolveModelAndEffort(rawModel, rawEffort);
	if (resolvedSelection && resolvedSelection.mode === "pinned" && resolvedSelection.modelSlug) {
		const primaryTarget = makeGatewayTarget(
			resolvedSelection.modelSlug,
			resolvedSelection.effort
		);
		return [primaryTarget].filter(Boolean);
	}

	const modelLower = String(rawModel || "").toLowerCase();
	const hasTools = Array.isArray(tools) && tools.length > 0;
	if (modelLower.includes("haiku") && (!hasTools || Number(maxTokens) <= 300)) {
		return [
			makeGatewayTarget("gemini-3.8-flash-low"),
			makeGatewayTarget("gemini-4-argon-low"),
		].filter(Boolean);
	}

	const builtinSelection = resolveBuiltinAnthropicModel(rawModel, rawEffort);
	if (builtinSelection && builtinSelection.familyId !== "default") {
		const mappedFamilyId =
			builtinSelection.familyId === "opus" || builtinSelection.familyId === "fable"
				? "agy-opus-5-5"
				: builtinSelection.familyId === "sonnet"
					? "agy-sonnet-5-5"
					: "gemini-3.8-flash";
		const primaryAgy = resolveModelAndEffort(mappedFamilyId, builtinSelection.effort);
		const backupArgon = resolveModelAndEffort("gemini-4-argon", builtinSelection.effort);
		const candidates = [
			primaryAgy?.modelSlug ? makeGatewayTarget(primaryAgy.modelSlug, primaryAgy.effort) : null,
			backupArgon?.modelSlug ? makeGatewayTarget(backupArgon.modelSlug, backupArgon.effort) : null,
			...fallbackSlugs.map((s) => makeGatewayTarget(s)),
		].filter(Boolean);
		const seen = new Set();
		return candidates.filter((c) => {
			if (seen.has(c.modelSlug)) return false;
			seen.add(c.modelSlug);
			return true;
		});
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
		cwd: os.tmpdir(),
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

function renderSystemPrompt(system) {
	if (typeof system === "string") return system;
	if (!Array.isArray(system)) return "";
	return system
		.map((block) => (block && typeof block.text === "string" ? block.text : ""))
		.filter(Boolean)
		.join("\n\n");
}

export function buildGatewayPrompt(body) {
	const sections = [
		"You are the model engine running inside the Claude Code harness. Claude Code executes every tool call. You have no tools of your own, and any attempt to use one is denied.",
	];

	const systemPrompt = renderSystemPrompt(body?.system);
	if (systemPrompt) {
		sections.push("", "<claude_code_system_prompt>", systemPrompt, "</claude_code_system_prompt>");
	}

	const tools = Array.isArray(body?.tools) ? body.tools : [];
	if (tools.length > 0) {
		sections.push(
			"",
			"Answer through the response schema. Put prose in text. To have Claude Code run a tool, add an entry to tool_calls whose name is the tool name and whose input_json is a JSON-encoded object that satisfies that tool's input_schema. Leave tool_calls empty when no tool is needed.",
			"",
			"<claude_code_tools>"
		);
		for (const tool of tools) {
			if (!tool || typeof tool.name !== "string") continue;
			sections.push(
				JSON.stringify({
					name: tool.name,
					description: typeof tool.description === "string" ? tool.description : "",
					input_schema: tool.input_schema ?? {},
				})
			);
		}
		sections.push("</claude_code_tools>");
		const toolChoice = body?.tool_choice;
		if (toolChoice?.type === "tool" && typeof toolChoice.name === "string") {
			sections.push(`In this turn you must call the ${toolChoice.name} tool.`);
		} else if (toolChoice?.type === "any") {
			sections.push("In this turn you must call at least one tool.");
		} else if (toolChoice?.type === "none") {
			sections.push("In this turn you must not call any tool.");
		}
	}

	sections.push("", "Conversation transcript:");
	const messages = Array.isArray(body?.messages) ? body.messages : [];
	for (const msg of messages) {
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
				} else if (describeUnforwardableBlock(block)) {
					blocks.push(describeUnforwardableBlock(block));
				} else if (block.type === "tool_use") {
					blocks.push(
						`[tool_use id=${block.id} name=${block.name} input=${JSON.stringify(block.input ?? {})}]`
					);
				} else if (block.type === "tool_result") {
					blocks.push(
						`[tool_result tool_use_id=${block.tool_use_id} is_error=${Boolean(block.is_error)}]\n${extractToolResultText(block)}`
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

function parseToolCallInput(call) {
	if (typeof call.input_json === "string") {
		if (!call.input_json.trim()) return {};
		try {
			const candidate = JSON.parse(call.input_json);
			return candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate : null;
		} catch {
			return null;
		}
	}
	if (call.input === undefined) return {};
	return call.input && typeof call.input === "object" && !Array.isArray(call.input) ? call.input : null;
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
		let text = typeof parsedObj.text === "string" ? parsedObj.text : "";
		const rawCalls = Array.isArray(parsedObj.tool_calls) ? parsedObj.tool_calls : [];
		const toolCalls = [];
		for (const call of rawCalls) {
			if (!call || typeof call.name !== "string" || !call.name.trim()) continue;
			const inputObj = parseToolCallInput(call);
			if (!inputObj) {
				text = `${text}${text ? "\n" : ""}[claugle gateway] dropped a ${call.name.trim()} tool call because its input_json was not a JSON object.`;
				continue;
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

function prepareGatewayWorkspace(pluginDataDir) {
	const dir = writeAgyToolGate(path.join(pluginDataDir, "gateway-workspace"), {
		denyReason: "claugle gateway: agy tools are disabled. Return tool calls to Claude Code through tool_calls.",
	});
	writeAgyAgent(dir, "claugle-gateway");
	return dir;
}

function sendGatewayError(res, status, errorType, message, { retryable = true } = {}) {
	if (res.headersSent) {
		res.destroy();
		return;
	}
	res.writeHead(status, {
		"Content-Type": "application/json",
		...(retryable ? {} : { "x-should-retry": "false" }),
	});
	res.end(JSON.stringify({ type: "error", error: { type: errorType, message } }));
}

const UNFORWARDED_HEADERS = new Set([
	"host",
	"connection",
	"keep-alive",
	"transfer-encoding",
	"upgrade",
	"te",
	"trailer",
	"proxy-authorization",
	"proxy-connection",
	"content-length",
	"accept-encoding",
	"content-encoding",
]);

async function proxyToAnthropic({ req, res, rawBody, upstreamBaseUrl }) {
	const headers = {};
	for (const [name, value] of Object.entries(req.headers)) {
		if (typeof value === "string" && !UNFORWARDED_HEADERS.has(name)) {
			headers[name] = value;
		}
	}
	const abort = new AbortController();
	res.on("close", () => abort.abort());

	let upstream;
	try {
		upstream = await fetch(`${upstreamBaseUrl}${req.url || "/v1/messages"}`, {
			method: req.method,
			headers,
			body: rawBody,
			signal: abort.signal,
		});
	} catch (err) {
		sendGatewayError(
			res,
			502,
			"api_error",
			`claugle gateway could not reach ${upstreamBaseUrl}: ${err instanceof Error ? err.message : String(err)}`
		);
		return;
	}

	const responseHeaders = {};
	upstream.headers.forEach((value, name) => {
		if (!UNFORWARDED_HEADERS.has(name)) responseHeaders[name] = value;
	});
	res.writeHead(upstream.status, responseHeaders);
	if (!upstream.body) {
		res.end();
		return;
	}
	Readable.fromWeb(upstream.body)
		.on("error", () => res.destroy())
		.pipe(res);
}

function isLocalHostHeader(hostHeader, port) {
	if (hostHeader === undefined) return true;
	return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(String(hostHeader).toLowerCase());
}

export function startAnthropicGatewayServer({
	port = DEFAULT_GATEWAY_PORT,
	host = "127.0.0.1",
	env: rawEnv = process.env,
	providerRunner = runHeadlessProvider,
	buildId = computeGatewayBuildId(),
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
					build: buildId,
				})
			);
			return;
		}

		const boundPort = server.address()?.port;
		if (!isLocalHostHeader(req.headers.host, boundPort)) {
			sendGatewayError(res, 403, "permission_error", "claugle gateway only serves requests addressed to localhost.", { retryable: false });
			return;
		}

		if (urlPath === "/admin/shutdown" && req.method === "POST") {
			if (req.headers[ADMIN_HEADER] !== "shutdown") {
				sendGatewayError(res, 403, "permission_error", `missing ${ADMIN_HEADER} header`, { retryable: false });
				return;
			}
			res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
			res.end(JSON.stringify({ status: "shutting-down", build: buildId }));
			server.close();
			res.on("finish", () => server.closeIdleConnections?.());
			return;
		}

		if (req.method === "POST" && !/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) {
			sendGatewayError(res, 415, "invalid_request_error", "claugle gateway accepts only application/json requests.", { retryable: false });
			return;
		}

		if (urlPath === "/v1/models" && req.method === "GET") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					object: "list",
					data: [...ANTHROPIC_BUILTIN_CATALOG, ...MODEL_FAMILY_CATALOG].map((entry) => ({
						id: entry.familyId,
						type: "model",
						display_name: entry.label,
						description: entry.description,
						created_at: "2026-01-01T00:00:00Z",
					})),
				})
			);
			return;
		}

		const chunks = [];
		req.on("data", (chunk) => {
			chunks.push(chunk);
		});

		req.on("end", () => {
			handleMessagesRequest(req, res, urlPath, Buffer.concat(chunks)).catch((err) => {
				sendGatewayError(
					res,
					500,
					"api_error",
					`claugle gateway internal error: ${err instanceof Error ? err.message : String(err)}`,
					{ retryable: false }
				);
			});
		});
	});

	async function handleMessagesRequest(req, res, urlPath, rawBody) {
		const isCountTokens = urlPath === "/v1/messages/count_tokens";
		if ((urlPath !== "/v1/messages" && !isCountTokens) || req.method !== "POST") {
			sendGatewayError(res, 404, "not_found_error", "Not found");
			return;
		}

		let body;
		try {
			body = JSON.parse(rawBody.toString("utf8") || "{}");
		} catch {
			sendGatewayError(res, 400, "invalid_request_error", "Invalid JSON");
			return;
		}

		const requestedModel = String(body.model || "gemini-4-argon");
		const requestedEffort =
			body.output_config?.effort ??
			body.thinking?.effort ??
			readConfiguredModelEffort(requestedModel);
		const stream = Boolean(body.stream);

		const googleSelection = resolveModelAndEffort(requestedModel, requestedEffort);
		if (!googleSelection && rawEnv?.CLAUGLE_DISABLE_UPSTREAM_PROXY !== "1") {
			await proxyToAnthropic({
				req,
				res,
				rawBody,
				upstreamBaseUrl: rawEnv?.CLAUGLE_UPSTREAM_ANTHROPIC_URL || "https://api.anthropic.com",
			});
			return;
		}

		if (isCountTokens) {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ input_tokens: Math.max(1, Math.ceil(rawBody.length / 4)) }));
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
			rawEffort: requestedEffort,
			messages: body.messages,
			tools: body.tools,
			maxTokens: body.max_tokens,
			snapshot,
			health,
		});

		const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
		const promptText = buildGatewayPrompt(body);
		const gatewayCwd = prepareGatewayWorkspace(env.pluginDataDir);
		const errors = [];
		const clientGone = new AbortController();
		res.on("close", () => {
			if (!res.writableFinished) clientGone.abort();
		});
		const budgetMs = Number(rawEnv?.CLAUGLE_GATEWAY_REQUEST_BUDGET_MS) > 0
			? Number(rawEnv.CLAUGLE_GATEWAY_REQUEST_BUDGET_MS)
			: DEFAULT_GATEWAY_REQUEST_BUDGET_MS;
		const deadline = Date.now() + budgetMs;

		for (const candidate of candidates) {
			if (clientGone.signal.aborted) return;
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) {
				errors.push(`request budget of ${budgetMs}ms exhausted`);
				break;
			}
			if (candidate.provider !== "agy") {
				errors.push(`${candidate.modelSlug}: ${candidate.provider} is not used by the gateway because its tools cannot be gated`);
				continue;
			}
			const providerHealth = health[candidate.provider];
			if (!providerHealth || providerHealth.kind !== "healthy") {
				errors.push(`${candidate.provider} unavailable`);
				continue;
			}
			if (providerHealth.openCircuits?.some((circuit) => circuit.quotaPool === candidate.quotaPool)) {
				errors.push(`${candidate.modelSlug}: ${candidate.quotaPool} is paused after a recent failure`);
				continue;
			}
			if (isPoolRecentlyExhausted(snapshot.metrics.pools[candidate.quotaPool], snapshot.metrics.windowEnd)) {
				errors.push(`${candidate.modelSlug}: ${candidate.quotaPool} reported quota exhaustion recently`);
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
				agyHome: prepareAgyHome(env.pluginDataDir),
				agent: "claugle-gateway",
				jsonSchema: hasTools ? GATEWAY_TURN_JSON_SCHEMA : undefined,
				timeoutMs: Math.min(candidate.timeoutMs ?? 180_000, remainingMs),
				signal: clientGone.signal,
			});
			if (clientGone.signal.aborted) return;

			if (execResult.kind !== "success") {
				errors.push(`${candidate.modelSlug}: ${execResult.message}`);
				if (execResult.reason === "QUOTA_EXHAUSTED" || execResult.reason === "RATE_LIMITED") {
					const failedAt = Date.now();
					recordCircuitBreakerOpen({
						pluginDataDir: env.pluginDataDir,
						provider: candidate.provider,
						quotaPool: candidate.quotaPool,
						binaryPath: providerHealth.binaryPath,
						reason: execResult.reason,
						nowMs: failedAt,
					});
					appendUsageEvent({
						pluginDataDir: env.pluginDataDir,
						event: {
							eventId: createTaskExecutionId(failedAt),
							sessionId: env.sessionId,
							recordedAt: failedAt,
							provider: candidate.provider,
							quotaPool: candidate.quotaPool,
							modelSlug: candidate.modelSlug,
							taskKind: "coding-complex",
							totalTokens: 0,
							durationMs: execResult.durationMs ?? 0,
							status: execResult.reason === "QUOTA_EXHAUSTED" ? "QUOTA_EXHAUSTED" : "ERROR",
						},
					});
				}
				continue;
			}

			const parsedOut = parseStructuredGatewayOutput(execResult.payload, hasTools);
			const isEmpty = !parsedOut.text.trim() && parsedOut.toolCalls.length === 0;
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
					status: isEmpty ? "ERROR" : "SUCCESS",
				},
			});

			if (isEmpty) {
				errors.push(`${candidate.modelSlug}: empty response (no text and no tool calls)`);
				continue;
			}

			const respParams = {
				model: candidate.modelSlug,
				text: parsedOut.text,
				toolCalls: parsedOut.toolCalls,
				inputTokens: execResult.payload.usage.inputTokens,
				outputTokens: execResult.payload.usage.outputTokens,
			};
			if (stream) {
				writeAnthropicSseResponse(res, respParams);
			} else {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(formatAnthropicJsonResponse(respParams)));
			}
			return;
		}

		sendGatewayError(
			res,
			502,
			"api_error",
			`claugle gateway: no agy candidate produced a response. ${errors.join(" | ") || "no candidates"}`,
			{ retryable: false }
		);
	}

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

function requestGateway(host, port, { method = "GET", path: urlPath = "/health", headers = {}, timeoutMs = 400 } = {}) {
	return new Promise((resolve) => {
		const req = http.request({ host, port, path: urlPath, method, headers, timeout: timeoutMs, agent: false }, (res) => {
			let text = "";
			res.on("data", (chunk) => (text += chunk));
			res.on("end", () => {
				let json = null;
				try {
					json = JSON.parse(text);
				} catch {}
				resolve({ status: res.statusCode, json });
			});
		});
		req.on("error", () => resolve(null));
		req.on("timeout", () => {
			req.destroy();
			resolve(null);
		});
		req.end();
	});
}

async function probeGatewayHealth(host, port) {
	const res = await requestGateway(host, port);
	return res && res.status === 200 ? res.json ?? {} : null;
}

async function waitFor(predicate, deadlineMs = 3000, intervalMs = 125) {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	return false;
}

function stopClaugleDaemonsOnPort(port) {
	let listing = "";
	try {
		listing = execFileSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return 0;
	}
	let stopped = 0;
	for (const line of listing.split("\n")) {
		const match = /^\s*(\d+)\s+(.*)$/.exec(line);
		if (!match || Number(match[1]) === process.pid) continue;
		const command = match[2];
		if (/claugle\.mjs\s+gateway\b/.test(command) && new RegExp(`--port[ =]${port}(\\s|$)`).test(command)) {
			try {
				process.kill(Number(match[1]), "SIGTERM");
				stopped += 1;
			} catch {}
		}
	}
	return stopped;
}

export async function ensureGatewayDaemon({
	port = DEFAULT_GATEWAY_PORT,
	host = "127.0.0.1",
	pluginRoot,
} = {}) {
	const url = `http://${host}:${port}`;
	const resolvedPluginRoot =
		pluginRoot ||
		path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const expectedBuild = computeGatewayBuildId(resolvedPluginRoot);
	const running = await probeGatewayHealth(host, port);
	let replaced = false;
	if (running) {
		if (running.build === expectedBuild) {
			return { status: "already-running", port, host, url, build: expectedBuild };
		}
		await requestGateway(host, port, {
			method: "POST",
			path: "/admin/shutdown",
			headers: { [ADMIN_HEADER]: "shutdown" },
		});
		let stopped = await waitFor(async () => !(await probeGatewayHealth(host, port)), 1500);
		if (!stopped && stopClaugleDaemonsOnPort(port) > 0) {
			stopped = await waitFor(async () => !(await probeGatewayHealth(host, port)), 1500);
		}
		if (!stopped) {
			return {
				status: "stale-daemon",
				port,
				host,
				url,
				runningBuild: running.build ?? null,
				expectedBuild,
				message: `An older claugle gateway is still listening on port ${port}. Stop that process so the current build can start.`,
			};
		}
		replaced = true;
	}

	const cliPath = path.join(resolvedPluginRoot, "scripts", "claugle.mjs");

	const child = spawn(process.execPath, [cliPath, "gateway", "--port", String(port)], {
		cwd: resolvedPluginRoot,
		detached: true,
		stdio: "ignore",
		env: {
			...process.env,
			CLAUDE_PLUGIN_ROOT: resolvedPluginRoot,
		},
	});
	child.unref();

	const healthy = await waitFor(async () => (await probeGatewayHealth(host, port))?.build === expectedBuild);
	if (healthy) {
		return { status: replaced ? "restarted" : "started", pid: child.pid, port, host, url, build: expectedBuild };
	}
	return { status: "failed-to-start", port, host, url };
}
