# claugle 플러그인 상세 가이드

`claugle`은 Claude Code 세션 안에서 Google AI 구독 모델(`agy -p` 및 `gemini -p`)을 호출하고 4개 할당량 풀의 7일 롤링 토큰 예산을 관리하는 플러그인 본체입니다.

## GitHub에서 바로 설치하기

Claude Code에서 마켓플레이스를 추가한 뒤 플러그인을 설치합니다.

```bash
claude plugin marketplace add https://github.com/hs1662/claugle.git
claude plugin install claugle@claugle
```

단일 명령으로 한 번에 설치할 수도 있습니다.

```bash
claude plugin install claugle --marketplace https://github.com/hs1662/claugle.git
```

## 4개 할당량 풀과 지원 모델

`claugle`은 총 15개의 외부 모델과 호스트 세션을 네 개의 독립된 7일 롤링 토큰 풀로 나누어 집계합니다.

| 할당량 풀 ID | 기본 주간 예산 | 포함 모델 | 주력 역할 |
|---|---:|---|---|
| `claude-code-native` | 5,000,000 토큰 | 호스트 Claude Code 세션 | `NORMAL` 상태의 복잡한 코딩(`coding-complex`) 및 시스템 아키텍처(`architecture`) |
| `agy-gemini-pool` | 15,000,000 토큰 | `gemini-4-argon-{high,medium,low}`, `gemini-3.8-flash-{high,medium,low}`, `gpt-oss-120b-medium` | 글쓰기(`writing`), 문서 갱신(`docs`), 다국어 번역(`translation`), 코드 조사(`research`), 단순 수정(`coding-trivial`) |
| `agy-claude-pool` | 8,000,000 토큰 | `claude-opus-5-5-{high,medium,low}`, `claude-sonnet-5-5-{high,medium,low}` | 정밀 코드 리뷰(`review`) 및 호스트 한도 절약·초과 시 복잡한 코딩·아키텍처 백업 |
| `gemini-cli-pool` | 10,000,000 토큰 | `gemini-2.5-pro`, `gemini-2.5-flash` | 읽기 전용 집필·번역·리서치 폴백 및 Antigravity 풀 소진 시 비상 경로 |

주간 예산 기본값은 `/plugin configure claugle@claugle` 메뉴나 환경 변수(`CLAUGLE_CLAUDE_WEEKLY_TOKEN_BUDGET`, `CLAUGLE_AGY_CLAUDE_WEEKLY_TOKEN_BUDGET`, `CLAUGLE_AGY_GEMINI_WEEKLY_TOKEN_BUDGET`, `CLAUGLE_GEMINI_CLI_WEEKLY_TOKEN_BUDGET`)로 구독 등급에 맞게 언제든 조정할 수 있습니다.

## 4단계 히스테리시스 거버너와 라우팅 동작

단일 임계값만 두면 사용량이 경계선 근처에 머물 때 상태가 매번 뒤바뀌는 채터링이 발생합니다. `claugle`은 진입 기준(`enterAt`)과 복귀 기준(`exitBelow`)을 분리해 상태 전환을 안정화했습니다.

- **`NORMAL`**: 기본 상태입니다. 글쓰기, 문서화, 번역, 리서치, 코드 리뷰, 단순 코딩은 Google AI 모델로 즉시 보내며 복잡한 코딩과 아키텍처 설계만 호스트 Claude Code에서 처리합니다.
- **`CONSERVE_CLAUDE`**: 호스트 Claude 주간 사용률이 70%에 도달하면 진입하며 65% 아래로 내려가야 해제됩니다. 이때부터 복잡한 코딩은 `claude-sonnet-5-5-high`와 `claude-opus-5-5-high`가, 아키텍처 설계는 `claude-opus-5-5-high`와 `gemini-4-argon-high`가 1·2순위로 먼저 처리합니다.
- **`OVERFLOW_TO_AGY`**: 호스트 Claude 주간 사용률이 90%에 도달하면 진입하며 82% 아래로 내려가야 해제됩니다. 여덟 가지 작업 유형 전부를 Antigravity와 Gemini CLI 모델로 우회시켜 호스트 세션이 주간 한도 차단벽에 부딪히지 않게 보호합니다.
- **`FALLBACK_GEMINI_CLI`**: Antigravity 풀(`agy-claude-pool` 또는 `agy-gemini-pool`) 사용률이 95%를 넘으면 진입하며 88% 아래로 떨어져야 해제됩니다. 독립 실행형 `gemini-cli` 모델(`gemini-2.5-pro`, `gemini-2.5-flash`)과 저비용 모델을 최우선으로 배치합니다.

