# PXM 아키텍처

**개요**
PXM은 pnpm 모노레포로 구성된 BPM 스타일 워크플로우 플랫폼입니다. React 기반 Flow Designer UI, NestJS API, Rust 실행 엔진의 3개 런타임으로 구성되며, Postgres 기반 outbox 이벤트를 통해 실행 상태를 공유합니다.

**레포지토리 구조**
- `apps/web`: Vite + React UI (플로우 디자인, 실행 트레이스, 인박스)
- `apps/api`: NestJS API (템플릿, 인스턴스, 태스크, SSE)
- `apps/engine`: Rust 워크플로우 실행 엔진 (job polling, retry, timer, gateway, approval)
- `packages/contracts`: 공통 이벤트 타입 정의
- `infra`: Postgres 스키마 마이그레이션 및 Docker Compose

**시스템 컨텍스트**
- 디자이너가 Web UI에서 워크플로우 템플릿을 설계/저장한다.
- API가 템플릿/인스턴스를 저장하고 outbox 이벤트를 기록한다.
- 엔진이 DB의 jobs를 소비해 워크플로우 상태를 전진시키고 outbox 이벤트를 생성한다.
- Web UI가 SSE로 이벤트를 수신해 실시간 실행 상태를 반영한다.

**컴포넌트 아키텍처**
- Web UI (`apps/web`): React Flow로 노드 그래프를 설계하고 저장한다. SSE를 통해 노드 상태를 시각화한다. Inbox UI는 승인 태스크를 조회하고 승인/반려를 요청한다.
- API (`apps/api`): `TemplatesController`가 `workflow_template` CRUD를 제공하고 `POST /templates/:id/execute`로 인스턴스를 시작한다. `InstancesController`는 목록/상세를 제공하고 `event_outbox`를 SSE로 스트리밍한다. `TasksController`는 태스크 목록/완료를 제공하고 RESUME job을 큐에 넣는다. `OutboxService`는 `event_outbox`를 커서 기반으로 폴링한다. `DbModule`은 `PG_POOL`을 공유한다.
- Engine (`apps/engine`): `engine_jobs`를 SKIP LOCKED로 폴링하고 RUNNING으로 마킹한다. start, service, timer, gateway, approval, end 노드를 실행한다. 노드 이벤트와 인스턴스 상태를 outbox로 기록한다. service 노드에 지수 백오프 + 지터 기반 재시도 정책을 사용한다. TIMER job을 예약하고 인스턴스를 WAITING으로 전환한다.
- Database (Postgres): 인스턴스, 작업, outbox, 태스크, 템플릿의 단일 소스 오브 트루스.

**데이터 모델**
- `process_instance`: `id`, `template_id`, `status`, `ctx`, `lock_owner`, `lock_until`, `heartbeat_at`, timestamps. `ctx`는 그래프, cursor, formData를 포함한다.
- `engine_jobs`: `id`, `instance_id`, `type`, `run_at`, `attempt`, `status`, `payload`, timestamps.
- `event_outbox`: `id`, `instance_id`, `type`, `payload`, `created_at`.
- `tasks`: `id`, `instance_id`, `node_id`, `assignee`, `status`, `payload`, timestamps.
- `workflow_template`: `id`, `name`, `description`, `nodes`, `edges`, `version`, `is_active`, metadata.

**주요 런타임 플로우**
1. 템플릿 CRUD
2. Web UI가 `POST /api/templates`, `GET /api/templates`로 템플릿을 저장/조회한다.
3. 템플릿 실행
4. Web UI가 `POST /api/templates/:id/execute`로 실행을 요청하고 필요 시 `formData`를 전달한다.
5. API가 `process_instance`를 만들고 START job을 생성한 뒤 `INSTANCE_CREATED` outbox 이벤트를 기록한다.
6. Engine이 START/RESUME job을 실행하고 인스턴스 상태를 업데이트하며 노드 이벤트를 기록한다.
7. Web UI가 `/api/instances/:id/stream` SSE로 이벤트를 수신해 캔버스를 실시간 갱신한다.
8. 승인 태스크
9. Engine이 `tasks` 레코드를 만들고 `TASK_CREATED`를 기록한 뒤 인스턴스를 WAITING으로 전환한다.
10. Inbox UI가 `POST /api/tasks/:id/complete`로 승인/반려를 보내면 API가 RESUME job을 생성한다.

**API 표면**
- `GET /api/health`: 헬스 체크
- `GET /api/templates`: 템플릿 목록 (`activeOnly` 지원)
- `POST /api/templates`: 템플릿 생성
- `GET /api/templates/:id`: 템플릿 단건 조회
- `PUT /api/templates/:id`: 템플릿 업데이트
- `DELETE /api/templates/:id`: 템플릿 소프트 삭제
- `POST /api/templates/:id/execute`: 인스턴스 생성 + START job
- `GET /api/instances`: 최근 인스턴스 목록
- `GET /api/instances/:id`: 인스턴스 상세
- `GET /api/instances/:id/stream`: outbox SSE 스트림
- `GET /api/tasks`: assignee 기준 태스크 목록
- `POST /api/tasks/:id/complete`: 승인/반려 처리 및 RESUME job 생성

**운영 메모**
- Postgres는 `infra/docker-compose.yml`로 실행하며, 스키마는 `infra/db/migrations`에서 관리한다.
- Engine 환경변수: `DATABASE_URL`, `ENGINE_WORKER_ID`, `ENGINE_POLL_MS`, retry/timer 관련 env.
- API 환경변수: `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`.

**알려진 이슈 및 갭**
- `infra/seed/010_outbox_seed.sql`의 `event_type` 컬럼은 스키마의 `type`과 불일치하며, `process_instance`에 필수인 `template_id`가 누락됨.
- `apps/web/src/outbox/useInstanceStream.ts`는 SSE 경로가 `/api` 없이 `/instances/:id/stream`으로 호출됨.
- `apps/api/src/sse/sse.controller.ts`는 모듈에 등록되지 않아 비활성 상태.
