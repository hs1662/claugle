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
| `gemini-cli-pool` | 10,000,000 토큰 | `gemini-2.5-pro`, `gemini-2.5-flash` | 경로 계획에는 남아 있지만 claugle이 도구를 막을 수 없어 실행하지 않습니다. 이 후보에 닿은 작업은 호스트 Claude Code로 넘어갑니다. |

주간 예산 기본값은 `/plugin configure claugle@claugle` 메뉴나 환경 변수(`CLAUGLE_CLAUDE_WEEKLY_TOKEN_BUDGET`, `CLAUGLE_AGY_CLAUDE_WEEKLY_TOKEN_BUDGET`, `CLAUGLE_AGY_GEMINI_WEEKLY_TOKEN_BUDGET`, `CLAUGLE_GEMINI_CLI_WEEKLY_TOKEN_BUDGET`)로 구독 등급에 맞게 언제든 조정할 수 있습니다.

## 4단계 히스테리시스 거버너와 라우팅 동작

단일 임계값만 두면 사용량이 경계선 근처에 머물 때 상태가 매번 뒤바뀌는 채터링이 발생합니다. `claugle`은 진입 기준(`enterAt`)과 복귀 기준(`exitBelow`)을 분리해 상태 전환을 안정화했습니다.

- **`NORMAL`**: 기본 상태입니다. 글쓰기, 문서화, 번역, 리서치, 코드 리뷰, 단순 코딩은 Google AI 모델로 즉시 보내며 복잡한 코딩과 아키텍처 설계만 호스트 Claude Code에서 처리합니다.
- **`CONSERVE_CLAUDE`**: 호스트 Claude 주간 사용률이 70%에 도달하면 진입하며 65% 아래로 내려가야 해제됩니다. 이때부터 복잡한 코딩은 `claude-sonnet-5-5-high`와 `claude-opus-5-5-high`가, 아키텍처 설계는 `claude-opus-5-5-high`와 `gemini-4-argon-high`가 1·2순위로 먼저 처리합니다.
- **`OVERFLOW_TO_AGY`**: 호스트 Claude 주간 사용률이 90%에 도달하면 진입하며 82% 아래로 내려가야 해제됩니다. 원장에 최근 5시간 안의 `claude-code-native` 한도 소진(`QUOTA_EXHAUSTED`) 기록이 있어도 진입합니다. 여덟 가지 작업 유형 전부를 Antigravity와 Gemini CLI 모델로 우회시켜 호스트 세션이 주간 한도 차단벽에 부딪히지 않게 보호합니다.
- **`FALLBACK_GEMINI_CLI`**: Antigravity 풀(`agy-claude-pool` 또는 `agy-gemini-pool`) 사용률이 95%를 넘으면 진입하며 88% 아래로 떨어져야 해제됩니다. `agy`가 두 풀 모두 한도 소진을 보고한 지 5시간이 지나지 않았을 때도 진입합니다. 한 풀만 소진을 보고하면 상태는 그대로 두고 그 풀의 모델만 5시간 동안 후보에서 뺍니다. 경로 계획은 독립 실행형 `gemini-cli` 모델(`gemini-2.5-pro`, `gemini-2.5-flash`)을 앞에 두지만, claugle은 도구를 막을 수 없는 `gemini-cli`를 실행하지 않으므로 남은 `agy` 후보나 호스트 Claude Code가 작업을 맡습니다.

한도 소진 기록은 5시간이 지나면 상태 결정에서 빠집니다. 거버너는 마지막 상태를 `${CLAUDE_PLUGIN_DATA}/governor-state.json`에 원자적으로 저장하고 다음 호출에서 이어받으므로 훅, MCP 서버, CLI가 각각 다른 프로세스로 실행되어도 히스테리시스 구간이 유지됩니다.

## 제공 컴포넌트 상세

### 1. Stdio MCP 서버 도구 (`.mcp.json`)

서브에이전트 턴을 새로 열지 않아도 호스트 Claude가 즉석에서 부를 수 있도록 JSON-RPC 2.0 도구 네 개를 제공합니다.

