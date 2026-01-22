# PXM MVP Roadmap (DB truth + Outbox + SSE)

## A. Engine / Runtime (Core, Must)
- [x] Bootstrap
- [x] Outbox → SSE
- [x] Instance → Job → Worker loop
- [ ] Token execution (Start/Service/Gateway)
- [x] Lock / Lease / Heartbeat
- [ ] Retry / Timer
- [ ] Engine crash recovery

## B. Identity / Access (Product Essential)
- [ ] Tenant / Org / User 모델
- [ ] Auth (local / SSO)
- [ ] Role / Permission (RBAC)
- [ ] Approval assignee rule
- [ ] Delegate / Proxy approval
- [ ] Audit log (who did what)

## C. Workflow Product (User-facing)
- [ ] Flow Designer (nodes / edges)
- [ ] Template versioning
- [ ] Instance Inbox
- [ ] Runtime Trace UI
- [ ] Notification (mail/webhook)

## D. Ops / Platform
- [ ] Migration/version policy
- [ ] Observability (metrics/logs)
- [ ] Backfill / Repair tool
- [ ] Admin UI

### 세부 TODO 
## 0. Bootstrap ✅
- [x] Monorepo (pnpm workspace) 구성
- [x] apps/api (Nest) health
- [x] apps/api SSE hello/ping
- [x] apps/web (Vite) 부팅
- [x] apps/engine (Rust) 부팅
- [x] infra Postgres + init schema

## 1. Real Outbox → SSE (핵심 슬라이스)
- [x] DB: event_outbox insert 테스트용 SQL/seed 추가
- [x] API: Postgres 연결(PG pool) + outbox polling
- [x] API: /instances/:id/stream 에서 outbox 이벤트를 SSE로 스트리밍 (Last-Event-ID 지원)
- [x] WEB: SSE 연결해서 이벤트 로그 콘솔/패널에 출력

## 2. Instance create → engine_jobs (시작 트리거)
- [x] API: POST /instances (instance row + engine_jobs START)
- [x] ENGINE: engine_jobs SKIP LOCKED fetch
- [x] ENGINE: instance status RUNNING + outbox INSTANCE_RUNNING 기록

## 3. Runtime trace (와 포인트)
- [ ] WEB: 간단 그래프(노드 5개) 렌더
- [ ] WEB: NODE_STARTED/NODE_COMPLETED 이벤트로 하이라이트/edge 애니메이션

## 4. Lock / Lease / Retry (운영급 심장)
- [ ] ENGINE: advisory lock + lease + heartbeat
- [ ] ENGINE: retry policy (exp backoff + jitter) + RETRY_SCHEDULED outbox


프로젝트: pxm (pnpm 모노레포)
구성: apps/api(Nest) + apps/web(Vite React) + apps/engine(Rust) + packages/contracts + infra(Postgres)
현재 상태: /health OK, /instances/TEST/stream SSE ping OK, web 5173 OK, engine tick OK
DB: infra/docker-compose + 001_init.sql 적용됨(process_instance, engine_jobs, event_outbox, tasks)
다음 목표: event_outbox → Nest SSE 스트리밍(폴링 + Last-Event-ID) 연결

## TODO의 축
🧠 Axis 1. Engine / Runtime (지금 하고 있는 것)

pxm이 BPM 엔진으로서 신뢰 가능한가?

DB truth

Token 이동

Retry / Timer

Lock / Lease

Runtime Trace

➡️ 엔진 완성도

🔐 Axis 2. Identity / Access (사용자 관리)

누가 무엇을 할 수 있는가?

사용자 / 조직 / 테넌트

Role / Permission

Approval Assignee

대리 승인 / 위임

외부 IdP 연동

➡️ 실제 회사에서 쓸 수 있나?

🎨 Axis 3. Product / UX

이걸 쓰고 싶나?

Flow Designer

Runtime Trace 시각화

Inbox

알림

템플릿 갤러리

➡️ “오 이거 쓰고 싶다” 포인트