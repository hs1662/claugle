import fs from "node:fs";
import path from "node:path";
import {
	ALL_QUOTA_POOLS,
	ALL_QUOTA_STATES,
	ALL_TASK_KINDS,
	DEFAULT_GOVERNOR_THRESHOLDS,
	createTaskExecutionId,
	transitionQuotaState,
} from "./policy-engine.mjs";

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

function resolveLedgerDir(pluginDataDir) {
	return path.join(pluginDataDir, "ledger");
}

function sanitizeShardSegment(raw) {
	return String(raw || "default").replace(/[^a-zA-Z0-9._-]/g, "_") || "default";
}

function toSafeInt(value, fallback = 0) {
	const num = Number(value);
	return Number.isFinite(num) && num >= 0 ? Math.floor(num) : fallback;
}

export function normalizeUsageEvent(rawEvent, nowMs = Date.now()) {
	const eventId =
		typeof rawEvent?.eventId === "string" && rawEvent.eventId.length > 0
			? rawEvent.eventId
			: createTaskExecutionId(nowMs);
	const sessionId = sanitizeShardSegment(rawEvent?.sessionId || "default-session");
	const recordedAt = Number.isFinite(Number(rawEvent?.recordedAt))
		? Math.floor(Number(rawEvent.recordedAt))
		: Math.floor(nowMs);

	const provider =
		rawEvent?.provider === "agy" || rawEvent?.provider === "gemini-cli" || rawEvent?.provider === "claude-native"
			? rawEvent.provider
			: "agy";

	const defaultPool =
		provider === "claude-native"
			? "claude-code-native"
			: provider === "gemini-cli"
				? "gemini-cli-pool"
				: "agy-gemini-pool";

	const quotaPool = ALL_QUOTA_POOLS.includes(rawEvent?.quotaPool) ? rawEvent.quotaPool : defaultPool;
	const modelSlug = typeof rawEvent?.modelSlug === "string" && rawEvent.modelSlug.length > 0
		? rawEvent.modelSlug
		: provider === "claude-native"
			? "claude-host"
			: provider === "gemini-cli"
				? "gemini-2.5-pro"
				: "gemini-4-argon-high";

	const taskKind = ALL_TASK_KINDS.includes(rawEvent?.taskKind) ? rawEvent.taskKind : "coding-complex";
	const inputTokens = toSafeInt(rawEvent?.inputTokens, 0);
	const outputTokens = toSafeInt(rawEvent?.outputTokens, 0);
	const thinkingTokens = toSafeInt(rawEvent?.thinkingTokens, 0);
	const cacheReadTokens = toSafeInt(rawEvent?.cacheReadTokens, 0);
	const totalTokens = toSafeInt(
		rawEvent?.totalTokens,
		inputTokens + outputTokens + thinkingTokens
	);
	const durationMs = toSafeInt(rawEvent?.durationMs, 0);
	const status =
		rawEvent?.status === "QUOTA_EXHAUSTED" || rawEvent?.status === "ERROR"
			? rawEvent.status
			: "SUCCESS";

	return Object.freeze({
		eventId,
		sessionId,
		recordedAt,
		provider,
		quotaPool,
		modelSlug,
		taskKind,
		inputTokens,
		outputTokens,
		thinkingTokens,
		cacheReadTokens,
		totalTokens,
		durationMs,
		status,
	});
}

export function appendUsageEvent(arg1, arg2, arg3 = {}) {
	const isObjectCall =
		arg1 && typeof arg1 === "object" && ("pluginDataDir" in arg1 || "event" in arg1);
	const pluginDataDir = isObjectCall ? arg1.pluginDataDir : arg1;
	const rawEvent = isObjectCall ? arg1.event : arg2;
	const pid = isObjectCall ? (arg1.pid ?? process.pid) : (arg3?.pid ?? process.pid);

	const event = normalizeUsageEvent(rawEvent);
	const ledgerDir = resolveLedgerDir(pluginDataDir);
	fs.mkdirSync(ledgerDir, { recursive: true });

	const shardFilename = `shard-${sanitizeShardSegment(event.sessionId)}-${sanitizeShardSegment(pid)}.jsonl`;
	const shardPath = path.join(ledgerDir, shardFilename);
	fs.appendFileSync(shardPath, `${JSON.stringify(event)}\n`, "utf8");

	return Object.freeze({
		shardPath,
		event,
	});
}

