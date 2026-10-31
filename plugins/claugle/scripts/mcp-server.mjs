#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { loadRollingQuotaSnapshot } from "./ledger-store.mjs";
import {
	ALL_TASK_KINDS,
	EFFORT_LEVELS,
	MODEL_CAPABILITIES,
	parsePluginEnv,
	parseTaskRequest,
} from "./policy-engine.mjs";
import { detectProviderHealth, executeRoutedTask } from "./provider-runner.mjs";

const ALL_MODEL_SLUGS = Object.keys(MODEL_CAPABILITIES);

export const MCP_TOOL_DEFINITIONS = Object.freeze([
	Object.freeze({
		name: "claugle_run",
		description:
			"Route a coding, architecture, or research task through claugle's 32-cell policy matrix and execute on agy or gemini-cli with worktree isolation when file edits are enabled.",
		inputSchema: Object.freeze({
			type: "object",
			properties: Object.freeze({
				prompt: {
					type: "string",
					description: "Task instruction to route and execute.",
				},
				taskKind: {
					type: "string",
					enum: ALL_TASK_KINDS,
					description: "Optional explicit task classification override.",
				},
				preferredModel: {
					type: "string",
					enum: ALL_MODEL_SLUGS,
					description: "Optional preferred agy or gemini-cli model slug.",
				},
				effort: {
					type: "string",
					enum: EFFORT_LEVELS,
					description: "Reasoning effort level.",
				},
				contextFiles: {
					type: "array",
					items: { type: "string" },
					description: "Relative or absolute paths to include as context.",
				},
				allowFileEdits: {
					type: "boolean",
					description: "Whether the task may edit files in an isolated git worktree.",
				},
				allowedEditGlobs: {
					type: "array",
					items: { type: "string" },
					description: "Relative file globs permitted when allowFileEdits is true.",
				},
				applyStrategy: {
					type: "string",
					enum: ["patch-if-clean", "branch-only"],
					description: "How worktree edits are harvested back to the host repo.",
				},
				cwd: {
					type: "string",
					description: "Absolute working directory path.",
				},
			}),
			required: Object.freeze(["prompt"]),
		}),
	}),
	Object.freeze({
		name: "claugle_write",
		description:
			"Delegate prose writing, documentation, release notes, summarization, or translation to Google AI Gemini models to preserve native Claude Code quota.",
		inputSchema: Object.freeze({
			type: "object",
			properties: Object.freeze({
				prompt: {
					type: "string",
					description: "Writing, documentation, or translation instruction.",
				},
				taskKind: {
					type: "string",
					enum: ["writing", "docs", "translation"],
					description: "Writing sub-kind (defaults to writing or docs based on prompt).",
				},
				preferredModel: {
					type: "string",
					enum: ALL_MODEL_SLUGS,
					description: "Preferred Gemini or agy model slug (defaults to gemini-4-argon-high).",
				},
				effort: {
					type: "string",
					enum: EFFORT_LEVELS,
					description: "Reasoning effort level.",
				},
				contextFiles: {
					type: "array",
					items: { type: "string" },
					description: "Relative or absolute paths to include as context.",
				},
				allowFileEdits: {
					type: "boolean",
					description: "Set true when updating markdown or documentation files in place.",
				},
				allowedEditGlobs: {
					type: "array",
					items: { type: "string" },
					description: "Allowed relative globs when allowFileEdits is true.",
				},
				cwd: {
					type: "string",
					description: "Absolute working directory path.",
				},
			}),
			required: Object.freeze(["prompt"]),
		}),
	}),
	Object.freeze({
		name: "claugle_review",
		description:
			"Run a read-only code review or security audit via agy (Claude Sonnet/Opus 5.5 or Gemini 4 Argon) without consuming native Claude Code tokens.",
		inputSchema: Object.freeze({
			type: "object",
			properties: Object.freeze({
				prompt: {
					type: "string",
					description: "Review instruction, diff description, or audit scope.",
				},
				preferredModel: {
					type: "string",
					enum: ALL_MODEL_SLUGS,
					description: "Preferred review model slug.",
				},
				effort: {
					type: "string",
					enum: EFFORT_LEVELS,
					description: "Reasoning effort level.",
				},
				contextFiles: {
					type: "array",
					items: { type: "string" },
					description: "Files to include in the review prompt.",
				},
				cwd: {
					type: "string",
					description: "Absolute working directory path.",
				},
			}),
			required: Object.freeze(["prompt"]),
		}),
	}),
	Object.freeze({
		name: "claugle_quota",
		description:
			"Inspect the 7-day rolling token usage ledger across claude-code-native, agy-claude-pool, agy-gemini-pool, and gemini-cli-pool, plus the current hysteresis QuotaState and provider health.",
		inputSchema: Object.freeze({
			type: "object",
			properties: Object.freeze({}),
		}),
	}),
]);

