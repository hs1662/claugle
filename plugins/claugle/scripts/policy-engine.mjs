import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PLUGIN_ROOT = path.resolve(SCRIPT_DIR, "..");

export const ALL_QUOTA_STATES = Object.freeze([
	"NORMAL",
	"CONSERVE_CLAUDE",
	"OVERFLOW_TO_AGY",
	"FALLBACK_GEMINI_CLI",
]);

export const ALL_TASK_KINDS = Object.freeze([
	"writing",
	"docs",
	"translation",
	"research",
	"review",
	"coding-trivial",
	"coding-complex",
	"architecture",
]);

export const ALL_QUOTA_POOLS = Object.freeze([
	"claude-code-native",
	"agy-claude-pool",
	"agy-gemini-pool",
	"gemini-cli-pool",
]);

export const EFFORT_LEVELS = Object.freeze([
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

export const AGY_EXECUTION_MODES = Object.freeze([
	"plan",
	"accept-edits",
	"auto",
]);

export const MODEL_CAPABILITIES = Object.freeze({
	"gemini-4-argon-high": Object.freeze({
		slug: "gemini-4-argon-high",
		provider: "agy",
		quotaPool: "agy-gemini-pool",
		family: "gemini",
		defaultEffort: "high",
		recommendedTasks: Object.freeze(["writing", "docs", "translation", "research", "review", "architecture"]),
	}),
	"gemini-4-argon-medium": Object.freeze({
		slug: "gemini-4-argon-medium",
		provider: "agy",
		quotaPool: "agy-gemini-pool",
		family: "gemini",
		defaultEffort: "medium",
		recommendedTasks: Object.freeze(["writing", "docs", "translation", "research"]),
	}),
	"gemini-4-argon-low": Object.freeze({
		slug: "gemini-4-argon-low",
		provider: "agy",
		quotaPool: "agy-gemini-pool",
		family: "gemini",
		defaultEffort: "low",
		recommendedTasks: Object.freeze(["writing", "translation", "coding-trivial"]),
	}),
	"gemini-3.8-flash-high": Object.freeze({
		slug: "gemini-3.8-flash-high",
		provider: "agy",
		quotaPool: "agy-gemini-pool",
		family: "gemini",
		defaultEffort: "high",
		recommendedTasks: Object.freeze(["writing", "docs", "translation", "coding-trivial"]),
	}),
	"gemini-3.8-flash-medium": Object.freeze({
		slug: "gemini-3.8-flash-medium",
		provider: "agy",
		quotaPool: "agy-gemini-pool",
		family: "gemini",
		defaultEffort: "medium",
		recommendedTasks: Object.freeze(["writing", "docs", "translation", "coding-trivial"]),
	}),
	"gemini-3.8-flash-low": Object.freeze({
		slug: "gemini-3.8-flash-low",
		provider: "agy",
		quotaPool: "agy-gemini-pool",
		family: "gemini",
		defaultEffort: "low",
		recommendedTasks: Object.freeze(["translation", "coding-trivial"]),
	}),
	"claude-opus-5-5-high": Object.freeze({
		slug: "claude-opus-5-5-high",
		provider: "agy",
		quotaPool: "agy-claude-pool",
		family: "claude",
		defaultEffort: "high",
		recommendedTasks: Object.freeze(["coding-complex", "architecture", "review"]),
	}),
	"claude-opus-5-5-medium": Object.freeze({
		slug: "claude-opus-5-5-medium",
		provider: "agy",
		quotaPool: "agy-claude-pool",
		family: "claude",
		defaultEffort: "medium",
		recommendedTasks: Object.freeze(["coding-complex", "architecture", "review"]),
	}),
	"claude-opus-5-5-low": Object.freeze({
		slug: "claude-opus-5-5-low",
		provider: "agy",
		quotaPool: "agy-claude-pool",
		family: "claude",
		defaultEffort: "low",
		recommendedTasks: Object.freeze(["review", "coding-trivial"]),
	}),
	"claude-sonnet-5-5-high": Object.freeze({
		slug: "claude-sonnet-5-5-high",
		provider: "agy",
		quotaPool: "agy-claude-pool",
		family: "claude",
		defaultEffort: "high",
		recommendedTasks: Object.freeze(["review", "coding-complex", "coding-trivial", "research"]),
	}),
	"claude-sonnet-5-5-medium": Object.freeze({
		slug: "claude-sonnet-5-5-medium",
		provider: "agy",
		quotaPool: "agy-claude-pool",
		family: "claude",
		defaultEffort: "medium",
		recommendedTasks: Object.freeze(["review", "coding-trivial", "docs"]),
	}),
	"claude-sonnet-5-5-low": Object.freeze({
		slug: "claude-sonnet-5-5-low",
		provider: "agy",
		quotaPool: "agy-claude-pool",
		family: "claude",
		defaultEffort: "low",
		recommendedTasks: Object.freeze(["coding-trivial", "docs"]),
	}),
	"gpt-oss-120b-medium": Object.freeze({
		slug: "gpt-oss-120b-medium",
		provider: "agy",
		quotaPool: "agy-gemini-pool",
		family: "open-weights",
		defaultEffort: "medium",
		recommendedTasks: Object.freeze(["coding-trivial", "research", "writing"]),
	}),
	"gemini-2.5-pro": Object.freeze({
		slug: "gemini-2.5-pro",
		provider: "gemini-cli",
		quotaPool: "gemini-cli-pool",
		family: "gemini",
		defaultEffort: "high",
		recommendedTasks: Object.freeze(["writing", "docs", "translation", "research", "review"]),
	}),
	"gemini-2.5-flash": Object.freeze({
		slug: "gemini-2.5-flash",
		provider: "gemini-cli",
		quotaPool: "gemini-cli-pool",
		family: "gemini",
		defaultEffort: "medium",
		recommendedTasks: Object.freeze(["writing", "docs", "translation"]),
	}),
});

const AGY_MODEL_SET = new Set(
	Object.values(MODEL_CAPABILITIES)
		.filter((cap) => cap.provider === "agy")
		.map((cap) => cap.slug)
);

const GEMINI_CLI_MODEL_SET = new Set(
	Object.values(MODEL_CAPABILITIES)
		.filter((cap) => cap.provider === "gemini-cli")
		.map((cap) => cap.slug)
);

export const ANTHROPIC_BUILTIN_CATALOG = Object.freeze([
	Object.freeze({
		familyId: "default",
		label: "Default (Anthropic 기본 권장)",
		description: "Anthropic 기본 모델 · 계정 유형에 맞춰 자동 선택",
		behavesAs: "claude-opus-5-5",
		provider: "claude-native",
		defaultEffort: "high",
		maxEffortLevel: "high",
		supportedEfforts: Object.freeze(["low", "medium", "high"]),
		variantsByEffort: Object.freeze({}),
	}),
	Object.freeze({
		familyId: "opus",
		label: "Opus (Anthropic 내장 · Claude Opus)",
		description: "Anthropic 내장 최고 추론 모델 · 좌우 방향키로 Low/Medium/High 강도 선택",
		behavesAs: "claude-opus-5-5",
		provider: "claude-native",
		defaultEffort: "high",
		maxEffortLevel: "high",
		supportedEfforts: Object.freeze(["low", "medium", "high"]),
		variantsByEffort: Object.freeze({}),
	}),
	Object.freeze({
		familyId: "sonnet",
		label: "Sonnet (Anthropic 내장 · Claude Sonnet)",
		description: "Anthropic 내장 일상 코딩 모델 · 좌우 방향키로 Low/Medium/High 강도 선택",
		behavesAs: "claude-sonnet-5-5",
		provider: "claude-native",
		defaultEffort: "high",
		maxEffortLevel: "high",
		supportedEfforts: Object.freeze(["low", "medium", "high"]),
		variantsByEffort: Object.freeze({}),
	}),
	Object.freeze({
		familyId: "haiku",
		label: "Haiku (Anthropic 내장 · Claude Haiku)",
		description: "Anthropic 내장 초고속 경량 모델 · 좌우 방향키로 Low/Medium/High 강도 선택",
		behavesAs: "claude-haiku-5-5",
		provider: "claude-native",
		defaultEffort: "low",
		maxEffortLevel: "high",
		supportedEfforts: Object.freeze(["low", "medium", "high"]),
		variantsByEffort: Object.freeze({}),
	}),
	Object.freeze({
		familyId: "fable",
		label: "Fable (Anthropic 내장 · Claude Fable)",
		description: "Anthropic 내장 심층 판단 모델 · 좌우 방향키로 Low/Medium/High 강도 선택",
		behavesAs: "claude-fable-5-1",
		provider: "claude-native",
		defaultEffort: "high",
		maxEffortLevel: "high",
		supportedEfforts: Object.freeze(["low", "medium", "high"]),
		variantsByEffort: Object.freeze({}),
	}),
]);

export const MODEL_FAMILY_CATALOG = Object.freeze([
	Object.freeze({
		familyId: "gemini-4-argon",
		label: "Gemini 4 Argon (Google AI)",
		description: "Google AI Ultra · 심층 추론, 아키텍처, 기술 문서 집필 · 좌우 방향키로 Low/Medium/High 강도 선택",
		behavesAs: "claude-opus-5-5",
		provider: "agy",
		defaultEffort: "high",
		maxEffortLevel: "high",
		supportedEfforts: Object.freeze(["low", "medium", "high"]),
		variantsByEffort: Object.freeze({
			low: "gemini-4-argon-low",
			medium: "gemini-4-argon-medium",
			high: "gemini-4-argon-high",
		}),
	}),
	Object.freeze({
		familyId: "gemini-3.8-flash",
		label: "Gemini 3.8 Flash (Google AI)",
		description: "Google AI · 고속 탐색, 다국어 번역, 요약, 단순 수정 · 좌우 방향키로 Low/Medium/High 강도 선택",
		behavesAs: "claude-sonnet-5-5",
		provider: "agy",
		defaultEffort: "high",
		maxEffortLevel: "high",
		supportedEfforts: Object.freeze(["low", "medium", "high"]),
		variantsByEffort: Object.freeze({
			low: "gemini-3.8-flash-low",
			medium: "gemini-3.8-flash-medium",
			high: "gemini-3.8-flash-high",
		}),
	}),
	Object.freeze({
		familyId: "agy-opus-5-5",
		label: "Claude Opus 5.5 (Google AI Pool)",
		description: "Antigravity Claude 풀 · 다중 파일 구현, 심층 디버깅 · 좌우 방향키로 Low/Medium/High 강도 선택",
		behavesAs: "claude-opus-5-5",
		provider: "agy",
		defaultEffort: "high",
		maxEffortLevel: "high",
		supportedEfforts: Object.freeze(["low", "medium", "high"]),
		variantsByEffort: Object.freeze({
			low: "claude-opus-5-5-low",
			medium: "claude-opus-5-5-medium",
			high: "claude-opus-5-5-high",
		}),
	}),
	Object.freeze({
		familyId: "agy-sonnet-5-5",
		label: "Claude Sonnet 5.5 (Google AI Pool)",
		description: "Antigravity Claude 풀 · 정밀 코드 리뷰, 빠른 구현 · 좌우 방향키로 Low/Medium/High 강도 선택",
		behavesAs: "claude-sonnet-5-5",
		provider: "agy",
		defaultEffort: "high",
		maxEffortLevel: "high",
		supportedEfforts: Object.freeze(["low", "medium", "high"]),
		variantsByEffort: Object.freeze({
			low: "claude-sonnet-5-5-low",
			medium: "claude-sonnet-5-5-medium",
			high: "claude-sonnet-5-5-high",
		}),
	}),
	Object.freeze({
		familyId: "gpt-oss-120b",
		label: "GPT-OSS 120B (Google AI)",
		description: "Google AI 오픈웨이트 · 경량 코딩 및 리서치 백업 · Medium 강도",
		behavesAs: "claude-sonnet-5-5",
		provider: "agy",
		defaultEffort: "medium",
		maxEffortLevel: "medium",
		supportedEfforts: Object.freeze(["medium"]),
		variantsByEffort: Object.freeze({
			low: "gpt-oss-120b-medium",
			medium: "gpt-oss-120b-medium",
			high: "gpt-oss-120b-medium",
		}),
	}),
	Object.freeze({
		familyId: "gemini-2.5-pro",
		label: "Gemini 2.5 Pro (Gemini CLI)",
		description: "독립 Gemini CLI 풀 · 장문 독해, 리서치, 번역 폴백",
		behavesAs: "claude-opus-5-5",
		provider: "gemini-cli",
		defaultEffort: "high",
		maxEffortLevel: "high",
		supportedEfforts: Object.freeze(["low", "medium", "high"]),
		variantsByEffort: Object.freeze({
			low: "gemini-2.5-pro",
			medium: "gemini-2.5-pro",
			high: "gemini-2.5-pro",
		}),
	}),
	Object.freeze({
		familyId: "gemini-2.5-flash",
		label: "Gemini 2.5 Flash (Gemini CLI)",
		description: "독립 Gemini CLI 풀 · 초고속 요약, 번역, 문서 보조",
		behavesAs: "claude-sonnet-5-5",
		provider: "gemini-cli",
		defaultEffort: "medium",
		maxEffortLevel: "high",
		supportedEfforts: Object.freeze(["low", "medium", "high"]),
		variantsByEffort: Object.freeze({
			low: "gemini-2.5-flash",
			medium: "gemini-2.5-flash",
			high: "gemini-2.5-flash",
		}),
	}),
	Object.freeze({
		familyId: "claugle-auto",
		label: "claugle 자동 라우터 (Auto)",
		description: "작업 유형(8종)과 주간 할당량 상태(4단계)에 맞춰 최적 모델과 강도를 자동 배정",
		behavesAs: "claude-opus-5-5",
		provider: "auto",
		defaultEffort: "high",
		maxEffortLevel: "high",
		supportedEfforts: Object.freeze(["low", "medium", "high"]),
		variantsByEffort: Object.freeze({}),
	}),
]);

const FAMILY_BY_ID = new Map(
	MODEL_FAMILY_CATALOG.map((entry) => [entry.familyId, entry])
);

const BUILTIN_BY_ID = new Map(
	ANTHROPIC_BUILTIN_CATALOG.map((entry) => [entry.familyId, entry])
);

const BUILTIN_ANTHROPIC_ALIAS_MAP = Object.freeze({
	default: "default",
	"anthropic-default": "default",
	opus: "opus",
	"claude-opus-5-5": "opus",
	"claude-opus-4-6": "opus",
	sonnet: "sonnet",
	"claude-sonnet-5-5": "sonnet",
	"claude-sonnet-4-6": "sonnet",
	haiku: "haiku",
	"claude-haiku-5-5": "haiku",
	"claude-haiku-4-5-20251001": "haiku",
	fable: "fable",
	"claude-fable-5-1": "fable",
});

const FAMILY_ALIAS_MAP = Object.freeze({
	auto: "claugle-auto",
	"claugle-auto": "claugle-auto",
	argon: "gemini-4-argon",
	"gemini-4-argon": "gemini-4-argon",
	flash: "gemini-3.8-flash",
	"gemini-3.8-flash": "gemini-3.8-flash",
	"agy-opus": "agy-opus-5-5",
	"agy-opus-5-5": "agy-opus-5-5",
	"agy-sonnet": "agy-sonnet-5-5",
	"agy-sonnet-5-5": "agy-sonnet-5-5",
	"gpt-oss": "gpt-oss-120b",
	"gpt-oss-120b": "gpt-oss-120b",
	"gemini-2.5-pro": "gemini-2.5-pro",
	"gemini-pro": "gemini-2.5-pro",
	"gemini-2.5-flash": "gemini-2.5-flash",
	"gemini-flash": "gemini-2.5-flash",
});

export function resolveBuiltinAnthropicModel(rawModel, rawEffort) {
	if (typeof rawModel !== "string") return null;
	const cleaned = rawModel.trim().replace(/\[[^\]]+\]$/i, "").toLowerCase();
	if (!cleaned) return null;
	const builtinId = BUILTIN_ANTHROPIC_ALIAS_MAP[cleaned];
	if (!builtinId) return null;
	const entry = BUILTIN_BY_ID.get(builtinId);
	if (!entry) return null;
	const effort = normalizeEffortTier(rawEffort, entry.defaultEffort);
	const clampedEffort = entry.supportedEfforts.includes(effort)
		? effort
		: entry.defaultEffort;
	return {
		mode: "claude-native",
		familyId: entry.familyId,
		modelSlug: cleaned,
		effort: clampedEffort,
	};
}

export const MODEL_ALIAS_MAP = Object.freeze({
	argon: "gemini-4-argon-high",
	"argon-high": "gemini-4-argon-high",
	"argon-medium": "gemini-4-argon-medium",
	"argon-low": "gemini-4-argon-low",
	"gemini-4-argon": "gemini-4-argon-high",
	flash: "gemini-3.8-flash-high",
	"flash-high": "gemini-3.8-flash-high",
	"flash-medium": "gemini-3.8-flash-medium",
	"flash-low": "gemini-3.8-flash-low",
	"gemini-3.8-flash": "gemini-3.8-flash-high",
	"agy-opus": "claude-opus-5-5-high",
	"agy-opus-5-5": "claude-opus-5-5-high",
	"agy-opus-high": "claude-opus-5-5-high",
	"agy-opus-medium": "claude-opus-5-5-medium",
	"agy-opus-low": "claude-opus-5-5-low",
	"agy-sonnet": "claude-sonnet-5-5-high",
	"agy-sonnet-5-5": "claude-sonnet-5-5-high",
	"agy-sonnet-high": "claude-sonnet-5-5-high",
	"agy-sonnet-medium": "claude-sonnet-5-5-medium",
	"agy-sonnet-low": "claude-sonnet-5-5-low",
	"gpt-oss": "gpt-oss-120b-medium",
	"gpt-oss-120b": "gpt-oss-120b-medium",
	"gemini-pro": "gemini-2.5-pro",
	"gemini-flash": "gemini-2.5-flash",
});

function normalizeEffortTier(rawEffort, fallback = "high") {
	if (typeof rawEffort !== "string") return fallback;
	const cleaned = rawEffort.trim().toLowerCase();
	if (cleaned === "low") return "low";
	if (cleaned === "medium" || cleaned === "med") return "medium";
	if (cleaned === "high" || cleaned === "xhigh" || cleaned === "max") return "high";
	return fallback;
}

export function resolveModelAlias(rawModel) {
	if (typeof rawModel !== "string") return null;
	const cleaned = rawModel.trim().replace(/\[[^\]]+\]$/i, "").toLowerCase();
	if (!cleaned) return null;
	const mapped = MODEL_ALIAS_MAP[cleaned] ?? cleaned;
	if (AGY_MODEL_SET.has(mapped) || GEMINI_CLI_MODEL_SET.has(mapped)) {
		return mapped;
	}
	return null;
}