- `claugle_write`: 릴리스 노트, README, 번역문, 커밋 메시지, 요약문 작성을 Gemini 모델로 위임합니다. `allowFileEdits: true`와 `allowedEditGlobs`를 함께 넘기면 격리된 워크트리에서 마크다운 파일을 직접 수정한 뒤 반영합니다.
- `claugle_review`: `claude-sonnet-5-5-high`, `claude-opus-5-5-high`, `gemini-4-argon-high`에 코드 리뷰와 보안 감사를 맡깁니다. 읽기 전용 실행이며, claugle 도구 게이트가 프로젝트 안의 `read_file`만 허용합니다.
- `claugle_run`: 코딩, 리서치, 아키텍처 작업을 32-셀 정책 행렬에 따라 라우팅합니다. `allowFileEdits: true`를 넘긴 경우에만 격리된 워크트리에서 파일을 수정하며, 생략하면 작업 유형과 상관없이 읽기 전용으로 실행합니다.
- `claugle_quota`: 4개 풀의 7일 누적 토큰, 소비 비율, 현재 `QuotaState`, 바이너리 헬스 및 서킷 브레이커 상태를 JSON으로 반환합니다.

`contextFiles`에는 `cwd` 안을 가리키는 상대 경로만 넣을 수 있습니다. 절대 경로나 `..`로 `cwd` 밖을 가리키는 경로는 요청 단계에서 거부합니다. `allowFileEdits`는 불리언, `allowedEditGlobs`는 배열이어야 하며 다른 형식이 오면 도구가 오류를 반환합니다.

### 2. 슬래시 커맨드 (`commands/*.md`)

- `/claugle:model [model] [low|medium|high]`: 활성 모델 패밀리(`argon`, `flash`, `agy-opus`, `agy-sonnet`, `gpt-oss`, `gemini-pro`, `gemini-flash`, `auto`)와 추론 강도(`low`, `medium`, `high`)를 즉시 변경하고 Claude Code 기본 `/model` 선택 창 구성을 동기화합니다.
- `/claugle:write [--model <slug>] [--allow-edits] [--glob <pattern>] <prompt>`: 문서 작성·번역·요약 작업을 Google AI Gemini 모델로 실행합니다.
- `/claugle:review [--model <slug>] [--effort <level>] [--context <file>] <prompt>`: 지정한 파일이나 변경사항을 대상으로 읽기 전용 코드 리뷰를 수행합니다.
- `/claugle:task [--model <slug>] [--effort <level>] [--kind <task-kind>] [--allow-edits] <prompt>`: 작업 종류나 모델·추론 강도를 직접 지정해 라우팅된 작업을 실행합니다.
- `/claugle:quota`: 현재 7일 롤링 사용량과 할당량 상태를 요약해 보여줍니다.
- `/claugle:explain [--model <slug>] [--effort <level>] [--kind <task-kind>] <prompt>`: 실제 모델을 호출하지 않고 프롬프트 분류 결과와 선택된 폴백 후보 체인, 제외된 후보 사유를 출력합니다.

플래그는 프롬프트 맨 앞에 두거나, 긴 이름(`--model` 등)이면 맨 뒤에 몰아 둘 수 있습니다. 문장 중간의 짧은 플래그(`git commit -m` 같은 표현)는 프롬프트 텍스트로 남습니다. 커맨드는 인자를 따옴표로 감싼 히어독으로 `claugle.mjs --args-stdin`에 넘기므로 프롬프트 안의 작은따옴표, 큰따옴표, `$`, 줄바꿈이 그대로 전달됩니다. 프롬프트에 `--json` 같은 플래그 이름이 들어 있다면 맨 앞의 플래그 바로 뒤에 `--`를 두세요. 그 뒤의 텍스트는 모두 프롬프트로 다룹니다. 문장 중간에 `--`가 있으면서 앞이나 뒤에 플래그 이름이 함께 있으면, 추측하지 않고 오류로 알려 줍니다.

### 3. 얇은 전달 서브에이전트 (`agents/*.md`)

모든 `agy` 실행은 claugle이 만든 PreToolUse 훅 게이트(`.agents/hooks.json`)를 거칩니다. 게이트는 허용 목록 방식입니다. 게이트웨이 실행은 응답 형식용 `finish`만, 읽기 전용 위임은 프로젝트 안의 파일 읽기 도구만, 편집 위임은 격리된 워크트리 안의 파일 읽기·쓰기 도구만 허용합니다. 도구가 넘기는 경로 인자는 모두 허용된 폴더 안을 가리켜야 합니다. `..`가 들어간 경로와 대상이 없는 심볼릭 링크는 거부합니다. `.git` 안은 읽을 수도 쓸 수도 없습니다. 하네스 설정인 `.claude`, `.agents`, `.gemini`, `.mcp.json`에는 쓸 수 없고, 하베스트도 이 경로의 변경을 glob과 상관없이 거부합니다. 워크트리 안에 중첩된 Git 저장소가 생기면 Git 명령을 실행하기 전에 반영을 거부합니다. 명령 실행, 예약(`schedule`), 메시지 전송, 네트워크, 브라우저, MCP, 하위 에이전트는 모두 거부합니다.

