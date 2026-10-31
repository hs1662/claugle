# 아키텍처 설계 및 합성 근거

## 해결하려는 문제

Google AI 구독을 보유한 Claude Code 사용자는 Antigravity CLI(`agy`)가 제공하는 13개 모델(Gemini 4 Argon, Gemini 3.8 Flash, Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B)과 독립 실행형 Gemini CLI(`gemini`)의 Gemini 2.5 모델을 함께 쓸 수 있습니다. 그러나 두 환경이 분리되어 있으면 문서 작성이나 번역, 일상적인 코드 리뷰에 호스트 Claude Code의 주간 토큰을 그대로 소모하게 되며 정작 Google AI 구독에 포함된 대용량 할당량은 놀게 됩니다.

실측 조사(Phase A Grounding)에서 확인한 다섯 가지 구조적 제약을 동시에 만족해야 합니다.

1. Claude Code는 마켓플레이스 플러그인을 캐시할 때 `npm install`을 실행하지 않으므로 모든 런타임 코드는 Node.js(`>=18.18`) 기본 내장 모듈만으로 동작해야 합니다.
2. `plugin.json`에 `"agents"` 배열을 명시하면 기본 `agents/*.md` 자동 탐색이 덮어씌워지므로 해당 필드를 생략해야 하며 `commands/*.md` 파일명은 사용자 호출 가능 스킬 이름과 겹치지 않아야 합니다.
3. 전달 서브에이전트가 호스트 세션에서 파일을 미리 읽어 토큰을 쓰지 않도록 `tools: Bash`만 부여해야 합니다.
4. 재귀적인 슬래시 커맨드 및 훅 확장을 막기 위해 모든 `agy -p` 호출에는 `--disable-slash-commands` 옵션과 `CLAUGLE_HEADLESS_SUBPROCESS=1` 환경 변수를 강제해야 합니다.
5. 외부 `agy -p` 프로세스가 파일을 편집할 때 호스트 작업 트리의 미커밋 변경사항이나 다른 병렬 에이전트와 충돌하지 않아야 합니다.

## 호출자 관점의 사용 흐름

사용자는 GitHub 저장소 URL만으로 마켓플레이스를 등록하고 플러그인을 설치합니다.

```bash
claude plugin marketplace add https://github.com/hs1662/claugle.git
claude plugin install claugle@claugle
```

설치 후에는 세 가지 표면에서 동일한 라우팅 엔진을 호출합니다.

### 1. Stdio MCP 서버 도구 (`claugle_write`, `claugle_review`, `claugle_run`, `claugle_quota`)

호스트 Claude가 서브에이전트를 띄우지 않고 `.mcp.json`에 등록된 stdio JSON-RPC 2.0 서버를 직접 호출합니다.

```json
{
	"name": "claugle_write",
	"arguments": {
		"prompt": "스토리지 서브시스템 마이그레이션 가이드를 작성해줘.",
		"contextFiles": ["docs/architecture.md"],
		"preferredModel": "gemini-4-argon-high",
		"effort": "high"
	}
}
```

### 2. 슬래시 커맨드와 전달 서브에이전트

사용자가 `/claugle:write`, `/claugle:review`, `/claugle:task`, `/claugle:quota`, `/claugle:explain`을 입력하거나 Claude가 `claugle:gemini-writer`, `claugle:agy-coder`, `claugle:agy-reviewer` 서브에이전트를 호출하면 각 컴포넌트가 `scripts/claugle.mjs`를 실행합니다.

### 3. Node ESM 프로그래밍 인터페이스

외부 스크립트나 테스트에서 `claugle.mjs`의 순수 함수와 실행기를 직접 불러와 조합할 수 있습니다.

```js
import {
	executeRoutedTask,
	parsePluginEnv,
	parseTaskRequest,
} from "./claugle.mjs";

const env = parsePluginEnv(process.env);
const request = parseTaskRequest({
	prompt: "docs/routing.md에 4단계 할당량 상태 전환 규칙을 정리해줘.",
	explicitTaskKind: "docs",
	cwd: process.cwd(),
	allowFileEdits: true,
	allowedEditGlobs: ["docs/**/*.md", "README.md"],
});

if (env.kind === "ok" && request.kind === "ok") {
	const outcome = await executeRoutedTask({
		request: request.value,
		env: env.value,
	});
}
```

## 핵심 도메인 구조

도메인 모델은 세 가지 핵심 자료구조 위에 세워져 있습니다.