## 제공 컴포넌트 상세

### 1. Stdio MCP 서버 도구 (`.mcp.json`)

서브에이전트 턴을 새로 열지 않아도 호스트 Claude가 즉석에서 부를 수 있도록 JSON-RPC 2.0 도구 네 개를 제공합니다.

- `claugle_write`: 릴리스 노트, README, 번역문, 커밋 메시지, 요약문 작성을 Gemini 모델로 위임합니다. `allowFileEdits: true`와 `allowedEditGlobs`를 함께 넘기면 격리된 워크트리에서 마크다운 파일을 직접 수정한 뒤 반영합니다.
- `claugle_review`: 읽기 전용 모드(`--mode plan`)로 `claude-sonnet-5-5-high`, `claude-opus-5-5-high`, `gemini-4-argon-high`에 코드 리뷰와 보안 감사를 맡깁니다.
- `claugle_run`: 코딩, 리서치, 아키텍처 작업을 32-셀 정책 행렬에 따라 라우팅하고 파일 편집 시 워크트리 샌드박스를 자동으로 적용합니다.
- `claugle_quota`: 4개 풀의 7일 누적 토큰, 소비 비율, 현재 `QuotaState`, 바이너리 헬스 및 서킷 브레이커 상태를 JSON으로 반환합니다.

### 2. 슬래시 커맨드 (`commands/*.md`)

- `/claugle:write [--model <slug>] [--allow-edits] [--glob <pattern>] <prompt>`: 문서 작성·번역·요약 작업을 Google AI Gemini 모델로 실행합니다.
- `/claugle:review [--model <slug>] [--effort <level>] [--context <file>] <prompt>`: 지정한 파일이나 변경사항을 대상으로 읽기 전용 코드 리뷰를 수행합니다.
- `/claugle:task [--model <slug>] [--effort <level>] [--kind <task-kind>] [--allow-edits] <prompt>`: 작업 종류나 모델·추론 강도를 직접 지정해 라우팅된 작업을 실행합니다.
- `/claugle:quota`: 현재 7일 롤링 사용량과 할당량 상태를 요약해 보여줍니다.
- `/claugle:explain [--model <slug>] [--effort <level>] [--kind <task-kind>] <prompt>`: 실제 모델을 호출하지 않고 프롬프트 분류 결과와 선택된 폴백 후보 체인, 제외된 후보 사유를 출력합니다.

### 3. 얇은 전달 서브에이전트 (`agents/*.md`)

호스트 Claude가 서브에이전트를 띄우기 전에 저장소 파일을 읽느라 토큰을 낭비하지 않도록 세 서브에이전트(`claugle:gemini-writer`, `claugle:agy-coder`, `claugle:agy-reviewer`)는 모두 `tools: Bash`만 가지며 `scripts/claugle.mjs`를 한 줄로 호출해 결과를 그대로 돌려줍니다.

### 4. 생명주기 훅 (`hooks/hooks.json`)

- `SessionStart`: 원장 및 워크트리 디렉토리를 준비하고 `CLAUDE_PLUGIN_DATA` 경로를 `CLAUDE_ENV_FILE`에 기록합니다. 이어서 14일 지난 샤드 파일과 2시간 지난 방치 워크트리를 정리하고 현재 할당량 요약을 세션 컨텍스트에 주입합니다.
- `UserPromptSubmit`: 프롬프트가 들어오면 10ms 안에 정적 어휘 규칙으로 분류합니다. Google AI 모델에 적합한 작업이면 추천 MCP 도구와 서브에이전트 안내를 컨텍스트에 덧붙입니다.

### 5. 로컬 `/v1/messages` 게이트웨이와 모델 별칭 (`scripts/anthropic-gateway.mjs`)

호스트 Anthropic 계정의 5시간 세션 한도가 바닥났을 때도 Claude Code 하네스를 멈추지 않고 쓸 수 있도록 로컬 HTTP 브리지(`127.0.0.1:18789`)를 내장했습니다. `SessionStart` 훅이나 `claugle gateway --daemon`이 백그라운드 데몬을 자동으로 띄우며 `~/.claude/settings.json`에 `"ANTHROPIC_BASE_URL": "http://127.0.0.1:18789"`와 `"model": "gemini-4-argon-high"`를 설정하면 `claude --model argon`, `claude --model flash`, `/model argon`, `/claugle:*` 슬래시 커맨드가 모두 Google AI 구독 풀 위에서 바로 동작합니다.