`agy`는 작업 폴더의 `.agents/hooks.json`에 든 SessionStart·Stop 같은 훅 명령도 실행하는데, 이 명령은 PreToolUse 게이트를 거치지 않습니다. `.agents` 아래의 MCP 서버 설정(`mcp_config.json`)과 플러그인, `.gemini/extensions`도 명령을 실행할 수 있습니다. 그래서 claugle은 `agy`가 실제로 쓸 작업 폴더(읽기 전용 위임은 프로젝트, 편집 위임은 워크트리)와 그 위 저장소 루트까지의 폴더에 이런 설정이 있으면 `agy`를 시작하지 않고 작업을 호스트 Claude Code로 넘깁니다. 요청한 모델 대신 다른 모델이 답한 위임 결과에는 그 사실을 응답 맨 앞에 적습니다.

호스트 Claude가 서브에이전트를 띄우기 전에 저장소 파일을 읽느라 토큰을 낭비하지 않도록 세 서브에이전트(`claugle:gemini-writer`, `claugle:agy-coder`, `claugle:agy-reviewer`)는 모두 `tools: Bash`만 가지며 `scripts/claugle.mjs`를 한 줄로 호출해 결과를 그대로 돌려줍니다.

### 4. 생명주기 훅 (`hooks/hooks.json`)

- `SessionStart`: 원장 및 워크트리 디렉토리를 준비하고 `CLAUDE_PLUGIN_DATA` 경로와 사용자가 설정한 주간 예산을 `CLAUDE_ENV_FILE`에 기록합니다. 그래서 슬래시 커맨드와 서브에이전트가 Bash로 실행한 CLI도 훅, MCP 서버와 같은 원장과 예산을 씁니다. 이어서 모든 이벤트가 14일을 넘긴 샤드 파일과 2시간 지난 방치 워크트리를 정리하고 현재 할당량 요약을 세션 컨텍스트에 주입합니다. `/model` 선택 창 설정 동기화와 로컬 게이트웨이 기동은 훅 입력의 `hook_event_name`이 `SessionStart`일 때만 실행합니다.
- `Stop`: 세션 트랜스크립트에서 새로 추가된 assistant 메시지의 토큰 사용량을 `claude-code-native` 풀에 기록합니다. 게이트웨이가 처리한 Google AI 모델 응답은 제외합니다. 5시간·주간 한도 오류(`usage_limit_reached`)는 `QUOTA_EXHAUSTED`로 기록해 `OVERFLOW_TO_AGY` 전환에 쓰고, 메시지 ID로 이벤트 ID를 만들어 같은 메시지를 두 번 기록하지 않습니다.
- `UserPromptSubmit`: 프롬프트가 들어오면 10ms 안에 정적 어휘 규칙으로 분류합니다. Google AI 모델에 적합한 작업이면 추천 MCP 도구와 서브에이전트 안내를 컨텍스트에 덧붙입니다.

### 5. 네이티브 `/model` 선택 창 연동과 로컬 게이트웨이 (`scripts/anthropic-gateway.mjs`)

Claude Code의 기본 `/model` 선택 창(`Alt+P`)에서 `agy` CLI처럼 위아래 방향키로 Gemini·Claude 모델 패밀리를 고르고 좌우 방향키(`←`/`→`)로 추론 강도(`Low`, `Medium`, `High`)를 조절할 수 있도록 `~/.claude/settings.json`의 `modelPicker`(`options` 및 `behavesAs`)와 `modelSettings`(`effortLevel`, `maxEffortLevel`)를 자동 구성합니다. 사용자가 `/model` 창이나 `/claugle:model`(`claugle model`)에서 선택한 `(model, output_config.effort)` 조합은 로컬 게이트웨이(`127.0.0.1:18789`)의 `resolveModelAndEffort`를 거쳐 정확한 `agy` 슬러그(`gemini-4-argon-low`, `gemini-4-argon-medium`, `gemini-4-argon-high` 등)로 실행됩니다.

게이트웨이는 요청의 모델 이름으로 경로를 정합니다.