export function resolveModelAndEffort(rawModel, rawEffort, options = {}) {
	if (typeof rawModel !== "string") return null;
	const cleaned = rawModel.trim().replace(/\[[^\]]+\]$/i, "").toLowerCase();
	if (!cleaned) return null;

	const preferExplicitEffort = Boolean(options?.preferExplicitEffort);
	const hasExplicitEffort =
		typeof rawEffort === "string" && rawEffort.trim().length > 0;

	const directFamilyId = FAMILY_ALIAS_MAP[cleaned];
	if (directFamilyId) {
		const family = FAMILY_BY_ID.get(directFamilyId);
		const effort = normalizeEffortTier(rawEffort, family.defaultEffort);
		if (family.provider === "auto") {
			return {
				mode: "auto",
				familyId: family.familyId,
				modelSlug: null,
				effort,
			};
		}
		const clampedEffort = family.supportedEfforts.includes(effort)
			? effort
			: family.defaultEffort;
		const modelSlug =
			family.variantsByEffort[clampedEffort] ??
			family.variantsByEffort[family.defaultEffort];
		return {
			mode: "pinned",
			familyId: family.familyId,
			modelSlug,
			effort: clampedEffort,
		};
	}

	const mappedSlug = MODEL_ALIAS_MAP[cleaned] ?? cleaned;
	if (!AGY_MODEL_SET.has(mappedSlug) && !GEMINI_CLI_MODEL_SET.has(mappedSlug)) {
		return null;
	}

	const matchingFamily = MODEL_FAMILY_CATALOG.find((entry) =>
		Object.values(entry.variantsByEffort).includes(mappedSlug)
	);
	const cap = MODEL_CAPABILITIES[mappedSlug];
	const slugEffort = cap?.defaultEffort ?? "high";

	if (matchingFamily && preferExplicitEffort && hasExplicitEffort) {
		const requestedTier = normalizeEffortTier(rawEffort, slugEffort);
		const clampedEffort = matchingFamily.supportedEfforts.includes(requestedTier)
			? requestedTier
			: matchingFamily.defaultEffort;
		const variantSlug =
			matchingFamily.variantsByEffort[clampedEffort] ?? mappedSlug;
		return {
			mode: "pinned",
			familyId: matchingFamily.familyId,
			modelSlug: variantSlug,
			effort: clampedEffort,
		};
	}

	return {
		mode: "pinned",
		familyId: matchingFamily?.familyId ?? "gemini-4-argon",
		modelSlug: mappedSlug,
		effort: slugEffort,
	};
}

