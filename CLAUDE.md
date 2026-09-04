# PXM Project Context

## 프로젝트 개요

PXM은 DB를 단일 진실 원본으로 사용하는 BPM/Workflow 실행 엔진이다.
워크플로우를 그래프로 설계하고 토큰 기반으로 실행하며, 사람의 승인(결재)과 외부 시스템 연동을
같은 그래프 안에서 처리한다.

- **API (NestJS)**: REST + SSE, 결재 처리, 트리거, 운영 API
- **Engine (Rust)**: Job 획득, 토큰 전이, 노드 실행, 재시도, 타이머
- **Web (React/Vite)**: 설계·운영 콘솔 및 결재 화면
- **DB**: MongoDB 우선. PostgreSQL 어댑터도 있으며 어댑터로 분리되어 있다

**지원 기능의 기준 문서는 `docs/features.md`다.** 기능 유무를 판단할 때 이 파일이나 코드 주석이
아니라 그 문서를 본다. 기능을 추가·제거하면 같은 커밋에서 갱신한다.

## 디렉토리 구조

```
apps/
  api/            # NestJS - REST API + SSE (개발 포트 3011)
  engine/         # Rust - 워크플로우 실행 워커
  web/            # React/Vite - 콘솔 (개발 포트 5174)
  plugin-host/    # hosted 플러그인 실행기
  api-playground/ # 외부 소비자 관점 reference client (5175)
  e2e/            # Playwright 브라우저 회귀
packages/
  contracts/      # 공유 타입
infra/
  db/migrations/  # PostgreSQL 스키마
  production/     # 운영 배포 구성
docs/             # 문서. docs/README.md가 인덱스
docs/old/         # 보관 문서. 현재 상태 확인에 참고하지 않는다
```

## 실행 흐름

```
1. API → process_instance 생성 + engine_jobs(START) 생성
2. Engine → SKIP LOCKED로 job 획득
3. Engine → advisory lock + lease로 인스턴스 점유
4. Engine → 토큰을 따라 노드 실행 (start → gateway → approval/service/script/command/timer → end)
5. 각 상태 변화 → outbox에 append
6. API → outbox polling → SSE로 브라우저에 전달, Webhook Dispatcher가 외부로 전달
```

승인이 필요한 노드는 Task를 만들고 인스턴스가 `WAITING`이 된다. 승인·반려 처리 시 API가
`RESUME` job을 등록하고 Engine이 이어서 실행한다.

## 핵심 개념

| 개념 | 설명 |
|---|---|
| Token | 실행 위치. 병렬 게이트웨이에서 분기되고 조인에서 합쳐진다 |
| Instance context | `data.formData`(요청 입력) + `data.outputs`(노드 산출). 노드는 `outputPath`로 기록한다 |
| Outbox | append-only 이벤트 로그. SSE와 Webhook의 원천 |
| Lock / Lease | advisory lock + lease + heartbeat로 다중 워커 중복 실행 방지 |
| 배포 수명주기 | `DRAFT → PUBLISHED → DISABLED`. 외부 실행은 배포 버전에 고정된다 |

## 주요 파일 위치

### API (NestJS)

- `apps/api/src/instances/` — 인스턴스 생성·조회·제어, SSE
- `apps/api/src/templates/` — 워크플로우 정의, 배포 수명주기, 스케줄/DB Watch 토글
- `apps/api/src/tasks/` — 결재 Task, 외부 이메일 승인
- `apps/api/src/authz/` — 세션 인증, API Key, 접근 제어
- `apps/api/src/operations/` — 운영 상태 진단과 복구
- `apps/api/src/webhooks/` — 결과 Webhook 전달과 재시도
- `apps/api/src/openapi/` — 공개 API 문서 생성 (`/api/docs`)
- `apps/api/src/db/adapters/` — MongoDB / PostgreSQL 어댑터

### Engine (Rust)

- `apps/engine/src/v2/runtime.rs` — 노드 실행 전체. 노드 디스패치는 `match node.node_type`
- `apps/engine/src/v2/plugin_executor.rs` — 플러그인 실행 (builtin / hosted / external_http)
- `apps/engine/src/v2/infrastructure/` — DB 어댑터

## 개발 실행

```bash
pnpm db:mongo && pnpm db:mongo:init
pnpm dev:api:mongo      # http://localhost:3011/api
pnpm dev:engine:mongo
pnpm dev:web            # http://localhost:5174
pnpm dev:api-playground # http://localhost:5175
```

개발 기본 계정은 `admin` / `admin1234` (`PXM_BOOTSTRAP_ADMIN_PASSWORD` 미설정 시).
운영 배포에서는 반드시 교체한다.

## 검증

```bash
pnpm gate:beta        # API·Web 빌드 + Engine 단위 테스트 + 브라우저 E2E
pnpm gate:operations  # 운영 설정·compose 검증 + 복구 리허설
pnpm gate:release     # 위 둘 전부
```

`openapi.json`은 빌드 산출물이다. 공개 API의 DTO나 라우트를 바꾸면
`pnpm --filter api build`로 재생성해야 API 테스트가 통과한다.

## 문서

- `docs/README.md` — 문서 인덱스
- `docs/features.md` — 지원 / 미지원 기능 (기능 질문의 기준)
- `docs/roadmap.md` — 남은 작업과 현재 전제
- `docs/public-api-v1.md` — 외부 공개 API 계약