async function callMcpTool(name, args = {}, rawEnv = process.env) {
	const envRes = parsePluginEnv(rawEnv);
	if (envRes.kind === "error") {
		return {
			isError: true,
			content: [{ type: "text", text: `Invalid plugin environment: ${envRes.message}` }],
		};
	}
	const env = envRes.value;

	if (name === "claugle_quota") {
		const snapshot = loadRollingQuotaSnapshot({
			pluginDataDir: env.pluginDataDir,
			weeklyBudgets: env.weeklyBudgets,
		});
		const health = detectProviderHealth(env);
		return {
			isError: false,
			content: [
				{
					type: "text",
					text: JSON.stringify(
						{
							quotaState: snapshot.quotaState,
							totalEventsInWindow: snapshot.totalEventsInWindow,
							shardCount: snapshot.shardCount,
							pools: snapshot.metrics.pools,
							providerHealth: health,
						},
						null,
						2
					),
				},
			],
		};
	}

	if (name !== "claugle_run" && name !== "claugle_write" && name !== "claugle_review") {
		return {
			isError: true,
			content: [{ type: "text", text: `Unknown tool "${name}".` }],
		};
	}

	const explicitTaskKind =
		name === "claugle_review"
			? "review"
			: name === "claugle_write"
				? args.taskKind || (args.allowFileEdits ? "docs" : "writing")
				: args.taskKind;

	const reqRes = parseTaskRequest({
		prompt: args.prompt,
		explicitTaskKind,
		preferredModel: args.preferredModel,
		preferredEffort: args.effort,
		cwd: args.cwd || env.projectDir,
		contextFiles: args.contextFiles,
		allowFileEdits: name === "claugle_review" ? false : Boolean(args.allowFileEdits),
		allowedEditGlobs: args.allowedEditGlobs,
		applyStrategy: args.applyStrategy,
	});

	if (reqRes.kind === "error") {
		return {
			isError: true,
			content: [{ type: "text", text: reqRes.message }],
		};
	}

	const outcome = await executeRoutedTask({
		request: reqRes.value,
		env,
	});

	return {
		isError: outcome.status === "FAILED",
		content: [
			{
				type: "text",
				text: JSON.stringify(
					{
						taskId: outcome.taskId,
						status: outcome.status,
						quotaState: outcome.plan.quotaState,
						taskKind: outcome.plan.classification.taskKind,
						selectedTarget: outcome.selectedTarget,
						attemptedCount: outcome.attemptedTargets.length,
						responseText: outcome.responseText,
						...(outcome.worktreeOutcome ? { worktreeOutcome: outcome.worktreeOutcome } : {}),
						...(outcome.ledgerEvent ? { usage: outcome.ledgerEvent } : {}),
					},
					null,
					2
				),
			},
		],
	};
}

export async function handleMcpJsonRpcRequest(message, rawEnv = process.env) {
	if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") {
		return {
			jsonrpc: "2.0",
			id: message?.id ?? null,
			error: {
				code: -32600,
				message: "Invalid JSON-RPC 2.0 request.",
			},
		};
	}

	const { id, method, params } = message;

	if (method === "notifications/initialized" || method === "notifications/cancelled") {
		return null;
	}

	if (method === "initialize") {
		return {
			jsonrpc: "2.0",
			id: id ?? null,
			result: {
				protocolVersion: params?.protocolVersion || "2024-11-05",
				capabilities: {
					tools: {
						listChanged: false,
					},
				},
				serverInfo: {
					name: "claugle",
					version: "1.0.0",
				},
			},
		};
	}

	if (method === "ping") {
		return {
			jsonrpc: "2.0",
			id: id ?? null,
			result: {},
		};
	}

	if (method === "tools/list") {
		return {
			jsonrpc: "2.0",
			id: id ?? null,
			result: {
				tools: MCP_TOOL_DEFINITIONS,
			},
		};
	}

	if (method === "tools/call") {
		const toolName = params?.name;
		const toolArgs = params?.arguments ?? {};
		try {
			const toolResponse = await callMcpTool(toolName, toolArgs, rawEnv);
			return {
				jsonrpc: "2.0",
				id: id ?? null,
				result: toolResponse,
			};
		} catch (err) {
			return {
				jsonrpc: "2.0",
				id: id ?? null,
				result: {
					isError: true,
					content: [
						{
							type: "text",
							text: `Tool execution error: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
				},
			};
		}
	}

	return {
		jsonrpc: "2.0",
		id: id ?? null,
		error: {
			code: -32601,
			message: `Method not found: ${String(method)}`,
		},
	};
}

export function startMcpServer({
	input = process.stdin,
	output = process.stdout,
	rawEnv = process.env,
} = {}) {
	const rl = readline.createInterface({
		input,
		crlfDelay: Infinity,
	});

	rl.on("line", async (line) => {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("Content-Length:")) {
			return;
		}
		let parsed;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			const errResp = {
				jsonrpc: "2.0",
				id: null,
				error: { code: -32700, message: "Parse error" },
			};
			output.write(`${JSON.stringify(errResp)}\n`);
			return;
		}

		const response = await handleMcpJsonRpcRequest(parsed, rawEnv);
		if (response !== null && response !== undefined) {
			output.write(`${JSON.stringify(response)}\n`);
		}
	});

	return rl;
}

const resolvedArgv1 =
	process.argv[1] && fs.existsSync(process.argv[1])
		? fs.realpathSync(process.argv[1])
		: process.argv[1];
const isMainModule =
	Boolean(resolvedArgv1) &&
	fs.realpathSync(fileURLToPath(import.meta.url)) === resolvedArgv1;

if (isMainModule) {
	startMcpServer();
}