export function buildClaudeModelPickerConfig() {
	const options = [];
	const modelSettings = {};

	for (const builtin of ANTHROPIC_BUILTIN_CATALOG) {
		modelSettings[builtin.familyId] = {
			effortLevel: builtin.defaultEffort,
			maxEffortLevel: builtin.maxEffortLevel,
		};
		modelSettings[builtin.behavesAs] = {
			effortLevel: builtin.defaultEffort,
			maxEffortLevel: builtin.maxEffortLevel,
		};
	}

	for (const family of MODEL_FAMILY_CATALOG) {
		options.push({
			model: family.familyId,
			label: family.label,
			description: family.description,
			behavesAs: family.behavesAs,
		});
		modelSettings[family.familyId] = {
			effortLevel: family.defaultEffort,
			maxEffortLevel: family.maxEffortLevel,
		};
	}

	const explicitVariants = [
		{
			model: "gemini-4-argon-high",
			label: "Gemini 4 Argon · High",
			description: "Google AI Ultra · 최고 추론 강도 고정",
			behavesAs: "claude-opus-5-5",
			effortLevel: "high",
		},
		{
			model: "gemini-4-argon-medium",
			label: "Gemini 4 Argon · Medium",
			description: "Google AI Ultra · 균형 추론 강도 고정",
			behavesAs: "claude-opus-5-5",
			effortLevel: "medium",
		},
		{
			model: "gemini-4-argon-low",
			label: "Gemini 4 Argon · Low",
			description: "Google AI Ultra · 고속 추론 강도 고정",
			behavesAs: "claude-opus-5-5",
			effortLevel: "low",
		},
		{
			model: "gemini-3.8-flash-high",
			label: "Gemini 3.8 Flash · High",
			description: "Google AI · Flash 심층 추론 강도 고정",
			behavesAs: "claude-sonnet-5-5",
			effortLevel: "high",
		},
		{
			model: "gemini-3.8-flash-medium",
			label: "Gemini 3.8 Flash · Medium",
			description: "Google AI · Flash 균형 추론 강도 고정",
			behavesAs: "claude-sonnet-5-5",
			effortLevel: "medium",
		},
		{
			model: "gemini-3.8-flash-low",
			label: "Gemini 3.8 Flash · Low",
			description: "Google AI · Flash 초고속 추론 강도 고정",
			behavesAs: "claude-sonnet-5-5",
			effortLevel: "low",
		},
		{
			model: "claude-opus-5-5-high",
			label: "Claude Opus 5.5 (Google AI) · High",
			description: "Antigravity Claude 풀 · Opus 최고 추론 강도 고정",
			behavesAs: "claude-opus-5-5",
			effortLevel: "high",
		},
		{
			model: "claude-opus-5-5-medium",
			label: "Claude Opus 5.5 (Google AI) · Medium",
			description: "Antigravity Claude 풀 · Opus 균형 추론 강도 고정",
			behavesAs: "claude-opus-5-5",
			effortLevel: "medium",
		},
		{
			model: "claude-opus-5-5-low",
			label: "Claude Opus 5.5 (Google AI) · Low",
			description: "Antigravity Claude 풀 · Opus 고속 추론 강도 고정",
			behavesAs: "claude-opus-5-5",
			effortLevel: "low",
		},
		{
			model: "claude-sonnet-5-5-high",
			label: "Claude Sonnet 5.5 (Google AI) · High",
			description: "Antigravity Claude 풀 · Sonnet 최고 추론 강도 고정",
			behavesAs: "claude-sonnet-5-5",
			effortLevel: "high",
		},
		{
			model: "claude-sonnet-5-5-medium",
			label: "Claude Sonnet 5.5 (Google AI) · Medium",
			description: "Antigravity Claude 풀 · Sonnet 균형 추론 강도 고정",
			behavesAs: "claude-sonnet-5-5",
			effortLevel: "medium",
		},
		{
			model: "claude-sonnet-5-5-low",
			label: "Claude Sonnet 5.5 (Google AI) · Low",
			description: "Antigravity Claude 풀 · Sonnet 고속 추론 강도 고정",
			behavesAs: "claude-sonnet-5-5",
			effortLevel: "low",
		},
	];

	for (const item of explicitVariants) {
		options.push({
			model: item.model,
			label: item.label,
			description: item.description,
			behavesAs: item.behavesAs,
		});
		modelSettings[item.model] = {
			effortLevel: item.effortLevel,
			maxEffortLevel: "high",
		};
	}

	return {
		modelPicker: {
			replaceBuiltInOptions: false,
			options,
		},
		modelSettings,
	};
}

export const DEFAULT_GOVERNOR_THRESHOLDS = Object.freeze({
	windowDurationMs: 7 * 24 * 60 * 60 * 1000,
	conserveClaudeBand: Object.freeze({ enterAt: 0.70, exitBelow: 0.65 }),
	overflowToAgyBand: Object.freeze({ enterAt: 0.90, exitBelow: 0.82 }),
	agyExhaustedBand: Object.freeze({ enterAt: 0.95, exitBelow: 0.88 }),
	exhaustionSignalWindowMs: 5 * 60 * 60 * 1000,
	circuitBreakerCooldownMs: 5 * 60 * 1000,
});

const READ_ONLY_ISOLATION = Object.freeze({ kind: "read-only" });
const WORKTREE_ISOLATION = Object.freeze({
	kind: "git-worktree",
	applyStrategy: "patch-if-clean",
	defaultAllowedGlobs: Object.freeze(["**/*"]),
});

function makeClaudeNativeTarget(effort = "high") {
	return Object.freeze({
		provider: "claude-native",
		quotaPool: "claude-code-native",
		effort,
		executionMode: "host-inline",
	});
}

function makeAgyTarget(modelSlug, effort, agyMode = "plan", isolation = READ_ONLY_ISOLATION, timeoutMs = 180_000) {
	const cap = MODEL_CAPABILITIES[modelSlug];
	return Object.freeze({
		provider: "agy",
		quotaPool: cap.quotaPool,
		modelSlug,
		family: cap.family,
		effort: effort ?? cap.defaultEffort,
		agyMode,
		isolation,
		timeoutMs,
	});
}

