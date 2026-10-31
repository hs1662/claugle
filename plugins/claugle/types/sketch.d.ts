export type NonEmptyArray<T> = readonly [T, ...T[]];

export type TaskExecutionId = string & { readonly __brand: "TaskExecutionId" };
export type ConversationId = string & { readonly __brand: "ConversationId" };
export type SessionId = string & { readonly __brand: "SessionId" };
export type AbsolutePath = string & { readonly __brand: "AbsolutePath" };
export type RelativeGlob = string & { readonly __brand: "RelativeGlob" };
export type EpochMs = number & { readonly __brand: "EpochMs" };
export type UnitIntervalRatio = number & { readonly __brand: "UnitIntervalRatio" };
export type NonNegativeInt = number & { readonly __brand: "NonNegativeInt" };

export type ParseResult<T> =
	| { readonly kind: "ok"; readonly value: T }
	| { readonly kind: "error"; readonly code: ValidationErrorCode; readonly message: string };

export type ValidationErrorCode =
	| "INVALID_ENV"
	| "INVALID_REQUEST"
	| "INVALID_HOOK_STDIN"
	| "INVALID_PROVIDER_JSON"
	| "INVALID_PATH"
	| "GLOB_VIOLATION";

export type AgyGeminiModelSlug =
	| "gemini-4-argon-high"
	| "gemini-4-argon-medium"
	| "gemini-4-argon-low"
	| "gemini-3.8-flash-high"
	| "gemini-3.8-flash-medium"
	| "gemini-3.8-flash-low";

export type AgyClaudeModelSlug =
	| "claude-opus-5-5-high"
	| "claude-opus-5-5-medium"
	| "claude-opus-5-5-low"
	| "claude-sonnet-5-5-high"
	| "claude-sonnet-5-5-medium"
	| "claude-sonnet-5-5-low";

export type AgyOpenWeightsModelSlug = "gpt-oss-120b-medium";

export type AgyModelSlug =
	| AgyGeminiModelSlug
	| AgyClaudeModelSlug
	| AgyOpenWeightsModelSlug;

export type AgyModelFamily = "gemini" | "claude" | "open-weights";

export type GeminiCliModelSlug =
	| "gemini-2.5-pro"
	| "gemini-2.5-flash";

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export type AgyExecutionMode = "plan" | "accept-edits" | "auto";

export type ProviderId = "claude-native" | "agy" | "gemini-cli";

export type QuotaPoolId =
	| "claude-code-native"
	| "agy-claude-pool"
	| "agy-gemini-pool"
	| "gemini-cli-pool";

export type QuotaState =
	| "NORMAL"
	| "CONSERVE_CLAUDE"
	| "OVERFLOW_TO_AGY"
	| "FALLBACK_GEMINI_CLI";

export interface HysteresisBand {
	readonly enterAt: UnitIntervalRatio;
	readonly exitBelow: UnitIntervalRatio;
}

export interface GovernorThresholds {
	readonly windowDurationMs: NonNegativeInt;
	readonly conserveClaudeBand: HysteresisBand;
	readonly overflowToAgyBand: HysteresisBand;
	readonly agyExhaustedBand: HysteresisBand;
	readonly circuitBreakerCooldownMs: NonNegativeInt;
}

export interface PoolUsageMetrics {
	readonly poolId: QuotaPoolId;
	readonly consumedTokens: NonNegativeInt;
	readonly weeklyTokenBudget: NonNegativeInt;
	readonly consumedRatio: UnitIntervalRatio;
	readonly requestCount: NonNegativeInt;
	readonly rateLimitHitsInWindow: NonNegativeInt;
	readonly lastRateLimitAt: EpochMs | null;
}

export interface RollingWindowMetrics {
	readonly windowStart: EpochMs;
	readonly windowEnd: EpochMs;
	readonly pools: Readonly<Record<QuotaPoolId, PoolUsageMetrics>>;
}

export type ProviderHealthStatus =
	| { readonly kind: "healthy"; readonly binaryPath: AbsolutePath }
	| {
			readonly kind: "circuit-open";
			readonly binaryPath: AbsolutePath;
			readonly openedAt: EpochMs;
			readonly reopenAt: EpochMs;
			readonly reason: "QUOTA_EXHAUSTED" | "AUTH_FAILURE" | "CONSECUTIVE_TIMEOUTS";
	  }
	| { readonly kind: "unavailable"; readonly reason: string };

export type ProviderHealthMap = Readonly<Record<ProviderId, ProviderHealthStatus>>;

export type TaskKind =
	| "writing"
	| "docs"
	| "translation"
	| "research"
	| "review"
	| "coding-trivial"
	| "coding-complex"
	| "architecture";