function readShardEvents(shardPath) {
	let content;
	try {
		content = fs.readFileSync(shardPath, "utf8");
	} catch {
		return [];
	}

	const events = [];
	const lines = content.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed && typeof parsed === "object" && typeof parsed.eventId === "string") {
				events.push(normalizeUsageEvent(parsed));
			}
		} catch {
			continue;
		}
	}
	return events;
}

const DEFAULT_WEEKLY_BUDGETS = Object.freeze({
	"claude-code-native": 5_000_000,
	"agy-claude-pool": 8_000_000,
	"agy-gemini-pool": 15_000_000,
	"gemini-cli-pool": 10_000_000,
});

export function loadRollingQuotaSnapshot(arg1, arg2 = {}) {
	const isObjectCall =
		arg1 && typeof arg1 === "object" && "pluginDataDir" in arg1;
	const pluginDataDir = isObjectCall ? arg1.pluginDataDir : arg1;
	const opts = isObjectCall ? arg1 : arg2;

	const nowMs = Number.isFinite(Number(opts.nowMs)) ? Math.floor(Number(opts.nowMs)) : Date.now();
	const thresholds = opts.thresholds ?? DEFAULT_GOVERNOR_THRESHOLDS;
	const weeklyBudgets = {
		...DEFAULT_WEEKLY_BUDGETS,
		...(opts.weeklyBudgets ?? {}),
	};
	const previousState = ALL_QUOTA_STATES.includes(opts.previousState)
		? opts.previousState
		: "NORMAL";

	const windowStart = Math.max(0, nowMs - thresholds.windowDurationMs);
	const windowEnd = nowMs;

	const ledgerDir = resolveLedgerDir(pluginDataDir);
	let shardFiles = [];
	try {
		shardFiles = fs
			.readdirSync(ledgerDir)
			.filter((name) => name.startsWith("shard-") && name.endsWith(".jsonl"))
			.sort()
			.map((name) => path.join(ledgerDir, name));
	} catch {
		shardFiles = [];
	}

	const dedupedEvents = new Map();
	for (const shardPath of shardFiles) {
		const events = readShardEvents(shardPath);
		for (const ev of events) {
			if (!dedupedEvents.has(ev.eventId)) {
				dedupedEvents.set(ev.eventId, ev);
			}
		}
	}

	const poolStats = {};
	for (const poolId of ALL_QUOTA_POOLS) {
		poolStats[poolId] = {
			consumedTokens: 0,
			requestCount: 0,
			rateLimitHitsInWindow: 0,
			lastRateLimitAt: null,
		};
	}

	let totalEventsInWindow = 0;
	const sortedEvents = Array.from(dedupedEvents.values()).sort(
		(a, b) => a.recordedAt - b.recordedAt
	);

	for (const ev of sortedEvents) {
		if (ev.recordedAt < windowStart || ev.recordedAt > windowEnd) {
			continue;
		}
		totalEventsInWindow += 1;
		const stats = poolStats[ev.quotaPool];
		if (!stats) continue;

		stats.consumedTokens += ev.totalTokens;
		stats.requestCount += 1;
		if (ev.status === "QUOTA_EXHAUSTED") {
			stats.rateLimitHitsInWindow += 1;
			if (stats.lastRateLimitAt === null || ev.recordedAt > stats.lastRateLimitAt) {
				stats.lastRateLimitAt = ev.recordedAt;
			}
		}
	}

	const pools = {};
	for (const poolId of ALL_QUOTA_POOLS) {
		const stats = poolStats[poolId];
		const budget = Math.max(1, toSafeInt(weeklyBudgets[poolId], DEFAULT_WEEKLY_BUDGETS[poolId]));
		const ratio = Math.min(1, Number((stats.consumedTokens / budget).toFixed(6)));
		pools[poolId] = Object.freeze({
			poolId,
			consumedTokens: stats.consumedTokens,
			weeklyTokenBudget: budget,
			consumedRatio: ratio,
			requestCount: stats.requestCount,
			rateLimitHitsInWindow: stats.rateLimitHitsInWindow,
			lastRateLimitAt: stats.lastRateLimitAt,
		});
	}

	const metrics = Object.freeze({
		windowStart,
		windowEnd,
		pools: Object.freeze(pools),
	});

	const quotaState = transitionQuotaState(previousState, metrics, thresholds);

	return Object.freeze({
		quotaState,
		metrics,
		totalEventsInWindow,
		shardCount: shardFiles.length,
	});
}