function makeGeminiCliTarget(modelSlug = "gemini-2.5-pro", effort = "high", timeoutMs = 120_000) {
	return Object.freeze({
		provider: "gemini-cli",
		quotaPool: "gemini-cli-pool",
		modelSlug,
		effort,
		agyMode: "plan",
		isolation: READ_ONLY_ISOLATION,
		timeoutMs,
	});
}

export const DEFAULT_POLICY_MATRIX = Object.freeze({
	NORMAL: Object.freeze({
		writing: Object.freeze([
			makeAgyTarget("gemini-4-argon-high", "high", "plan", READ_ONLY_ISOLATION),
			makeGeminiCliTarget("gemini-2.5-pro", "high"),
			makeClaudeNativeTarget("medium"),
		]),
		docs: Object.freeze([
			makeAgyTarget("gemini-4-argon-high", "high", "accept-edits", WORKTREE_ISOLATION),
			makeGeminiCliTarget("gemini-2.5-pro", "high"),
			makeClaudeNativeTarget("medium"),
		]),
		translation: Object.freeze([
			makeAgyTarget("gemini-3.8-flash-high", "high", "plan", READ_ONLY_ISOLATION),
			makeGeminiCliTarget("gemini-2.5-flash", "medium"),
			makeClaudeNativeTarget("low"),
		]),
		research: Object.freeze([
			makeAgyTarget("gemini-4-argon-high", "high", "plan", READ_ONLY_ISOLATION),
			makeGeminiCliTarget("gemini-2.5-pro", "high"),
			makeClaudeNativeTarget("medium"),
		]),
		review: Object.freeze([
			makeAgyTarget("claude-sonnet-5-5-high", "high", "plan", READ_ONLY_ISOLATION),
			makeAgyTarget("gemini-4-argon-high", "high", "plan", READ_ONLY_ISOLATION),
			makeClaudeNativeTarget("high"),
		]),
		"coding-trivial": Object.freeze([
			makeAgyTarget("gemini-3.8-flash-high", "high", "accept-edits", WORKTREE_ISOLATION),
			makeAgyTarget("claude-sonnet-5-5-medium", "medium", "accept-edits", WORKTREE_ISOLATION),
			makeClaudeNativeTarget("medium"),
		]),
		"coding-complex": Object.freeze([
			makeClaudeNativeTarget("high"),
			makeAgyTarget("claude-opus-5-5-high", "high", "accept-edits", WORKTREE_ISOLATION),
			makeAgyTarget("gemini-4-argon-high", "high", "accept-edits", WORKTREE_ISOLATION),
		]),
		architecture: Object.freeze([
			makeClaudeNativeTarget("high"),
			makeAgyTarget("claude-opus-5-5-high", "high", "plan", READ_ONLY_ISOLATION),
			makeAgyTarget("gemini-4-argon-high", "high", "plan", READ_ONLY_ISOLATION),
		]),
	}),
	CONSERVE_CLAUDE: Object.freeze({
		writing: Object.freeze([
			makeAgyTarget("gemini-4-argon-high", "high", "plan", READ_ONLY_ISOLATION),
			makeGeminiCliTarget("gemini-2.5-pro", "high"),
			makeClaudeNativeTarget("low"),
		]),
		docs: Object.freeze([
			makeAgyTarget("gemini-4-argon-high", "high", "accept-edits", WORKTREE_ISOLATION),
			makeGeminiCliTarget("gemini-2.5-pro", "high"),
			makeClaudeNativeTarget("low"),
		]),
		translation: Object.freeze([
			makeAgyTarget("gemini-3.8-flash-high", "high", "plan", READ_ONLY_ISOLATION),
			makeGeminiCliTarget("gemini-2.5-flash", "medium"),
			makeClaudeNativeTarget("low"),
		]),
		research: Object.freeze([
			makeAgyTarget("gemini-4-argon-high", "high", "plan", READ_ONLY_ISOLATION),
			makeGeminiCliTarget("gemini-2.5-pro", "high"),
			makeClaudeNativeTarget("low"),
		]),
		review: Object.freeze([
			makeAgyTarget("claude-sonnet-5-5-high", "high", "plan", READ_ONLY_ISOLATION),
			makeAgyTarget("gemini-4-argon-high", "high", "plan", READ_ONLY_ISOLATION),
			makeGeminiCliTarget("gemini-2.5-pro", "high"),
		]),
		"coding-trivial": Object.freeze([
			makeAgyTarget("gemini-3.8-flash-high", "high", "accept-edits", WORKTREE_ISOLATION),
			makeAgyTarget("claude-sonnet-5-5-medium", "medium", "accept-edits", WORKTREE_ISOLATION),
			makeClaudeNativeTarget("low"),
		]),
		"coding-complex": Object.freeze([
			makeAgyTarget("claude-sonnet-5-5-high", "high", "accept-edits", WORKTREE_ISOLATION),
			makeAgyTarget("claude-opus-5-5-high", "high", "accept-edits", WORKTREE_ISOLATION),
			makeClaudeNativeTarget("medium"),
		]),
		architecture: Object.freeze([
			makeAgyTarget("claude-opus-5-5-high", "high", "plan", READ_ONLY_ISOLATION),
			makeAgyTarget("gemini-4-argon-high", "high", "plan", READ_ONLY_ISOLATION),
			makeClaudeNativeTarget("medium"),
		]),
	}),
	OVERFLOW_TO_AGY: Object.freeze({
		writing: Object.freeze([
			makeAgyTarget("gemini-4-argon-high", "high", "plan", READ_ONLY_ISOLATION),
			makeAgyTarget("gemini-3.8-flash-high", "high", "plan", READ_ONLY_ISOLATION),
			makeGeminiCliTarget("gemini-2.5-pro", "high"),
		]),
		docs: Object.freeze([
			makeAgyTarget("gemini-4-argon-high", "high", "accept-edits", WORKTREE_ISOLATION),
			makeAgyTarget("gemini-3.8-flash-high", "high", "accept-edits", WORKTREE_ISOLATION),
			makeGeminiCliTarget("gemini-2.5-pro", "high"),
		]),
		translation: Object.freeze([
			makeAgyTarget("gemini-3.8-flash-high", "high", "plan", READ_ONLY_ISOLATION),
			makeAgyTarget("gemini-4-argon-medium", "medium", "plan", READ_ONLY_ISOLATION),
			makeGeminiCliTarget("gemini-2.5-flash", "medium"),
		]),
		research: Object.freeze([
			makeAgyTarget("gemini-4-argon-high", "high", "plan", READ_ONLY_ISOLATION),
			makeAgyTarget("claude-sonnet-5-5-high", "high", "plan", READ_ONLY_ISOLATION),
			makeGeminiCliTarget("gemini-2.5-pro", "high"),
		]),
		review: Object.freeze([
			makeAgyTarget("claude-opus-5-5-high", "high", "plan", READ_ONLY_ISOLATION),
			makeAgyTarget("claude-sonnet-5-5-high", "high", "plan", READ_ONLY_ISOLATION),
			makeAgyTarget("gemini-4-argon-high", "high", "plan", READ_ONLY_ISOLATION),
		]),
		"coding-trivial": Object.freeze([
			makeAgyTarget("gemini-3.8-flash-high", "high", "accept-edits", WORKTREE_ISOLATION),
			makeAgyTarget("claude-sonnet-5-5-medium", "medium", "accept-edits", WORKTREE_ISOLATION),
			makeAgyTarget("gpt-oss-120b-medium", "medium", "accept-edits", WORKTREE_ISOLATION),
		]),
		"coding-complex": Object.freeze([
			makeAgyTarget("claude-opus-5-5-high", "high", "accept-edits", WORKTREE_ISOLATION),
			makeAgyTarget("claude-sonnet-5-5-high", "high", "accept-edits", WORKTREE_ISOLATION),
			makeAgyTarget("gemini-4-argon-high", "high", "accept-edits", WORKTREE_ISOLATION),
		]),
		architecture: Object.freeze([
			makeAgyTarget("claude-opus-5-5-high", "high", "plan", READ_ONLY_ISOLATION),
			makeAgyTarget("gemini-4-argon-high", "high", "plan", READ_ONLY_ISOLATION),
			makeGeminiCliTarget("gemini-2.5-pro", "high"),
		]),
	}),
	FALLBACK_GEMINI_CLI: Object.freeze({
		writing: Object.freeze([
			makeGeminiCliTarget("gemini-2.5-pro", "high"),
			makeGeminiCliTarget("gemini-2.5-flash", "medium"),
			makeAgyTarget("gemini-3.8-flash-low", "low", "plan", READ_ONLY_ISOLATION),
		]),
		docs: Object.freeze([
			makeGeminiCliTarget("gemini-2.5-pro", "high"),
			makeAgyTarget("gemini-3.8-flash-medium", "medium", "accept-edits", WORKTREE_ISOLATION),
			makeClaudeNativeTarget("low"),
		]),
		translation: Object.freeze([
			makeGeminiCliTarget("gemini-2.5-flash", "medium"),
			makeGeminiCliTarget("gemini-2.5-pro", "high"),
			makeAgyTarget("gemini-3.8-flash-low", "low", "plan", READ_ONLY_ISOLATION),
		]),
		research: Object.freeze([
			makeGeminiCliTarget("gemini-2.5-pro", "high"),
			makeGeminiCliTarget("gemini-2.5-flash", "medium"),
			makeAgyTarget("gpt-oss-120b-medium", "medium", "plan", READ_ONLY_ISOLATION),
		]),
		review: Object.freeze([
			makeGeminiCliTarget("gemini-2.5-pro", "high"),
			makeAgyTarget("gemini-3.8-flash-high", "high", "plan", READ_ONLY_ISOLATION),
			makeClaudeNativeTarget("low"),
		]),
		"coding-trivial": Object.freeze([
			makeAgyTarget("gemini-3.8-flash-low", "low", "accept-edits", WORKTREE_ISOLATION),
			makeAgyTarget("gpt-oss-120b-medium", "medium", "accept-edits", WORKTREE_ISOLATION),
			makeClaudeNativeTarget("low"),
		]),
		"coding-complex": Object.freeze([
			makeAgyTarget("gpt-oss-120b-medium", "medium", "accept-edits", WORKTREE_ISOLATION),
			makeAgyTarget("gemini-3.8-flash-high", "high", "accept-edits", WORKTREE_ISOLATION),
			makeClaudeNativeTarget("low"),
		]),
		architecture: Object.freeze([
			makeGeminiCliTarget("gemini-2.5-pro", "high"),
			makeAgyTarget("gpt-oss-120b-medium", "medium", "plan", READ_ONLY_ISOLATION),
			makeClaudeNativeTarget("low"),
		]),
	}),
});