export interface ModelCapability {
	readonly slug: AgyModelSlug | GeminiCliModelSlug;
	readonly provider: "agy" | "gemini-cli";
	readonly quotaPool: QuotaPoolId;
	readonly family: AgyModelFamily;
	readonly defaultEffort: EffortLevel;
	readonly recommendedTasks: readonly TaskKind[];
}

export interface TaskClassification {
	readonly taskKind: TaskKind;
	readonly confidence: UnitIntervalRatio;
	readonly matchedSignals: readonly string[];
	readonly requiresWorkspaceWrite: boolean;
}

export type WorkspaceIsolationPolicy =
	| { readonly kind: "read-only" }
	| {
			readonly kind: "git-worktree";
			readonly applyStrategy: "patch-if-clean" | "branch-only";
			readonly defaultAllowedGlobs: NonEmptyArray<RelativeGlob>;
	  };

export type RouteTarget =
	| {
			readonly provider: "claude-native";
			readonly quotaPool: "claude-code-native";
			readonly effort: EffortLevel;
			readonly executionMode: "host-inline";
	  }
	| {
			readonly provider: "agy";
			readonly quotaPool: "agy-claude-pool" | "agy-gemini-pool";
			readonly modelSlug: AgyModelSlug;
			readonly family: AgyModelFamily;
			readonly effort: EffortLevel;
			readonly agyMode: AgyExecutionMode;
			readonly isolation: WorkspaceIsolationPolicy;
			readonly timeoutMs: NonNegativeInt;
	  }
	| {
			readonly provider: "gemini-cli";
			readonly quotaPool: "gemini-cli-pool";
			readonly modelSlug: GeminiCliModelSlug;
			readonly effort: EffortLevel;
			readonly agyMode: "plan";
			readonly isolation: { readonly kind: "read-only" };
			readonly timeoutMs: NonNegativeInt;
	  };

export type PolicyMatrix = Readonly<
	Record<QuotaState, Readonly<Record<TaskKind, NonEmptyArray<RouteTarget>>>>
>;

export interface RoutePlan {
	readonly quotaState: QuotaState;
	readonly classification: TaskClassification;
	readonly candidates: NonEmptyArray<RouteTarget>;
	readonly skippedCandidates: readonly {
		readonly target: RouteTarget;
		readonly skipReason: "PROVIDER_UNAVAILABLE" | "CIRCUIT_OPEN" | "POOL_EXHAUSTED" | "WRITE_UNSUPPORTED";
	}[];
	readonly rationale: string;
}

export interface WorktreeLease {
	readonly taskId: TaskExecutionId;
	readonly hostRepoRoot: AbsolutePath;
	readonly worktreePath: AbsolutePath;
	readonly baseCommitSha: string;
	readonly branchName: string;
	readonly allowedGlobs: NonEmptyArray<RelativeGlob>;
	readonly applyStrategy: "patch-if-clean" | "branch-only";
	readonly createdAt: EpochMs;
}

export type WorktreeHarvestOutcome =
	| { readonly kind: "no-changes"; readonly worktreeCleanedUp: true }
	| { readonly kind: "applied-to-host"; readonly modifiedFiles: readonly string[]; readonly worktreeCleanedUp: true }
	| {
			readonly kind: "preserved-on-branch";
			readonly branchName: string;
			readonly modifiedFiles: readonly string[];
			readonly reason: "BRANCH_ONLY_STRATEGY" | "HOST_CONFLICT_ON_3WAY_APPLY";
			readonly worktreeCleanedUp: true;
	  }
	| { readonly kind: "rejected-glob-violation"; readonly violatingFiles: NonEmptyArray<string>; readonly worktreeCleanedUp: true };

export interface UsageLedgerEvent {
	readonly eventId: TaskExecutionId;
	readonly sessionId: SessionId;
	readonly recordedAt: EpochMs;
	readonly provider: ProviderId;
	readonly quotaPool: QuotaPoolId;
	readonly modelSlug: AgyModelSlug | GeminiCliModelSlug | "claude-host";
	readonly taskKind: TaskKind;
	readonly inputTokens: NonNegativeInt;
	readonly outputTokens: NonNegativeInt;
	readonly thinkingTokens: NonNegativeInt;
	readonly cacheReadTokens: NonNegativeInt;
	readonly totalTokens: NonNegativeInt;
	readonly durationMs: NonNegativeInt;
	readonly status: "SUCCESS" | "QUOTA_EXHAUSTED" | "ERROR";
}

