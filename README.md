# claugle — Claude Code용 Google AI 구독 할당량 라우터 및 주간 한도 거버너

> **English**: [`README.en.md`](README.en.md)

Claude Code를 주력 개발 도구로 쓰다 보면 릴리스 노트 작성이나 문서 번역, 일상적인 PR 코드 리뷰 같은 보조 작업이 주간 토큰 한도를 빠르게 갉아먹습니다. 정작 까다로운 아키텍처 설계나 다중 파일 디버깅에 들어가면 할당량이 바닥나곤 합니다. 반대로 Google AI 구독에 포함된 Antigravity CLI(`agy`)와 Gemini CLI(`gemini`)에는 Gemini 4 Argon, Gemini 3.8 Flash, Claude Opus 5.5, Claude Sonnet 5.5의 주간 할당량이 넉넉히 들어 있는데도 개발 흐름이 끊긴다는 이유로 방치되곤 합니다. `claugle`은 이 두 구독 풀을 Claude Code 하네스 안에서 하나로 묶어 작업 성격과 잔여 한도에 맞춰 모델과 추론 강도를 자동 배정합니다.

비공개 OAuth 토큰을 뽑아내거나 내부 RPC를 가로채지 않고 공식 CLI만 호출합니다. 공식 문서에 명시된 헤드리스 CLI 계약(`agy --input-format stream-json --output-format stream-json --disable-slash-commands`로 프롬프트를 stdin에 전달하는 방식과 `gemini -p --output-format json`)과 Claude Code 플러그인 표준 경계(`.mcp.json`, `hooks/hooks.json`, `agents/*.md`, `commands/*.md`, `skills/*/SKILL.md`)만 조합했기 때문에 업스트림 CLI 버전이 올라가도 깨지지 않습니다.

## 설치

Claude Code 대화창이나 터미널에서 GitHub 저장소 주소 한 줄만 등록하면 바로 설치됩니다. 모든 런타임 스크립트를 Node.js(`>=18.18`) 내장 모듈만으로 작성했으므로 별도의 `npm install`이나 빌드 과정은 전혀 필요하지 않습니다.

```bash
claude plugin marketplace add https://github.com/hs1662/claugle.git
claude plugin install claugle@claugle
```

한 줄 명령으로 마켓플레이스 등록과 설치를 동시에 끝낼 수도 있습니다.

```bash
claude plugin install claugle --marketplace https://github.com/hs1662/claugle.git
```

## 왜 claugle인가

평소에는 호스트 Claude Code의 주간 토큰을 아껴 두고 한도가 차오르면 작업 흐름을 멈추지 않은 채 Google AI 구독 모델로 무게중심을 옮깁니다.