- **Anthropic 모델 이름(`opus`, `sonnet`, `haiku`, `claude-*` 등).** 요청을 `api.anthropic.com`에 그대로 넘기고, 응답 스트림과 상태 코드도 그대로 돌려줍니다. 시간 제한이 없고 `agy`로 대신 답하지 않습니다. Claude Code가 백그라운드로 보내는 `haiku` 요청도 이 경로를 탑니다.
- **Google AI 모델.** Claude Code가 보낸 시스템 프롬프트 전문, 전체 대화, 전체 도구 JSON 스키마를 `agy --input-format stream-json`의 표준 입력으로 전달합니다. `agy`가 돌려준 도구 호출은 Claude Code가 실행하므로 Claude Code 훅이 그대로 적용됩니다. 이미지처럼 전달할 수 없는 블록은 생략했다는 표시를 프롬프트에 남깁니다.
- **실패와 안전장치.** 모든 후보가 실패하거나 빈 응답을 내면 Anthropic 형식의 오류를 `x-should-retry: false`와 함께 반환합니다. 한도 소진을 보고한 모델은 회로를 열어 바로 다시 부르지 않습니다. Claude Code가 연결을 끊으면 진행 중인 `agy`를 종료하고, 요청 하나에 쓰는 시간은 Claude Code의 스트림 유휴 제한(최소 300초)보다 짧은 280초 안으로 제한합니다. 사용자가 고정한 모델이 실패하면 다른 모델로 대신 답하지 않고 오류를 돌려줍니다. `claugle-auto`만 폴백 체인을 따릅니다. `gemini-cli`는 도구를 막을 수 없어 게이트웨이 후보에서 제외합니다.
- **로컬 요청 검사.** `Host`가 localhost가 아니거나 `Content-Type`이 `application/json`이 아닌 요청은 거부합니다. 브라우저의 교차 출처 요청과 DNS 리바인딩으로 `agy` 할당량을 쓰지 못하게 하기 위해서입니다.
- **데몬 갱신.** `/health`가 스크립트 내용 해시(`build`)를 알려 줍니다. SessionStart 훅이 다른 빌드의 데몬을 발견하면 종료시키고 현재 빌드로 다시 띄웁니다. 종료 경로가 없는 이전 빌드의 데몬은 같은 포트로 실행된 `claugle.mjs gateway` 프로세스를 찾아 신호로 종료합니다. 교체나 기동에 실패하면 훅이 `systemMessage`로 경고하고, settings에는 `CLAUGLE_GATEWAY_PORT`로 정한 포트를 씁니다.

claugle은 `agy`를 `${CLAUDE_PLUGIN_DATA}/agy-home`이라는 별도 홈에서 실행합니다. 이 홈은 실제 홈의 항목을 심볼릭 링크로 그대로 비추지만, `~/.gemini/config` 아래의 전역 플러그인, MCP 서버 설정, 훅, 플러그인 등록 파일은 넣지 않습니다. 그래서 사용자의 전역 `agy` 설정을 바꾸지 않으면서도, claugle이 부른 `agy`에는 Claude Code 하네스 외의 지침과 명령이 끼어들지 않습니다. 플러그인이 시스템 프롬프트에 더하던 토큰도 호출마다 빠집니다. 게이트웨이는 이미지와 PDF 블록을 `agy`에 전달하지 못하고, 생략했다는 표시만 남깁니다.

비용 구조도 경로마다 다릅니다. 실측 기준으로, 게이트웨이를 통해 Gemini를 메인 모델로 쓰면 도구를 한 번 부를 때마다 Claude Code의 시스템 프롬프트, 도구 스키마, 문맥을 다시 보내므로 `agy` 실행 한 번에 약 2만 4천 토큰이 듭니다. Bash를 네 번 부르는 작업이 입력 157910토큰, 152초였습니다. 반면 위임(`claugle_run` 등)은 `agy`를 한 번 실행하고 그 안에서 파일을 읽으므로, 파일 네 개를 읽고 답하는 작업이 입력 23432토큰, 14초였습니다. 그래서 도구를 여러 번 쓰는 작업은 Claude를 메인 모델로 두고, 긴 읽기와 긴 쓰기는 위임으로 Gemini에 맡기는 편이 쌉니다. Claude Code 대화 하나를 `agy` 대화 하나로 이어 쓰는 방식도 시험했지만, `agy`가 이어 쓴 대화의 기록을 매 턴 크게 다시 처리해 토큰이 몇 배로 늘어서 채택하지 않았습니다.

설정 동기화는 해석할 수 없는 `settings.json`을 덮어쓰지 않으며, 사용자가 고르지 않은 모델을 기본값으로 써 넣지 않습니다. `ANTHROPIC_BASE_URL`이 응답하지 않거나 claugle 게이트웨이를 가리키는 로컬 주소면 현재 포트로 바꾸고, 다른 프록시를 가리키면 그대로 둡니다. 쓰기에 실패해도 훅은 멈추지 않고 경고만 남깁니다.