1. **`QuotaState` 및 `GovernorThresholds` (4단계 히스테리시스 상태 머신)**: `claude-code-native`, `agy-claude-pool`, `agy-gemini-pool`, `gemini-cli-pool` 네 풀의 7일 롤링 소비율을 바탕으로 `NORMAL`, `CONSERVE_CLAUDE`, `OVERFLOW_TO_AGY`, `FALLBACK_GEMINI_CLI` 상태를 결정합니다. 각 경계마다 탈출 비율(`exitBelow`)을 진입 비율(`enterAt`)보다 낮게 설정한 `HysteresisBand`를 두어 경계선 부근에서 라우팅 대상이 진동하지 않습니다.
2. **`PolicyMatrix` (32-셀 2차원 전수 조회 테이블)**: 4개 할당량 상태와 8개 작업 유형(`writing`, `docs`, `translation`, `research`, `review`, `coding-trivial`, `coding-complex`, `architecture`)의 모든 조합을 비어 있지 않은 폴백 배열(`NonEmptyArray<RouteTarget>`)에 매핑합니다.
3. **`RouteTarget` (`provider` 판별 유니온)**: `"claude-native" | "agy" | "gemini-cli"` 세 공급자별로 필요한 필드를 타입 수준에서 분기합니다. 특히 `AgyCliInvocation`은 `disableSlashCommands: true`를 리터럴 타입으로 고정해 재귀 호출 방지 규칙을 코드 구조 자체에 각인했습니다.
4. **`MODEL_FAMILY_CATALOG` 및 `resolveModelAndEffort` (모델 패밀리·추론 강도 결합 해석기)**: Claude Code의 `/model` 선택 창은 모델 ID(`settings.json#model`)와 추론 강도(`modelSettings[model].effortLevel` 및 `/v1/messages`의 `output_config.effort`)를 분리해 전달하는 반면 `agy` CLI는 강도별 변형을 개별 슬러그(`gemini-4-argon-low`, `gemini-4-argon-medium`, `gemini-4-argon-high` 등)로 구분합니다. `MODEL_FAMILY_CATALOG`는 8개 기본 패밀리(`gemini-4-argon`, `gemini-3.8-flash`, `agy-opus-5-5`, `agy-sonnet-5-5`, `gpt-oss-120b`, `gemini-2.5-pro`, `gemini-2.5-flash`, `claugle-auto`)의 `behavesAs`와 강도별 슬러그 매핑(`variantsByEffort`)을 단일 테이블에 보관하며 `resolveModelAndEffort`가 `/model` 창의 좌우 방향키 강도 선택값을 정확한 `agy` 슬러그로 결합합니다.

외부 입력 검증은 시스템 경계 함수인 `parsePluginEnv`, `parseTaskRequest`, `parseAgyOutputJson`, `parseGeminiCliOutputJson`에서 한 번에 처리하며 내부 순수 함수는 검증된 도메인 타입만 신뢰합니다.

동시 실행 중 발생하는 공유 상태 경합은 두 곳에서 구조적으로 분리해 제거했습니다.

- **프로세스별 JSONL 원장 샤드**: 각 실행 프로세스는 단일 파일에 락을 걸지 않고 `${CLAUDE_PLUGIN_DATA}/ledger/shard-${sessionId}-${pid}.jsonl`에 `UsageLedgerEvent` 한 줄을 추가합니다. `loadRollingQuotaSnapshot`이 읽기 시점에 샤드들을 모아 `TaskExecutionId` 기준으로 중복을 제거하며 `compactExpiredLedgerShards`가 `SessionStart` 훅에서 14일 지난 샤드를 정리합니다.
- **작업 단위 Git 워크트리 격리**: 파일 편집이 필요한 `agy` 호출은 `${CLAUDE_PLUGIN_DATA}/worktrees/${taskId}`에 분리된 워크트리를 생성해 실행합니다. 실행 후 `harvestAndReleaseWorktree`가 변경된 파일 경로를 `allowedGlobs`와 대조하고 이상이 없으면 `git apply --3way`로 호스트 저장소에 반영합니다. 호스트 작업 트리와 충돌할 경우에는 호스트 파일을 건드리지 않고 `claugle/task-${taskId}` 브랜치에 커밋을 남겨 작업 손실을 막습니다.

## 3개 설계 후보 교차 심판 및 합성 결정

구현에 앞서 세 개의 독립된 설계 후보를 작성하고 교차 심판(Cross-Judge) 루브릭으로 비교했습니다.

| 후보 | 점수 | 핵심 강점 및 한계 |
|---|---:|---|
| 후보 1 | 20.5 / 25 | `.mcp.json` 기반 stdio MCP 도구 4종(`claugle_run`, `claugle_write`, `claugle_review`, `claugle_quota`)과 14일 샤드 압축을 잘 정의했으나 외부 CLI가 호스트 작업 트리를 직접 수정하도록 두어 동시 편집 충돌에 취약함 |
| 후보 2 | 24.5 / 25 | 4단계 히스테리시스 거버너, 32-셀 `PolicyMatrix`, Git 워크트리 격리 및 3-way 패치 반영, 타입 수준 CLI 불변식을 완비함 |
| 후보 3 | 17.5 / 25 | 슬래시 커맨드 인자 토크나이저(`tokenizeShellArgs`)는 유용했으나 단일 `ledger.json` 파일을 사용해 병렬 서브에이전트 실행 시 데이터 유실 위험이 있음 |

최종 설계는 **후보 2(24.5/25)**를 기본 뼈대로 삼아 **후보 1**의 stdio MCP 서버 도구 4종·모델 역량 레지스트리(`MODEL_CAPABILITIES`)·14일 샤드 압축 로직과 **후보 3**의 셸 인자 토크나이저를 이식해 완성했습니다.

## 수용한 트레이드오프와 기각한 대안

- **트레이드오프**: 파일 잠금 경합을 완전히 없애기 위해 `loadRollingQuotaSnapshot` 호출 시 프로세스별 JSONL 샤드를 읽어 합산합니다. 또한 호스트 미커밋 파일을 보호하려고 파일 수정 작업 시 임시 Git 워크트리를 생성하는 디스크·프로세스 비용을 감수했으며 `UserPromptSubmit` 훅 지연을 10ms 미만으로 유지하고 분류 토큰 소모를 0으로 만들기 위해 LLM 호출 대신 결정적 어휘 분류기(`classifyTask`)를 채택했습니다.
- **배제한 설계**: 가중치 계산식이 불투명해 디버깅이 까다로운 부동소수점 점수 라우터는 배제했습니다. 비정상 종료 시 데드락을 일으키는 단일 락파일 JSON 원장과 백그라운드 유닉스 소켓 데몬도 채택하지 않았습니다.