export function isAgyModelSlug(value) {
	return typeof value === "string" && AGY_MODEL_SET.has(value);
}

export function isGeminiCliModelSlug(value) {
	return typeof value === "string" && GEMINI_CLI_MODEL_SET.has(value);
}

export function isUnitIntervalRatio(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function createTaskExecutionId(nowMs = Date.now(), randomHex) {
	const ts = Number.isFinite(nowMs) && nowMs >= 0 ? Math.floor(nowMs) : Date.now();
	const suffix =
		typeof randomHex === "string" && /^[0-9a-f]{6,32}$/i.test(randomHex)
			? randomHex.toLowerCase()
			: crypto.randomBytes(4).toString("hex");
	return `task-${ts}-${suffix}`;
}

export function parseAbsolutePath(raw) {
	if (typeof raw !== "string" || raw.trim().length === 0) {
		return { kind: "error", code: "INVALID_PATH", message: "Path must be a non-empty string." };
	}
	if (raw.includes("\0")) {
		return { kind: "error", code: "INVALID_PATH", message: "Path must not contain null bytes." };
	}
	if (!path.isAbsolute(raw)) {
		return { kind: "error", code: "INVALID_PATH", message: `Expected absolute path, got "${raw}".` };
	}
	return { kind: "ok", value: path.resolve(raw) };
}

export function parseRelativeGlob(raw) {
	if (typeof raw !== "string" || raw.trim().length === 0) {
		return { kind: "error", code: "INVALID_PATH", message: "Glob must be a non-empty string." };
	}
	if (raw.includes("\0")) {
		return { kind: "error", code: "INVALID_PATH", message: "Glob must not contain null bytes." };
	}
	const normalized = raw.replace(/\\/g, "/").trim();
	if (normalized.startsWith("/")) {
		return { kind: "error", code: "INVALID_PATH", message: `Expected relative glob, got "${raw}".` };
	}
	const segments = normalized.split("/");
	if (segments.includes("..")) {
		return {
			kind: "error",
			code: "INVALID_PATH",
			message: `Relative glob "${raw}" must not contain parent traversal segments ("..").`,
		};
	}
	return { kind: "ok", value: normalized };
}

function parsePositiveBudget(rawVal, fallback) {
	if (rawVal === undefined || rawVal === null || rawVal === "" || /^\$\{[^}]*\}$/.test(String(rawVal).trim())) {
		return { kind: "ok", value: fallback };
	}
	const parsed = Number(rawVal);
	if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
		return {
			kind: "error",
			code: "INVALID_ENV",
			message: `Expected positive integer weekly token budget, got "${rawVal}".`,
		};
	}
	return { kind: "ok", value: parsed };
}

export function parsePluginEnv(rawEnv = process.env) {
	if (!rawEnv || typeof rawEnv !== "object") {
		return { kind: "error", code: "INVALID_ENV", message: "Environment must be an object." };
	}

	const rawPluginRoot = rawEnv.CLAUDE_PLUGIN_ROOT || DEFAULT_PLUGIN_ROOT;
	const pluginRootRes = parseAbsolutePath(rawPluginRoot);
	if (pluginRootRes.kind === "error") {
		return { kind: "error", code: "INVALID_ENV", message: `CLAUDE_PLUGIN_ROOT: ${pluginRootRes.message}` };
	}

	const rawPluginData =
		rawEnv.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), ".claude", "plugins", "data", "claugle-claugle");
	const pluginDataRes = parseAbsolutePath(rawPluginData);
	if (pluginDataRes.kind === "error") {
		return { kind: "error", code: "INVALID_ENV", message: `CLAUDE_PLUGIN_DATA: ${pluginDataRes.message}` };
	}

	const rawProjectDir = rawEnv.CLAUDE_PROJECT_DIR || process.cwd();
	const projectDirRes = parseAbsolutePath(rawProjectDir);
	if (projectDirRes.kind === "error") {
		return { kind: "error", code: "INVALID_ENV", message: `CLAUDE_PROJECT_DIR: ${projectDirRes.message}` };
	}

	let envFile;
	if (rawEnv.CLAUDE_ENV_FILE) {
		const envFileRes = parseAbsolutePath(rawEnv.CLAUDE_ENV_FILE);
		if (envFileRes.kind === "error") {
			return { kind: "error", code: "INVALID_ENV", message: `CLAUDE_ENV_FILE: ${envFileRes.message}` };
		}
		envFile = envFileRes.value;
	}

	const claudeBudget = parsePositiveBudget(
		rawEnv.CLAUDE_PLUGIN_OPTION_CLAUDE_WEEKLY_TOKEN_BUDGET ?? rawEnv.CLAUGLE_CLAUDE_WEEKLY_TOKEN_BUDGET,
		5_000_000
	);
	if (claudeBudget.kind === "error") return claudeBudget;

	const agyClaudeBudget = parsePositiveBudget(
		rawEnv.CLAUDE_PLUGIN_OPTION_AGY_CLAUDE_WEEKLY_TOKEN_BUDGET ?? rawEnv.CLAUGLE_AGY_CLAUDE_WEEKLY_TOKEN_BUDGET,
		8_000_000
	);
	if (agyClaudeBudget.kind === "error") return agyClaudeBudget;

	const agyGeminiBudget = parsePositiveBudget(
		rawEnv.CLAUDE_PLUGIN_OPTION_AGY_GEMINI_WEEKLY_TOKEN_BUDGET ?? rawEnv.CLAUGLE_AGY_GEMINI_WEEKLY_TOKEN_BUDGET,
		15_000_000
	);
	if (agyGeminiBudget.kind === "error") return agyGeminiBudget;

	const geminiCliBudget = parsePositiveBudget(
		rawEnv.CLAUDE_PLUGIN_OPTION_GEMINI_CLI_WEEKLY_TOKEN_BUDGET ?? rawEnv.CLAUGLE_GEMINI_CLI_WEEKLY_TOKEN_BUDGET,
		10_000_000
	);
	if (geminiCliBudget.kind === "error") return geminiCliBudget;

	const rawSessionId = String(rawEnv.CLAUDE_SESSION_ID || "default-session").trim();
	const sanitizedSessionId = rawSessionId.replace(/[^a-zA-Z0-9._-]/g, "_") || "default-session";

	return {
		kind: "ok",
		value: Object.freeze({
			pluginRoot: pluginRootRes.value,
			pluginDataDir: pluginDataRes.value,
			projectDir: projectDirRes.value,
			sessionId: sanitizedSessionId,
			...(envFile ? { envFile } : {}),
			weeklyBudgets: Object.freeze({
				"claude-code-native": claudeBudget.value,
				"agy-claude-pool": agyClaudeBudget.value,
				"agy-gemini-pool": agyGeminiBudget.value,
				"gemini-cli-pool": geminiCliBudget.value,
			}),
			...(rawEnv.CLAUGLE_AGY_BIN ? { agyBinOverride: String(rawEnv.CLAUGLE_AGY_BIN) } : {}),
			...(rawEnv.CLAUGLE_GEMINI_BIN ? { geminiBinOverride: String(rawEnv.CLAUGLE_GEMINI_BIN) } : {}),
		}),
	};
}