export interface AgySuccessPayload {
	readonly conversationId: ConversationId;
	readonly status: "SUCCESS";
	readonly response: string;
	readonly durationSeconds: number;
	readonly numTurns: NonNegativeInt;
	readonly structuredOutput?: Readonly<Record<string, unknown>>;
	readonly usage: {
		readonly inputTokens: NonNegativeInt;
		readonly outputTokens: NonNegativeInt;
		readonly thinkingTokens: NonNegativeInt;
		readonly cacheReadTokens: NonNegativeInt;
		readonly totalTokens: NonNegativeInt;
	};
}

export interface McpToolDefinition {
	readonly name: "claugle_run" | "claugle_write" | "claugle_review" | "claugle_quota";
	readonly description: string;
	readonly inputSchema: {
		readonly type: "object";
		readonly properties: Readonly<Record<string, unknown>>;
		readonly required?: readonly string[];
	};
}

export interface PluginEnv {
	readonly pluginRoot: AbsolutePath;
	readonly pluginDataDir: AbsolutePath;
	readonly projectDir: AbsolutePath;
	readonly sessionId: SessionId;
	readonly envFile?: AbsolutePath;
	readonly weeklyBudgets: Readonly<Record<QuotaPoolId, NonNegativeInt>>;
	readonly defaultAgyMode: AgyExecutionMode;
	readonly agyBinOverride?: string;
	readonly geminiBinOverride?: string;
}

export interface TaskRequest {
	readonly taskId: TaskExecutionId;
	readonly prompt: string;
	readonly explicitTaskKind?: TaskKind;
	readonly preferredModel?: AgyModelSlug | GeminiCliModelSlug;
	readonly preferredEffort?: EffortLevel;
	readonly cwd: AbsolutePath;
	readonly contextFiles: readonly string[];
	readonly allowFileEdits: boolean;
	readonly allowedEditGlobs: NonEmptyArray<RelativeGlob>;
	readonly applyStrategy: "patch-if-clean" | "branch-only";
}

export interface AgyCliInvocation {
	readonly binaryPath: AbsolutePath;
	readonly prompt: string;
	readonly modelSlug: AgyModelSlug;
	readonly effort: EffortLevel;
	readonly mode: AgyExecutionMode;
	readonly outputFormat: "json";
	readonly disableSlashCommands: true;
	readonly cwd: AbsolutePath;
	readonly addDirs?: readonly AbsolutePath[];
	readonly timeoutMs: NonNegativeInt;
}

export type ProviderExecutionFailureReason =
	| "QUOTA_EXHAUSTED"
	| "RATE_LIMITED"
	| "AUTH_REQUIRED"
	| "TIMEOUT"
	| "NON_ZERO_EXIT"
	| "MALFORMED_JSON";

export type ProviderExecutionResult =
	| {
			readonly kind: "success";
			readonly payload: AgySuccessPayload;
			readonly durationMs: NonNegativeInt;
	  }
	| {
			readonly kind: "failure";
			readonly reason: ProviderExecutionFailureReason;
			readonly message: string;
			readonly exitCode: number | null;
			readonly durationMs: NonNegativeInt;
	  };

export interface RoutedTaskOutcome {
	readonly taskId: TaskExecutionId;
	readonly status: "COMPLETED" | "DELEGATE_TO_HOST" | "FAILED";
	readonly selectedTarget: RouteTarget;
	readonly attemptedTargets: readonly RouteTarget[];
	readonly plan: RoutePlan;
	readonly responseText: string;
	readonly worktreeOutcome?: WorktreeHarvestOutcome;
	readonly ledgerEvent?: UsageLedgerEvent;
}

export declare const MODEL_CAPABILITIES: Readonly<
	Record<AgyModelSlug | GeminiCliModelSlug, ModelCapability>
>;
export declare const DEFAULT_GOVERNOR_THRESHOLDS: GovernorThresholds;
export declare const DEFAULT_POLICY_MATRIX: PolicyMatrix;

