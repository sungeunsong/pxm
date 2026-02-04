# PXM Design

**Goals**
- 비개발자가 워크플로우를 시각적으로 설계하고 실행할 수 있게 한다.
- 실행 상태를 실시간으로 관찰할 수 있게 한다.
- DB를 단일 소스로 두고, outbox 기반으로 일관된 이벤트 스트림을 제공한다.
- 서비스 호출, 타이머, 승인 등 실무 프로세스에 필요한 노드를 제공한다.

**Non-Goals (현재 범위 밖)**
- 사용자, 조직, 권한, SSO 같은 아이덴티티 기능.
- 멀티 테넌시와 감사 로그.
- 운영 관점의 완전한 복구 및 관측성 도구.

**Core Concepts**
- Template: React Flow 노드와 엣지로 구성된 워크플로우 설계 데이터.
- Instance: 템플릿을 실행한 결과의 상태와 컨텍스트.
- Job: 엔진이 실행해야 할 단위 작업, START, RESUME, TIMER, RETRY.
- Outbox Event: 실행 상태를 외부로 전달하는 이벤트 스트림.
- Task: Approval 노드에서 생성되는 승인 업무.

**User Experience**
- Flow Designer: 좌측 노드 팔레트, 중앙 캔버스, 우측 속성 패널의 3컬럼 구성. 드래그 앤 드롭으로 노드를 배치하고 엣지를 연결. 노드 속성 패널에서 타입별 설정.
- Execution: 실행 시 Start 노드의 폼 스키마가 있으면 입력 폼을 표시. 실행 중 이벤트를 SSE로 받아 캔버스와 타임라인에 반영.
- Inbox: 승인 대기 작업을 폴링으로 조회하고 승인 또는 반려 처리.

**Workflow Node Semantics**
- Start: 즉시 완료되고 다음 노드로 이동. Start 노드에 정의된 formSchema는 실행 시 입력 폼으로 표시되고 ctx.formData로 저장.
- Service: HTTP 호출 수행. 성공 시 NODE_COMPLETED, 실패 시 RetryPolicy에 따라 재시도 또는 실패.
- Timer: TIMER job을 예약하고 인스턴스를 WAITING으로 전환. TIMER job 실행 시 다음 노드로 진행.
- Gateway: 조건식을 평가하고 true 또는 false 경로로 분기.
- Approval: Task를 생성하고 인스턴스를 WAITING으로 전환. 승인 또는 반려 시 RESUME job으로 재개.
- End: 현재 구현에서는 다음 노드가 없을 경우 자연 종료.

**Execution Model**
1. API가 `process_instance`와 START job을 생성한다.
2. Engine이 READY job을 SKIP LOCKED로 가져와 RUNNING으로 마킹한다.
3. 엔진은 ctx.cursor 기준으로 현재 노드를 찾아 타입별 처리한다.
4. 처리 결과를 outbox 이벤트로 기록한다.
5. 다음 노드가 있으면 cursor를 업데이트하고 RESUME job을 생성한다.

**Job 라이프사이클 (상세)** 
1. API가 `POST /api/templates/:id/execute`에서 `process_instance`를 생성하고 `engine_jobs`에 `START`(READY)을 추가한다.
2. 엔진은 폴링 루프에서 `engine_jobs` 중 `status='READY' AND run_at <= now()` 조건을 만족하는 job 1개를 `FOR UPDATE SKIP LOCKED`로 가져온다.
3. 가져온 job을 즉시 `RUNNING`으로 마킹한 뒤, 타입이 `START | RETRY | RESUME`이면 동일 실행 루트(`run_instance_job`)로 진입한다.
4. `process_instance.ctx`에서 `cursor`, `nodes`, `edges`, `formData`를 읽고 현재 노드를 결정한다.
5. 노드 타입별 실행 로직을 수행하고 outbox 이벤트를 기록한다.
6. 다음 노드가 있으면 `cursor`를 해당 노드로 갱신하고, 이어서 실행될 `RESUME` job을 `engine_jobs`에 `READY`로 추가한다.
7. 현재 job은 `DONE`으로 마킹되고 루프가 이어지며, 다음 폴링에서 방금 생성된 `RESUME` job을 집어 다음 노드를 실행한다.
8. `service` 실패 시 재시도 정책에 따라 `RETRY` job을 미래 시점(`run_at`)으로 예약하고 현재 job은 `DONE` 처리한다.
9. `timer` 노드는 `TIMER` job을 미래 시점(`run_at`)으로 예약하고 인스턴스를 `WAITING`으로 전환한다. 만료 시 `TIMER` job이 실행되어 다음 `RESUME` job을 만든다.
10. `approval` 노드는 `tasks`를 생성하고 인스턴스를 `WAITING`으로 전환한다. API가 승인/반려 처리 시 `RESUME` job을 추가하여 재개한다.
11. `end` 노드는 인스턴스를 `COMPLETED`로 전환하고 현재 job을 `DONE` 처리한다.
12. 정리하면 실행 트리거는 `process_instance` 상태가 아니라 `engine_jobs`의 READY job이며, `cursor`는 “다음에 실행될 노드”를 가리키는 컨텍스트 역할을 한다.

**Event Stream Design**
- 이벤트는 `event_outbox`에 기록되고 API에서 SSE로 전달된다.
- 클라이언트는 `Last-Event-ID`를 이용해 재연결 시 커서를 유지한다.
- 주요 이벤트 타입은 `packages/contracts/src/events.ts`에 정의되어 있다.

**Retry Policy**
- 기본 정책은 지수 백오프와 지터를 포함한다.
- 환경변수로 max attempts, initial delay, max delay, multiplier를 조정한다.

**Form Schema Design**
- Start 노드에 `FormSchema`를 저장한다.
- 필드 타입은 text, textarea, number, select, checkbox, radio, date로 구성한다.
- 클라이언트에서 유효성 검사를 수행하고 formData를 API로 전달한다.

**API Contracts (요약)**
- Template CRUD와 실행 API.
- Instance 조회와 SSE 스트림 API.
- Task 조회와 완료 API.

**Persistence Design**
- `process_instance.ctx`는 cursor, nodes, edges, formData를 포함한다.
- 실행 상태 변경과 노드 이벤트는 outbox로 기록된다.
- Approval은 tasks 테이블로 외부 사람이 수행할 작업을 표현한다.

**Scalability And Concurrency**
- Engine은 SKIP LOCKED로 다중 워커 확장을 전제한다.
- instance 기반 lock, lease, heartbeat 구조가 준비되어 있다.

**Security**
- 현재는 인증과 권한이 없고, 로컬 환경을 가정한다.
- 향후 RBAC와 승인자 할당 로직이 필요하다.

**Observability**
- outbox 이벤트와 엔진 로그가 기본 관찰 수단이다.
- 별도의 metrics, tracing은 현재 미구현이다.

**Open Issues And Next Steps**
- Seed SQL과 실제 스키마 컬럼 불일치 수정.
- SSE 경로 정합성 점검.
- Crash recovery와 Cleanup worker 추가.
- 승인 UX에서 formData 요약 표시 강화.