// agy's docs: workspace customizations live in `.agents/` (or `.agent/`, `_agents/`, `_agent/`).
export const AGY_WORKSPACE_DIRS = Object.freeze([".agents", ".agent", "_agents", "_agent"]);
// Files that instruct Claude Code or agy at any depth. An edit run must not rewrite the rules that bind
// the next run.
export const HARNESS_INSTRUCTION_FILES = Object.freeze(["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "GEMINI.md"]);
export const HARNESS_CONFIG_NAMES = Object.freeze([".git", ...AGY_WORKSPACE_DIRS, ".claude", ".gemini", ".mcp.json", ...HARNESS_INSTRUCTION_FILES]);

// `git rev-parse --local-env-vars`. Inherited from a git hook or a shell inside another repo, these aim
// every git call claugle makes, and agy's own walk up to the repo top, at that other repo.
const REPO_LOCAL_GIT_ENV = Object.freeze([
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_CONFIG",
	"GIT_CONFIG_PARAMETERS",
	"GIT_CONFIG_COUNT",
	"GIT_OBJECT_DIRECTORY",
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_IMPLICIT_WORK_TREE",
	"GIT_GRAFT_FILE",
	"GIT_INDEX_FILE",
	"GIT_NO_REPLACE_OBJECTS",
	"GIT_REPLACE_REF_BASE",
	"GIT_PREFIX",
	"GIT_SHALLOW_FILE",
	"GIT_COMMON_DIR",
]);

export function dropRepoLocalGitEnv(env) {
	for (const name of REPO_LOCAL_GIT_ENV) delete env[name];
	return env;
}

const MAX_REQUEST_TASK_ID_LENGTH = 100;
export function isSafeTaskId(taskId) {
	return typeof taskId === "string" && /^task-[A-Za-z0-9_-]{1,120}$/.test(taskId);
}

export function parseTaskRequest(rawInput) {
	if (!rawInput || typeof rawInput !== "object") {
		return { kind: "error", code: "INVALID_REQUEST", message: "Task request must be an object." };
	}

	const prompt = typeof rawInput.prompt === "string" ? rawInput.prompt.trim() : "";
	if (prompt.length === 0) {
		return { kind: "error", code: "INVALID_REQUEST", message: "Task request prompt must be a non-empty string." };
	}

	let explicitTaskKind;
	if (rawInput.explicitTaskKind !== undefined && rawInput.explicitTaskKind !== null && rawInput.explicitTaskKind !== "") {
		if (!ALL_TASK_KINDS.includes(rawInput.explicitTaskKind)) {
			return {
				kind: "error",
				code: "INVALID_REQUEST",
				message: `Unknown task kind "${rawInput.explicitTaskKind}".`,
			};
		}
		explicitTaskKind = rawInput.explicitTaskKind;
	}

	let preferredEffort;
	if (rawInput.preferredEffort !== undefined && rawInput.preferredEffort !== null && rawInput.preferredEffort !== "") {
		if (!EFFORT_LEVELS.includes(rawInput.preferredEffort)) {
			return {
				kind: "error",
				code: "INVALID_REQUEST",
				message: `Unsupported effort level "${rawInput.preferredEffort}".`,
			};
		}
		preferredEffort = rawInput.preferredEffort;
	}

	let preferredModel;
	if (rawInput.preferredModel !== undefined && rawInput.preferredModel !== null && rawInput.preferredModel !== "") {
		const resolved = resolveModelAndEffort(
			String(rawInput.preferredModel),
			preferredEffort,
			{ preferExplicitEffort: Boolean(preferredEffort) }
		);
		if (!resolved || !resolved.modelSlug) {
			return {
				kind: "error",
				code: "INVALID_REQUEST",
				message: `Unsupported preferred model "${rawInput.preferredModel}".`,
			};
		}
		preferredModel = resolved.modelSlug;
		if (preferredEffort) {
			preferredEffort = resolved.effort;
		}
	}

	const cwdRes = parseAbsolutePath(rawInput.cwd ?? process.cwd());
	if (cwdRes.kind === "error") {
		return { kind: "error", code: "INVALID_REQUEST", message: `Invalid cwd: ${cwdRes.message}` };
	}
	// Every check below and agy itself must see the folder a symlinked cwd points to, or a walk up
	// from the link's parents misses the real repo's agy customizations.
	let cwd = null;
	try {
		if (fs.statSync(cwdRes.value, { throwIfNoEntry: false })?.isDirectory()) cwd = fs.realpathSync(cwdRes.value);
	} catch {}
	if (!cwd) {
		return { kind: "error", code: "INVALID_REQUEST", message: `Invalid cwd: ${cwdRes.value} is not an existing folder.` };
	}

	const contextFiles = [];
	if (rawInput.contextFiles !== undefined) {
		if (!Array.isArray(rawInput.contextFiles)) {
			return { kind: "error", code: "INVALID_REQUEST", message: "contextFiles must be an array of strings." };
		}
		for (const item of rawInput.contextFiles) {
			if (typeof item !== "string" || item.trim().length === 0 || item.includes("\0")) {
				return { kind: "error", code: "INVALID_REQUEST", message: "Each contextFile must be a valid path string." };
			}
			const contextFile = item.trim();
			const fromCwd = path.relative(cwd, path.resolve(cwd, contextFile));
			if (path.isAbsolute(contextFile) || fromCwd === ".." || fromCwd.startsWith(`..${path.sep}`)) {
				return {
					kind: "error",
					code: "INVALID_REQUEST",
					message: `contextFile "${contextFile}" must be a path inside cwd, relative to it.`,
				};
			}
			contextFiles.push(contextFile);
		}
	}

	if (rawInput.allowFileEdits != null && typeof rawInput.allowFileEdits !== "boolean") {
		return { kind: "error", code: "INVALID_REQUEST", message: "allowFileEdits must be true or false." };
	}
	const allowFileEdits = rawInput.allowFileEdits === true;
	if (rawInput.allowedEditGlobs != null && !Array.isArray(rawInput.allowedEditGlobs)) {
		return { kind: "error", code: "INVALID_REQUEST", message: "allowedEditGlobs must be an array of relative globs." };
	}
	const rawGlobs = rawInput.allowedEditGlobs?.length > 0 ? rawInput.allowedEditGlobs : ["**/*"];

	const parsedGlobs = [];
	for (const g of rawGlobs) {
		const globRes = parseRelativeGlob(g);
		if (globRes.kind === "error") {
			return { kind: "error", code: "INVALID_REQUEST", message: globRes.message };
		}
		parsedGlobs.push(globRes.value);
	}

	const applyStrategy = rawInput.applyStrategy ?? "patch-if-clean";
	if (applyStrategy !== "patch-if-clean" && applyStrategy !== "branch-only") {
		return {
			kind: "error",
			code: "INVALID_REQUEST",
			message: `Invalid applyStrategy "${applyStrategy}".`,
		};
	}

	if (rawInput.taskId !== undefined && (!isSafeTaskId(rawInput.taskId) || rawInput.taskId.length > MAX_REQUEST_TASK_ID_LENGTH)) {
		return {
			kind: "error",
			code: "INVALID_REQUEST",
			message: "taskId must look like task-<letters, digits, '_' or '-'>.",
		};
	}
	const taskId = rawInput.taskId ?? createTaskExecutionId();

	return {
		kind: "ok",
		value: Object.freeze({
			taskId,
			prompt,
			...(explicitTaskKind ? { explicitTaskKind } : {}),
			...(preferredModel ? { preferredModel } : {}),
			...(preferredEffort ? { preferredEffort } : {}),
			cwd,
			contextFiles: Object.freeze(contextFiles),
			allowFileEdits,
			allowedEditGlobs: Object.freeze(parsedGlobs),
			applyStrategy,
		}),
	};
}

function toNonNegativeInt(val, fallback = 0) {
	const num = Number(val);
	return Number.isFinite(num) && num >= 0 ? Math.floor(num) : fallback;
}

export function parseAgyOutputJson(rawStdout) {
	if (typeof rawStdout !== "string" || rawStdout.trim().length === 0) {
		return { kind: "error", code: "INVALID_PROVIDER_JSON", message: "Empty stdout from agy CLI." };
	}

	const streamResult = rawStdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("{") && line.includes('"event"'))
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		})
		.filter((event) => event && event.event === "result" && event.result && typeof event.result === "object")
		.pop();

	let candidateJson = streamResult ? JSON.stringify(streamResult.result) : rawStdout.trim();
	if (!candidateJson.startsWith("{")) {
		const braceIdx = candidateJson.indexOf("\n{");
		if (braceIdx >= 0) {
			candidateJson = candidateJson.slice(braceIdx + 1).trim();
		} else {
			const firstBrace = candidateJson.indexOf("{");
			if (firstBrace >= 0) {
				candidateJson = candidateJson.slice(firstBrace).trim();
			}
		}
	}

	let parsed;
	try {
		parsed = JSON.parse(candidateJson);
	} catch (err) {
		return {
			kind: "error",
			code: "INVALID_PROVIDER_JSON",
			message: `Failed to parse agy JSON output: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	if (!parsed || typeof parsed !== "object") {
		return { kind: "error", code: "INVALID_PROVIDER_JSON", message: "agy JSON output is not an object." };
	}

	const finishedReason = parsed.finished_reason ?? parsed.finishedReason;
	if (typeof finishedReason === "string" && finishedReason.length > 0) {
		return {
			kind: "error",
			code: "INCOMPLETE_AGY_TURN",
			finishedReason,
			message: `agy stopped before finishing its turn (finished_reason=${finishedReason}).`,
		};
	}

	if (parsed.status === "ERROR" || (typeof parsed.error === "string" && parsed.error.trim().length > 0)) {
		return {
			kind: "error",
			code: "INVALID_PROVIDER_JSON",
			message: typeof parsed.error === "string" && parsed.error.trim().length > 0
				? parsed.error.trim()
				: "agy returned status ERROR.",
		};
	}

	const responseText =
		typeof parsed.response === "string"
			? parsed.response
			: typeof parsed.result === "string"
				? parsed.result
				: null;

	if (responseText === null) {
		return {
			kind: "error",
			code: "INVALID_PROVIDER_JSON",
			message: "agy JSON output is missing string field 'response'.",
		};
	}

	const rawUsage = parsed.usage && typeof parsed.usage === "object" ? parsed.usage : {};
	const inputTokens = toNonNegativeInt(rawUsage.input_tokens ?? rawUsage.inputTokens, 0);
	const outputTokens = toNonNegativeInt(rawUsage.output_tokens ?? rawUsage.outputTokens, 0);
	const thinkingTokens = toNonNegativeInt(rawUsage.thinking_tokens ?? rawUsage.thinkingTokens, 0);
	const cacheReadTokens = toNonNegativeInt(rawUsage.cache_read_tokens ?? rawUsage.cacheReadTokens, 0);
	const totalTokens = toNonNegativeInt(
		rawUsage.total_tokens ?? rawUsage.totalTokens,
		inputTokens + outputTokens + thinkingTokens
	);

	const conversationId = String(parsed.conversation_id ?? parsed.conversationId ?? "conv-agy-headless");
	const durationSeconds = Number.isFinite(Number(parsed.duration_seconds ?? parsed.durationSeconds))
		? Math.max(0, Number(parsed.duration_seconds ?? parsed.durationSeconds))
		: 0;
	const numTurns = toNonNegativeInt(parsed.num_turns ?? parsed.numTurns, 1);
	const structuredOutput =
		parsed.structured_output && typeof parsed.structured_output === "object"
			? parsed.structured_output
			: parsed.structuredOutput && typeof parsed.structuredOutput === "object"
				? parsed.structuredOutput
				: undefined;

	return {
		kind: "ok",
		value: Object.freeze({
			conversationId,
			status: "SUCCESS",
			response: responseText,
			durationSeconds,
			numTurns,
			...(structuredOutput ? { structuredOutput } : {}),
			usage: Object.freeze({
				inputTokens,
				outputTokens,
				thinkingTokens,
				cacheReadTokens,
				totalTokens,
			}),
		}),
	};
}

export function parseGeminiCliOutputJson(rawStdout) {
	if (typeof rawStdout !== "string" || rawStdout.trim().length === 0) {
		return { kind: "error", code: "INVALID_PROVIDER_JSON", message: "Empty stdout from gemini CLI." };
	}

	let parsed;
	try {
		parsed = JSON.parse(rawStdout.trim());
	} catch (err) {
		return {
			kind: "error",
			code: "INVALID_PROVIDER_JSON",
			message: `Failed to parse gemini JSON output: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	if (!parsed || typeof parsed !== "object") {
		return { kind: "error", code: "INVALID_PROVIDER_JSON", message: "gemini JSON output is not an object." };
	}

	const responseText =
		typeof parsed.response === "string"
			? parsed.response
			: typeof parsed.text === "string"
				? parsed.text
				: typeof parsed.result === "string"
					? parsed.result
					: null;

	if (responseText === null) {
		return {
			kind: "error",
			code: "INVALID_PROVIDER_JSON",
			message: "gemini JSON output is missing string field 'response' or 'text'.",
		};
	}

	const rawUsage =
		parsed.usage && typeof parsed.usage === "object"
			? parsed.usage
			: parsed.stats?.models && typeof parsed.stats.models === "object"
				? Object.values(parsed.stats.models)[0]?.tokens ?? {}
				: {};

	const inputTokens = toNonNegativeInt(rawUsage.input_tokens ?? rawUsage.inputTokens ?? rawUsage.prompt, 0);
	const outputTokens = toNonNegativeInt(rawUsage.output_tokens ?? rawUsage.outputTokens ?? rawUsage.candidates, 0);
	const thinkingTokens = toNonNegativeInt(rawUsage.thinking_tokens ?? rawUsage.thinkingTokens ?? rawUsage.thoughts, 0);
	const cacheReadTokens = toNonNegativeInt(rawUsage.cache_read_tokens ?? rawUsage.cacheReadTokens ?? rawUsage.cached, 0);
	const totalTokens = toNonNegativeInt(
		rawUsage.total_tokens ?? rawUsage.totalTokens ?? rawUsage.total,
		inputTokens + outputTokens + thinkingTokens
	);

	return {
		kind: "ok",
		value: Object.freeze({
			conversationId: String(parsed.conversation_id ?? parsed.session_id ?? "conv-gemini-cli"),
			status: "SUCCESS",
			response: responseText,
			durationSeconds: Number.isFinite(Number(parsed.duration_seconds)) ? Number(parsed.duration_seconds) : 0,
			numTurns: 1,
			usage: Object.freeze({
				inputTokens,
				outputTokens,
				thinkingTokens,
				cacheReadTokens,
				totalTokens,
			}),
		}),
	};
}

const TASK_CLASSIFICATION_RULES = Object.freeze([
	{
		taskKind: "translation",
		patterns: [
			/\btranslat(e|ion|ing)\b/i,
			/\blocaliz(e|ation)\b/i,
			/\b(i18n|l10n)\b/i,
			/\binto\s+(spanish|japanese|chinese|french|german|korean|portuguese|italian|english)\b/i,
			/(번역|다국어|현지화|한글화|영문으로|한국어로|일본어로|중국어로)/,
		],
		defaultWrite: false,
	},
	{
		taskKind: "review",
		patterns: [
			/\bcode\s+review\b/i,
			/\breview\s+(this|the|my|a)?\s*(diff|pr|pull\s+request|branch|commit|change|patch|code|file|module)\b/i,
			/\bsecurity\s+(audit|review)\b/i,
			/\bfind\s+(bugs|vulnerabilities|regressions)\b/i,
			/\baudit\s+(the|this)\b/i,
			/(코드\s*리뷰|보안\s*감사|보안\s*검토|변경사항\s*검토|리뷰해|검토해|감사해)/,
		],
		defaultWrite: false,
	},
	{
		taskKind: "docs",
		patterns: [
			/\b(readme|changelog|jsdoc|tsdoc|docstring|markdown)\b/i,
			/\b(write|update|generate|edit|refresh)\s+(the\s+)?(docs|documentation|api\s+docs|guide|tutorial|readme)\b/i,
			/\bdocument\s+(the|this|how)\b/i,
			/\bdocs\/[a-z0-9_/-]+\.md\b/i,
			/(문서화|문서\s*(작성|수정|갱신|업데이트|정리)|가이드\s*(작성|수정)|매뉴얼)/,
		],
		defaultWrite: false,
	},
	{
		taskKind: "writing",
		patterns: [
			/\b(release\s+notes|blog\s+post|announcement|commit\s+message|pr\s+description|pull\s+request\s+description)\b/i,
			/\b(summarize|summary|tl;dr|rewrite\s+prose|copywriting|draft\s+an?\s+(email|post|message|note|summary))\b/i,
			/\bwrite\s+a\s+(summary|post|essay|letter|description|announcement)\b/i,
			/(릴리스\s*노트|블로그|공지사항|커밋\s*메시지|초안|요약해|글쓰기|문장\s*다듬|초안\s*작성)/,
		],
		defaultWrite: false,
	},
	{
		taskKind: "architecture",
		patterns: [
			/\b(system\s+design|architecture|architectural|rfc|adr|design\s+doc)\b/i,
			/\b(design|sketch)\s+(the\s+)?(types|schema|state\s+machine|domain\s+model|module\s+boundaries|api\s+contract)\b/i,
			/\btrade-?offs?\s+between\b/i,
			/(아키텍처|시스템\s*설계|도메인\s*모델|트레이드오프|구조\s*설계|인터페이스\s*설계)/,
		],
		defaultWrite: false,
	},
	{
		taskKind: "research",
		patterns: [
			/\b(explain\s+how|how\s+does|why\s+does|investigate|research|survey|explore\s+how)\b/i,
			/\bwhat\s+causes\b/i,
			/\bwalk\s+me\s+through\b/i,
			/(작동\s*방식|동작\s*원리|설명해|조사해|분석해|원인\s*파악)/,
		],
		defaultWrite: false,
	},
	{
		taskKind: "coding-trivial",
		patterns: [
			/\b(rename|typo|format|prettier|eslint|lint\s+fix|bump\s+version|one-line|one\s+liner|simple\s+helper|update\s+constant)\b/i,
			/\badd\s+an?\s+export\b/i,
			/(오타\s*수정|이름\s*변경|포맷팅|린트\s*수정|버전\s*올리|상수\s*수정)/,
		],
		defaultWrite: true,
	},
	{
		taskKind: "coding-complex",
		patterns: [
			/\b(refactor|implement|migrate|concurrency|race\s+condition|deadlock|state\s+machine|parser|compiler|algorithm)\b/i,
			/\b(fix|debug)\s+(the\s+)?(bug|issue|error|crash|regression|test)\b/i,
			/\bmulti-?file\b/i,
			/(리팩토링|구현해|마이그레이션|동시성|레이스\s*컨디션|데드락|버그\s*수정|디버깅)/,
		],
		defaultWrite: true,
	},
]);

const WRITE_INTENT_PATTERN =
	/\b(edit|modify|update|write\s+to|apply|refactor|implement|fix|rename|create\s+file|patch)\b|(파일\s*수정|반영해|고쳐|적용해)/i;

export function classifyTask(prompt, explicitTaskKind, allowFileEdits = false) {
	const text = typeof prompt === "string" ? prompt.trim() : "";

	if (explicitTaskKind && ALL_TASK_KINDS.includes(explicitTaskKind)) {
		const isCoding = explicitTaskKind === "coding-trivial" || explicitTaskKind === "coding-complex";
		return Object.freeze({
			taskKind: explicitTaskKind,
			confidence: 1.0,
			matchedSignals: Object.freeze(["explicit-task-kind"]),
			requiresWorkspaceWrite: Boolean(allowFileEdits || isCoding),
		});
	}

	let bestKind = "coding-complex";
	let bestMatches = [];
	let defaultWrite = true;

	for (const rule of TASK_CLASSIFICATION_RULES) {
		const matches = [];
		for (const pattern of rule.patterns) {
			const match = text.match(pattern);
			if (match) {
				matches.push(match[0].toLowerCase());
			}
		}
		if (matches.length > bestMatches.length) {
			bestKind = rule.taskKind;
			bestMatches = matches;
			defaultWrite = rule.defaultWrite;
		}
	}

	const confidence =
		bestMatches.length === 0
			? 0.55
			: Math.min(0.98, Number((0.72 + (bestMatches.length - 1) * 0.1).toFixed(2)));

	const isReadOnlyKind =
		bestKind === "review" ||
		bestKind === "research" ||
		bestKind === "translation" ||
		bestKind === "architecture";

	const requiresWorkspaceWrite = Boolean(
		allowFileEdits || (!isReadOnlyKind && (defaultWrite || WRITE_INTENT_PATTERN.test(text)))
	);

	return Object.freeze({
		taskKind: bestKind,
		confidence,
		matchedSignals: Object.freeze(bestMatches.length > 0 ? bestMatches : ["default-coding-fallback"]),
		requiresWorkspaceWrite,
	});
}

// A provider limit (5-hour session or agy refresh window) lifts on its own, so an exhaustion
// report only counts while it is younger than that window.
export function isPoolRecentlyExhausted(poolMetrics, windowEnd, thresholds = DEFAULT_GOVERNOR_THRESHOLDS) {
	const lastAt = poolMetrics?.lastRateLimitAt;
	return typeof lastAt === "number" && windowEnd - lastAt < thresholds.exhaustionSignalWindowMs;
}

export function transitionQuotaState(
	previousState,
	metrics,
	thresholds = DEFAULT_GOVERNOR_THRESHOLDS
) {
	const prev = ALL_QUOTA_STATES.includes(previousState) ? previousState : "NORMAL";
	const pools = metrics?.pools ?? {};
	const recentlyExhausted = (poolId) => isPoolRecentlyExhausted(pools[poolId], metrics.windowEnd, thresholds);

	const claudeRatio = Number(pools["claude-code-native"]?.consumedRatio ?? 0);
	const agyClaudeRatio = Number(pools["agy-claude-pool"]?.consumedRatio ?? 0);
	const agyGeminiRatio = Number(pools["agy-gemini-pool"]?.consumedRatio ?? 0);
	const agyMaxRatio = Math.max(agyClaudeRatio, agyGeminiRatio);

	const agyExhausted =
		(recentlyExhausted("agy-claude-pool") && recentlyExhausted("agy-gemini-pool")) ||
		(prev === "FALLBACK_GEMINI_CLI"
			? agyMaxRatio >= thresholds.agyExhaustedBand.exitBelow
			: agyMaxRatio >= thresholds.agyExhaustedBand.enterAt);

	if (agyExhausted) {
		return "FALLBACK_GEMINI_CLI";
	}

	const wasOverflowOrHigher = prev === "OVERFLOW_TO_AGY" || prev === "FALLBACK_GEMINI_CLI";
	const inOverflow =
		recentlyExhausted("claude-code-native") ||
		(wasOverflowOrHigher
			? claudeRatio >= thresholds.overflowToAgyBand.exitBelow
			: claudeRatio >= thresholds.overflowToAgyBand.enterAt);

	if (inOverflow) {
		return "OVERFLOW_TO_AGY";
	}

	const wasConserveOrHigher =
		prev === "CONSERVE_CLAUDE" || prev === "OVERFLOW_TO_AGY" || prev === "FALLBACK_GEMINI_CLI";
	const inConserve = wasConserveOrHigher
		? claudeRatio >= thresholds.conserveClaudeBand.exitBelow
		: claudeRatio >= thresholds.conserveClaudeBand.enterAt;

	if (inConserve) {
		return "CONSERVE_CLAUDE";
	}

	return "NORMAL";
}

function buildPreferredTarget(preferredModel, preferredEffort, allowFileEdits, allowedEditGlobs, applyStrategy) {
	if (isAgyModelSlug(preferredModel)) {
		const cap = MODEL_CAPABILITIES[preferredModel];
		const isolation = allowFileEdits
			? Object.freeze({
					kind: "git-worktree",
					applyStrategy,
					defaultAllowedGlobs: allowedEditGlobs,
				})
			: READ_ONLY_ISOLATION;
		return makeAgyTarget(
			preferredModel,
			preferredEffort ?? cap.defaultEffort,
			allowFileEdits ? "accept-edits" : "plan",
			isolation
		);
	}
	if (isGeminiCliModelSlug(preferredModel)) {
		const cap = MODEL_CAPABILITIES[preferredModel];
		return makeGeminiCliTarget(preferredModel, preferredEffort ?? cap.defaultEffort);
	}
	return null;
}

function adaptTargetForRequest(target, request) {
	const effort = request.preferredEffort ?? target.effort;
	if (target.provider === "agy") {
		const isolation = request.allowFileEdits
			? Object.freeze({
					kind: "git-worktree",
					applyStrategy: request.applyStrategy,
					defaultAllowedGlobs: request.allowedEditGlobs,
				})
			: READ_ONLY_ISOLATION;
		const agyMode = request.allowFileEdits ? "accept-edits" : "plan";
		return Object.freeze({
			...target,
			effort,
			agyMode,
			isolation,
		});
	}
	if (target.provider === "gemini-cli") {
		return Object.freeze({
			...target,
			effort,
		});
	}
	return Object.freeze({
		...target,
		effort,
	});
}

export function resolveRoutePlan({
	request,
	quotaState,
	metrics,
	health,
	policyMatrix = DEFAULT_POLICY_MATRIX,
}) {
	const state = ALL_QUOTA_STATES.includes(quotaState) ? quotaState : "NORMAL";
	const classification = classifyTask(
		request.prompt,
		request.explicitTaskKind,
		request.allowFileEdits
	);

	const baseChain = policyMatrix[state][classification.taskKind];
	const rawChain = [];

	if (request.preferredModel) {
		const preferred = buildPreferredTarget(
			request.preferredModel,
			request.preferredEffort,
			request.allowFileEdits,
			request.allowedEditGlobs,
			request.applyStrategy
		);
		if (preferred) {
			rawChain.push(preferred);
		}
	}

	for (const item of baseChain) {
		rawChain.push(adaptTargetForRequest(item, request));
	}

	const candidates = [];
	const skippedCandidates = [];
	const pools = metrics?.pools ?? {};

	for (const target of rawChain) {
		const providerStatus = health?.[target.provider];
		if (providerStatus?.kind === "unavailable") {
			skippedCandidates.push(Object.freeze({ target, skipReason: "PROVIDER_UNAVAILABLE" }));
			continue;
		}
		if (providerStatus?.kind === "circuit-open") {
			skippedCandidates.push(Object.freeze({ target, skipReason: "CIRCUIT_OPEN" }));
			continue;
		}
		if (request.allowFileEdits && target.provider === "gemini-cli") {
			skippedCandidates.push(Object.freeze({ target, skipReason: "WRITE_UNSUPPORTED" }));
			continue;
		}
		const poolMetrics = pools[target.quotaPool];
		if (
			poolMetrics &&
			(Number(poolMetrics.consumedRatio) >= 1.0 ||
				(target.provider !== "claude-native" && isPoolRecentlyExhausted(poolMetrics, metrics.windowEnd)))
		) {
			skippedCandidates.push(Object.freeze({ target, skipReason: "POOL_EXHAUSTED" }));
			continue;
		}
		candidates.push(target);
	}

	if (candidates.length === 0) {
		candidates.push(makeClaudeNativeTarget(request.preferredEffort ?? "low"));
	}

	const primary = candidates[0];
	const primaryLabel =
		primary.provider === "claude-native"
			? `claude-native (${primary.effort})`
			: `${primary.provider}:${primary.modelSlug} (${primary.effort})`;

	const rationale = `QuotaState=${state}, TaskKind=${classification.taskKind} -> primary=${primaryLabel} (${candidates.length} candidate(s), ${skippedCandidates.length} skipped).`;

	return Object.freeze({
		quotaState: state,
		classification,
		candidates: Object.freeze(candidates),
		skippedCandidates: Object.freeze(skippedCandidates),
		rationale,
	});
}