export declare function isAgyModelSlug(value: unknown): value is AgyModelSlug;
export declare function isGeminiCliModelSlug(value: unknown): value is GeminiCliModelSlug;
export declare function isUnitIntervalRatio(value: unknown): value is UnitIntervalRatio;
export declare function createTaskExecutionId(nowMs?: number, randomHex?: string): TaskExecutionId;
export declare function parseAbsolutePath(raw: unknown): ParseResult<AbsolutePath>;
export declare function parseRelativeGlob(raw: unknown): ParseResult<RelativeGlob>;
export declare function parsePluginEnv(rawEnv?: NodeJS.ProcessEnv): ParseResult<PluginEnv>;
export declare function parseTaskRequest(rawInput: unknown): ParseResult<TaskRequest>;
export declare function parseAgyOutputJson(rawStdout: string): ParseResult<AgySuccessPayload>;
export declare function parseGeminiCliOutputJson(rawStdout: string): ParseResult<AgySuccessPayload>;
export declare function classifyTask(
	prompt: string,
	explicitTaskKind?: TaskKind,
	allowFileEdits?: boolean
): TaskClassification;
export declare function transitionQuotaState(
	previousState: QuotaState,
	metrics: RollingWindowMetrics,
	thresholds?: GovernorThresholds
): QuotaState;
export declare function resolveRoutePlan(params: {
	readonly request: TaskRequest;
	readonly quotaState: QuotaState;
	readonly metrics: RollingWindowMetrics;
	readonly health: ProviderHealthMap;
	readonly thresholds?: GovernorThresholds;
	readonly policyMatrix?: PolicyMatrix;
}): RoutePlan;

export declare function appendUsageEvent(params: {
	readonly pluginDataDir: AbsolutePath;
	readonly event: Partial<UsageLedgerEvent>;
	readonly pid?: number;
}): { readonly shardPath: string; readonly event: UsageLedgerEvent };

export declare function loadRollingQuotaSnapshot(params: {
	readonly pluginDataDir: AbsolutePath;
	readonly weeklyBudgets?: Readonly<Partial<Record<QuotaPoolId, NonNegativeInt>>>;
	readonly nowMs?: number;
	readonly previousState?: QuotaState;
	readonly thresholds?: GovernorThresholds;
}): {
	readonly quotaState: QuotaState;
	readonly metrics: RollingWindowMetrics;
	readonly totalEventsInWindow: number;
	readonly shardCount: number;
};

export declare function compactExpiredLedgerShards(params: {
	readonly pluginDataDir: AbsolutePath;
	readonly nowMs?: number;
	readonly maxAgeMs?: number;
}): {
	readonly removedShards: readonly string[];
	readonly compactedShards: readonly string[];
	readonly retainedShards: readonly string[];
};

export declare function acquireWorktreeLease(params: {
	readonly taskId?: TaskExecutionId;
	readonly hostRepoRoot: AbsolutePath;
	readonly pluginDataDir: AbsolutePath;
	readonly allowedGlobs?: readonly RelativeGlob[];
	readonly applyStrategy?: "patch-if-clean" | "branch-only";
	readonly nowMs?: number;
}): WorktreeLease;

export declare function harvestAndReleaseWorktree(lease: WorktreeLease): WorktreeHarvestOutcome;
export declare function abortWorktreeLease(lease: WorktreeLease): void;

export declare function reconcileStaleWorktrees(params: {
	readonly hostRepoRoot?: AbsolutePath;
	readonly pluginDataDir: AbsolutePath;
	readonly nowMs?: number;
	readonly maxAgeMs?: number;
}): {
	readonly prunedWorktrees: readonly string[];
	readonly retainedWorktrees: readonly string[];
};

export declare function detectProviderHealth(env?: Partial<PluginEnv>, nowMs?: number): ProviderHealthMap;
export declare function buildAgyCliArgs(invocation: AgyCliInvocation): readonly string[];
export declare function runHeadlessProvider(params: {
	readonly provider: "agy" | "gemini-cli";
	readonly binaryPath: AbsolutePath;
	readonly prompt: string;
	readonly modelSlug: AgyModelSlug | GeminiCliModelSlug;
	readonly effort?: EffortLevel;
	readonly mode?: AgyExecutionMode;
	readonly cwd?: AbsolutePath;
	readonly addDirs?: readonly AbsolutePath[];
	readonly timeoutMs?: NonNegativeInt;
}): Promise<ProviderExecutionResult>;

export declare function executeRoutedTask(params: {
	readonly request: TaskRequest;
	readonly env: PluginEnv;
	readonly nowMs?: number;
	readonly thresholds?: GovernorThresholds;
	readonly policyMatrix?: PolicyMatrix;
	readonly health?: ProviderHealthMap;
}): Promise<RoutedTaskOutcome>;

export declare function evaluateHookEvent(params: {
	readonly hookStdinJson: string | Readonly<Record<string, unknown>>;
	readonly env?: PluginEnv | NodeJS.ProcessEnv;
	readonly nowMs?: number;
}): Readonly<Record<string, unknown>>;

export declare const MCP_TOOL_DEFINITIONS: readonly McpToolDefinition[];
export declare function handleMcpJsonRpcRequest(
	message: Readonly<Record<string, unknown>>,
	rawEnv?: NodeJS.ProcessEnv
): Promise<Readonly<Record<string, unknown>> | null>;
export declare function tokenizeShellArgs(rawArgString: string): string[];