export function compactExpiredLedgerShards(arg1, arg2 = {}) {
	const isObjectCall =
		arg1 && typeof arg1 === "object" && "pluginDataDir" in arg1;
	const pluginDataDir = isObjectCall ? arg1.pluginDataDir : arg1;
	const opts = isObjectCall ? arg1 : arg2;

	const nowMs = Number.isFinite(Number(opts.nowMs)) ? Math.floor(Number(opts.nowMs)) : Date.now();
	const maxAgeMs = Number.isFinite(Number(opts.maxAgeMs))
		? Math.max(0, Math.floor(Number(opts.maxAgeMs)))
		: FOURTEEN_DAYS_MS;
	const cutoffMs = nowMs - maxAgeMs;

	const ledgerDir = resolveLedgerDir(pluginDataDir);
	let entries = [];
	try {
		entries = fs
			.readdirSync(ledgerDir)
			.filter((name) => name.startsWith("shard-") && name.endsWith(".jsonl"))
			.sort();
	} catch {
		return Object.freeze({
			removedShards: Object.freeze([]),
			compactedShards: Object.freeze([]),
			retainedShards: Object.freeze([]),
		});
	}

	const removedShards = [];
	const compactedShards = [];
	const retainedShards = [];

	for (const name of entries) {
		const shardPath = path.join(ledgerDir, name);
		let stat;
		try {
			stat = fs.statSync(shardPath);
		} catch {
			continue;
		}

		const events = readShardEvents(shardPath);
		const freshEvents = [];
		const seenIds = new Set();

		for (const ev of events) {
			if (ev.recordedAt >= cutoffMs && !seenIds.has(ev.eventId)) {
				seenIds.add(ev.eventId);
				freshEvents.push(ev);
			}
		}

		if (freshEvents.length === 0 && (events.length > 0 || stat.mtimeMs < cutoffMs)) {
			fs.rmSync(shardPath, { force: true });
			removedShards.push(shardPath);
			continue;
		}

		if (freshEvents.length > 0 && freshEvents.length < events.length) {
			const tmpPath = `${shardPath}.tmp.${process.pid}`;
			const serialized = `${freshEvents.map((ev) => JSON.stringify(ev)).join("\n")}\n`;
			try {
				fs.writeFileSync(tmpPath, serialized, "utf8");
				fs.renameSync(tmpPath, shardPath);
				compactedShards.push(shardPath);
			} catch {
				fs.rmSync(tmpPath, { force: true });
			}
			retainedShards.push(shardPath);
			continue;
		}

		retainedShards.push(shardPath);
	}

	return Object.freeze({
		removedShards: Object.freeze(removedShards),
		compactedShards: Object.freeze(compactedShards),
		retainedShards: Object.freeze(retainedShards),
	});
}