1. **작업별 특화 분담**: 주간 한도가 여유로운 `NORMAL` 상태에서도 초안 집필(`writing`), 문서 갱신(`docs`), 다국어 번역(`translation`), 코드베이스 조사(`research`), 읽기 전용 코드 리뷰(`review`), 단순 수정(`coding-trivial`)은 Google AI의 `gemini-4-argon-high`, `gemini-3.8-flash-high`, `claude-sonnet-5-5-high`가 먼저 맡습니다. 호스트 Claude Code는 복잡한 구현(`coding-complex`)과 아키텍처 설계(`architecture`)에만 집중합니다.
2. **4단계 히스테리시스 주간 한도 거버너**: 7일 롤링 윈도우 사용량을 추적해 `NORMAL` → `CONSERVE_CLAUDE`(호스트 한도 70% 진입, 65% 미만 복귀) → `OVERFLOW_TO_AGY`(90% 진입, 82% 미만 복귀) → `FALLBACK_GEMINI_CLI`(Antigravity 풀 95% 진입, 88% 미만 복귀) 네 단계로 전환합니다. 진입선과 복귀선에 간격을 두었기 때문에 경계선 근처에서 라우팅 경로가 매 요청마다 흔들리지 않습니다. 원장에 최근 5시간 안의 한도 소진(`QUOTA_EXHAUSTED`) 기록이 있으면 사용률과 상관없이 바로 전환합니다. `claude-code-native` 기록이면 `OVERFLOW_TO_AGY`로, Antigravity 풀 기록이면 `FALLBACK_GEMINI_CLI`로 옮기며 5시간이 지나면 이 신호는 사라집니다. 마지막 상태는 `${CLAUDE_PLUGIN_DATA}/governor-state.json`에 저장하므로 다음 프로세스도 같은 히스테리시스 구간을 이어받습니다.
3. **32-셀 결정적 정책 행렬**: 4개 할당량 상태와 8개 작업 유형을 조합한 32개 모든 칸에 1순위부터 3순위까지의 폴백 체인이 배열로 들어 있습니다. 1순위 모델이 429 한도 초과(`QUOTA_EXHAUSTED`)를 반환하거나 서킷 브레이커가 열려 있으면 즉시 다음 후보로 넘어갑니다.
4. **격리된 Git 워크트리 샌드박스**: 외부 `agy` 프로세스에 파일 수정을 맡길 때는 호스트 작업 트리를 건드리지 않고 `${CLAUDE_PLUGIN_DATA}/worktrees/<taskId>`에 분리된 워크트리를 만듭니다. 작업이 끝나면 허용된 글로브 패턴(`allowedEditGlobs`) 안의 파일만 바꿨는지 검사한 뒤 `git apply`로 작업 트리에만 반영하고 호스트의 인덱스(스테이징 영역)는 건드리지 않습니다. 워크트리 안에 중첩된 Git 저장소가 생기거나 하네스 설정(`.claude`, `.gemini`, `.mcp.json`, `agy` 설정 폴더 `.agents`·`.agent`·`_agents`·`_agent`, 지시 파일 `CLAUDE.md`·`CLAUDE.local.md`·`AGENTS.md`·`GEMINI.md`와 그 링크 대상, `CLAUDE.md`가 `@`로 가져오는 파일)이 바뀌면 반영을 거부합니다. 만약 작업 중인 파일과 충돌하면 호스트 트리를 더럽히지 않고 `claugle/task-<id>` 브랜치에 커밋을 보존합니다.
5. **무잠금 샤드 원장**: 여러 서브에이전트가 동시에 돌아도 락 경합이 생기지 않도록 프로세스마다 `shard-<sessionId>-<pid>.jsonl` 파일에 사용량 이벤트를 추가하고 읽을 때만 병합합니다. 세션 시작 시 모든 이벤트가 14일을 넘긴 샤드와 2시간 이상 멈춰 있던 워크트리를 자동으로 정리합니다. 다른 프로세스가 아직 쓰고 있을 수 있으므로 샤드를 다시 쓰지는 않습니다.

## 주요 진입점

작업 방식에 맞춰 세 가지 경로 중 편한 쪽을 골라 쓸 수 있습니다.

| 호출 경로 | 이름 | 용도 |
|---|---|---|
| **Stdio MCP 도구** | `claugle_write` · `claugle_review` · `claugle_run` · `claugle_quota` | 서브에이전트 생성 오버헤드 없이 Claude가 직접 JSON-RPC 2.0으로 Google AI 모델을 호출 |
| **슬래시 커맨드** | `/claugle:model` · `/claugle:write` · `/claugle:review` · `/claugle:task` · `/claugle:quota` · `/claugle:explain` | 모델·추론 강도 선택 및 특정 작업 위임, 라우팅 계획과 7일 사용량 조회 |
| **전달 서브에이전트** | `claugle:gemini-writer` · `claugle:agy-coder` · `claugle:agy-reviewer` | 호스트 세션이 저장소 파일을 미리 읽으며 토큰을 쓰지 않도록 `Bash` 한 줄로 작업을 즉시 전달 |
| **네이티브 `/model` 선택기 및 게이트웨이** | `/model` (`Alt+P`) · `claugle model` · `claugle gateway --daemon` | Claude Code 기본 `/model` 창에서 `agy` CLI처럼 Gemini·Claude 모델과 추론 강도(`Low`/`Medium`/`High`, 좌우 방향키)를 직접 고르고 호스트 5시간 한도 소진 시에도 구동 |

## 저장소 구조 및 검증

- [`plugins/claugle/`](plugins/claugle/README.md): 플러그인 매니페스트, 32-셀 정책 엔진, 무잠금 원장, 워크트리 샌드박스, MCP 서버, 훅, 서브에이전트, 슬래시 커맨드 본체
- [`docs/architecture.md`](docs/architecture.md): 도메인 데이터 구조, 3개 설계 후보 교차 심판 및 합성 근거, 트레이드오프 기록
- [`plugins/claugle/types/sketch.d.ts`](plugins/claugle/types/sketch.d.ts): 전체 모듈이 공유하는 TypeScript 도메인 타입 계약
- [`tests/claugle.test.mjs`](tests/claugle.test.mjs): 정책 행렬, 히스테리시스 거버너, 원장 병합, 워크트리 격리, 실시간 MCP 서버를 검증하는 테스트 스위트

로컬에서 테스트와 Claude Code 공식 플러그인 검증기를 실행하려면 아래 명령을 사용합니다.

```bash
npm test
npm run validate
```
