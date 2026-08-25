# Workflow API Contract

Phase 1 기준의 외부 연동용 workflow 실행 계약이다.

## Workflow Deployment Lifecycle

워크플로우 저장과 외부 공개는 분리한다.

- `DRAFT`: 새 워크플로우 또는 아직 배포하지 않은 변경본이다. 관리자 화면의 미리보기용 `POST /execute`만 허용한다.
- `PUBLISHED`: `active_published_version`이 가리키는 불변 버전만 외부 `POST /start`, API key, Schedule, DB Watch, Workflow Call에서 실행한다.
- `DISABLED`: 마지막 배포 버전 포인터는 보존하지만 신규 외부 실행과 자동 트리거를 차단한다. 이미 시작한 instance는 시작 당시 저장한 버전과 그래프를 계속 사용한다.

관리자용 상태 변경 API는 다음과 같다.

### Instance 일시중지/재개

```http
POST /instances/{instance_id}/pause
Idempotency-Key: <caller-generated-key>
```

```http
POST /instances/{instance_id}/resume
Idempotency-Key: <caller-generated-key>
```

응답:

```json
{
  "success": true,
  "instance_id": "uuid",
  "paused": true,
  "runtime_state": "RUNNING",
  "changed": true,
  "affected_instance_ids": ["uuid"],
  "idempotent_replay": false
}
```

`paused`는 Engine 신규 job claim을 제어하는 별도 상태이며 `runtime_state`를 변경하지 않는다.
이미 실행 중인 job은 현재 트랜잭션을 마친 뒤 멈추고, 이후 `QUEUED` job은 resume 전까지 선점되지 않는다.
동일한 pause/resume 상태를 다시 요청하면 `changed=false`인 성공 응답을 반환한다.
Workflow Call 부모 instance를 대상으로 하면 활성 자식에게도 전파되며 `affected_instance_ids`에 실제 변경된 instance가 반환된다.
`COMPLETED`, `FAILED`, `TERMINATED` instance는 `409 Conflict`를 반환한다.

대기 상태별 정책:

- Approval: 일시중지 중에도 승인·반려 요청은 정상 저장한다. 이때 생성된 `RESUME` job은 `QUEUED`로 유지되고 instance 재개 후 처리된다.
- Timer: 일시중지 중 timer 만료 시각이 지나도 `TIMER` job은 `QUEUED`로 유지된다. 남은 시간을 다시 계산하지 않고 instance 재개 직후 만료 job을 처리한다.
- Workflow Call: 부모가 일시중지한 활성 자식에게 pause를 전파하고, 부모 재개 시 동일한 `pause_origin_instance_id`를 가진 자식만 재개한다.

- `POST /api/templates/:template_id/deploy`: 현재 저장 버전을 배포한다.
- `POST /api/templates/:template_id/disable`: 신규 실행을 중지한다.
- `POST /api/templates/:template_id/reactivate`: 마지막 배포 버전을 다시 활성화한다.
- `POST /api/templates/:template_id/versions/:version/rollback`: 선택한 버전을 새 Draft로 복원한다. 운영 반영에는 별도 deploy가 필요하다.

기존 데이터 중 lifecycle metadata가 없는 워크플로우는 호환성을 위해 현재 버전을 배포본으로 간주한다.

## Start Workflow

`POST /api/templates/:template_id/start`

기존 UI 호환 엔드포인트인 `POST /api/templates/:template_id/execute`는 로그인한 관리자에게 Draft 미리보기를 허용한다. API key 요청과 외부 연동은 active published version만 실행하는 `/start`를 표준으로 사용한다.

### Request

```json
{
  "mode": "async",
  "input": {
    "requester": "kim",
    "amount": 1000
  },
  "sync_timeout_ms": 10000
}
```

- `mode`: `async` 또는 `sync`. 기본값은 `async`.
- `input`: Start form/user payload. 런타임에서는 `context.data.formData`에 저장된다.
- `formData`: legacy alias. `input`이 있으면 `input`이 우선한다.
- `sync_timeout_ms`: sync mode에서만 사용한다. 기본 10000ms, 최소 100ms, 최대 30000ms.

### Duplicate Request Protection

외부 시스템은 실행 요청마다 고유한 `Idempotency-Key` 헤더를 보내는 것을 권장한다.

```http
Idempotency-Key: order-20260722-1001
```

- 같은 호출자와 workflow에서 같은 key와 같은 입력을 다시 보내면 새 실행을 만들지 않고 기존 `instance_id`를 반환한다.
- 재사용 응답에는 `idempotent_replay: true`와 `Idempotency-Replayed: true` 헤더가 포함된다.
- 같은 key를 다른 입력에 재사용하면 HTTP `409 Conflict`를 반환한다.
- key는 1~200자의 출력 가능한 문자여야 하며 원문 대신 hash로 저장한다.
- 기본 보관 시간은 24시간이며 `START_IDEMPOTENCY_TTL_HOURS`로 조정할 수 있다.
- 헤더가 없는 요청은 이전과 같이 요청마다 새 실행을 만든다.

### Async Response

HTTP `202 Accepted`

```json
{
  "instance_id": "uuid",
  "template_id": "uuid",
  "template_name": "Workflow Name",
  "status": "CREATED",
  "mode": "async",
  "idempotent_replay": false,
  "result_url": "/api/instances/{instance_id}/result",
  "trace_url": "/api/instances/{instance_id}/trace",
  "stream_url": "/api/instances/{instance_id}/stream"
}
```

### Sync Completed Response

HTTP `200 OK`

```json
{
  "instance_id": "uuid",
  "template_id": "uuid",
  "template_name": "Workflow Name",
  "status": "COMPLETED",
  "mode": "sync",
  "idempotent_replay": false,
  "result": {
    "requester": "kim",
    "amount": 1000
  },
  "result_path": "formData",
  "result_url": "/api/instances/{instance_id}/result",
  "trace_url": "/api/instances/{instance_id}/trace",
  "stream_url": "/api/instances/{instance_id}/stream",
  "timed_out": false
}
```

### Sync Timeout Response

HTTP `202 Accepted`

```json
{
  "instance_id": "uuid",
  "template_id": "uuid",
  "template_name": "Workflow Name",
  "status": "RUNNING",
  "mode": "sync",
  "idempotent_replay": false,
  "result_url": "/api/instances/{instance_id}/result",
  "trace_url": "/api/instances/{instance_id}/trace",
  "stream_url": "/api/instances/{instance_id}/stream",
  "timed_out": true
}
```

## Result

`GET /api/instances/:instance_id/result`

```json
{
  "instance_id": "uuid",
  "status": "COMPLETED",
  "result": {},
  "result_path": "formData",
  "completed_at": null,
  "updated_at": "2026-06-16T01:22:50.060Z"
}
```

End node의 `resultPath`가 비어 있으면 `context.data`만 result로 저장한다. `runtime.nodes`, `runtime.edges`, `runtime.cursor` 같은 내부 실행 데이터는 기본 result에 포함하지 않는다.

## Retry And Terminate Idempotency

- `POST /api/instances/:instance_id/retry`
- `POST /api/instances/:instance_id/terminate`

두 API는 선택적으로 `Idempotency-Key` 헤더를 받는다. 사용자의 중복 클릭이나 호출 시스템의 재전송 가능성이 있으면 요청마다 고유한 key를 보내야 한다.

- 같은 호출자·instance·API에서 같은 key를 다시 보내면 새 작업을 만들지 않고 기존 결과를 반환한다.
- 재사용 응답에는 `idempotent_replay: true`와 `Idempotency-Replayed: true` 헤더가 포함된다.
- Retry에서 같은 key를 `full_instance`와 `failed_node`처럼 다른 요청에 재사용하면 HTTP `409 Conflict`를 반환한다.
- Retry의 instance·token·job·event 저장과 Terminate의 상태·job·event 및 활성 결재
  Request·Step·Task 취소는 각각 한 DB transaction으로 처리한다.
- key 원문은 저장하지 않으며 기본 보관 시간은 24시간이다. `INSTANCE_COMMAND_IDEMPOTENCY_TTL_HOURS`로 변경할 수 있다.
- 헤더가 없으면 기존 동작을 유지하며 응답의 `idempotent_replay`는 `false`다.

## Execution Storage Transaction

워크플로우 실행을 시작할 때 생성되는 process instance, 시작 token, Engine START job은 하나의 DB transaction으로 저장한다. 셋 중 하나라도 저장에 실패하면 앞서 저장된 데이터도 모두 rollback한다.

이 transaction은 다음 실행 경로에 공통 적용된다.

- 관리자 Draft 미리보기와 Published Start
- 직접 instance 생성 API
- Schedule Start
- DB Watch Start
- 전체 instance retry와 failed-node retry
- instance terminate의 상태·대기 Job·종료 event 변경

Workflow Call의 자식 instance·token·job 생성은 Engine runtime transaction 안에서 이미 처리한다. Schedule run 기록과 DB Watch event/cursor 같은 trigger 제어 정보는 실행 데이터 transaction이 성공한 뒤 갱신한다.

## Trace And Stream

- `GET /api/instances/:instance_id/trace`: 최근 trace/event 목록 조회.
- `GET /api/instances/:instance_id/stream`: SSE 기반 실행 이벤트 스트림.

## Export Workflow

`GET /api/templates/:template_id/export`

저장된 workflow를 이식 가능한 JSON 문서로 반환한다. Export에는 원본 definition/version 참고 정보를 포함한다. Import 시에는 새 template id를 발급하되, 원본 정보는 `metadata.imported_from`에 참고 정보로 보존한다.

```json
{
  "schema_version": "pxm.workflow.v1",
  "exported_at": "2026-06-18T04:31:00.000Z",
  "workflow": {
    "definition_id": "8d9b0f8a-5f0a-4f3e-8a6f-4c63f114fe1a",
    "version": 7,
    "exported_version_note": "Add approval branch",
    "name": "Workflow Name",
    "metadata": {
      "description": "",
      "group": "QA",
      "tags": ["phase1"],
      "version_note": ""
    },
    "nodes": [],
    "edges": [],
    "plugin_dependencies": [
      {
        "plugin_id": "builtin.http_request",
        "version": "1.0.0",
        "node_ids": ["svc"]
      }
    ]
  },
  "security": {
    "secrets_policy": "redacted",
    "redacted_paths": ["workflow.nodes[1].data.api_key"]
  }
}
```

Secret성 key는 export 시 `null`로 제거하고 `security.redacted_paths`에 경로를 기록한다. 현재 redaction 대상 key 패턴은 `password`, `secret`, `token`, `api_key`, `access_key`, `private_key`, `connection_uri`, `authorization`, `credential` 계열이다.

### Command terminal output polling

`GET /api/instances/:instance_id/terminal-outputs`

Command Node의 stdout/stderr snapshot을 polling으로 조회한다. 장기 실행 command의 실시간 streaming은 별도 저장소/chunk 모델이 필요하므로, 현재 계약은 trace cursor 기반 polling snapshot으로 둔다.

Query:

- `node_id`: 특정 command node만 조회
- `after`: 이전 응답의 `poll_after` 값. 해당 trace cursor 이후 변경된 command output만 반환

Response:

```json
{
  "instance_id": "170cc5be-a754-459d-8049-65f820ab45cf",
  "status": "COMPLETED",
  "poll_after": 42,
  "outputs": [
    {
      "node_id": "run-command",
      "node_label": "명령어 실행",
      "status": "COMPLETED",
      "command_id": "app.nit.worklog_get",
      "output_path": "commandResults.run-command",
      "exit_code": 0,
      "timed_out": false,
      "duration_ms": 239,
      "stdout": "...",
      "stderr": "",
      "has_output": true,
      "last_event_id": 41,
      "updated_at": "2026-07-08T05:20:00.000Z"
    }
  ]
}
```

ANSI control sequence와 secret성 값은 응답 단계에서 제거/마스킹한다. 원본 stdout/stderr의 장기 보관/삭제 정책은 운영 retention 정책에서 별도로 결정한다.

`POST /api/instances/terminal-outputs/retention/scrub`

Command Node stdout/stderr 보관 기간을 audit log와 분리해서 정리한다. 이 API는 command audit log를 삭제하지 않고, process instance context에 저장된 terminal output만 비운다.

Request:

```json
{
  "instance_id": "170cc5be-a754-459d-8049-65f820ab45cf",
  "older_than_days": 7,
  "dry_run": true,
  "limit": 50
}
```

Rules:

- `instance_id`가 있으면 해당 instance만 검사한다.
- `instance_id`가 없으면 최근 조회 가능한 instance 중 `limit`개를 검사한다.
- `older_than_days` 기본값은 `TERMINAL_OUTPUT_RETENTION_DAYS`, 미설정 시 7일이다.
- audit log 보관 기간은 `AUDIT_LOG_RETENTION_DAYS` 또는 `unbounded`로 별도 표기만 하며 이 API에서 삭제하지 않는다.
- scrub 대상은 context 안에서 `command_id`와 `stdout`/`stderr`를 가진 command output 객체다.

Response:

```json
{
  "retention": {
    "terminal_output_days": 7,
    "audit_log_days": "unbounded",
    "cutoff_at": "2026-07-01T00:00:00.000Z",
    "dry_run": true
  },
  "scanned": 1,
  "scrubbed_instances": 1,
  "scrubbed_outputs": 1,
  "scrubbed_bytes": 4096,
  "results": []
}
```

## Import Workflow

`POST /api/templates/import`

`schema_version: pxm.workflow.v1` 문서를 검증한 뒤 새 workflow template을 생성한다.

검증 기준:

- `workflow.name` 필수
- `workflow.nodes` 배열 필수
- `workflow.edges` 배열 필수
- 모든 node는 `id`, `data.nodeType` 필수
- 모든 edge는 존재하는 source/target node를 참조해야 함
- import는 export 문서 안의 원본 id를 재사용하지 않고 새 template id를 발급함

응답은 일반 template 생성 응답과 동일하다.

## Performance Baseline

- Sync timeout default: 10000ms.
- Sync timeout max: 30000ms.
- Async start response target: engine 처리와 무관하게 instance/job/token 생성 후 300ms 이내 응답을 목표로 한다.
- Result lookup target: 단건 instance context 조회 기준 300ms 이내 응답을 목표로 한다.
- Trace lookup target: 최근 200개 event 조회 기준 500ms 이내 응답을 목표로 한다.
- Long-running workflow: sync timeout 이후에는 `202 Accepted`로 전환하고 client는 `result_url`, `trace_url`, `stream_url`을 사용한다.

## Authentication And Permission Draft

초기 인증/권한 모델은 API-first 운영을 기준으로 둔다. 웹 콘솔 사용자는 일반 업무 사용자가 아니라 최고관리자와 그룹관리자 중심이며, workflow 실행은 대부분 API key 기반이다.

### Principal Model

- `USER`: BPM 콘솔에 로그인하거나 개인 API key를 발급받는 사람. 기본 대상은 `admin`, `group_manager`, 개발/운영 담당자다. 일반 업무 사용자를 모두 BPM user로 등록하지 않는다.
- `SERVICE_ACCOUNT`: 외부 시스템, 배치, bot, 연동 서버를 대표하는 실행 주체다. 운영/연동용 API key는 기본적으로 service account에 발급한다.
- `API_KEY`: `USER` 또는 `SERVICE_ACCOUNT`에 발급되는 인증 수단이다. key scope는 owner 권한을 늘리지 않고 줄이는 용도로만 사용한다.

관리 role은 아래 3단계로 고정한다.

- `admin`: 전체 최고관리자. 모든 group/user/service account/API key/workflow/audit 관리 권한을 가진다.
- `group_manager`: 특정 group 관리자. 본인 group 안에서 user/service account/API key/workflow를 관리한다.
- `user`: 일반 실행 주체 또는 개인 API key owner. 기본적으로 관리 권한은 없다.

`actor_type`은 인증 주체 종류를 나타내고, `role`은 사람 사용자의 관리 권한을 나타낸다. `SERVICE_ACCOUNT`는 관리 role을 갖지 않으며 API key scope와 group/resource policy로만 권한을 계산한다.

권한 계산은 아래 교집합으로 한다.

```text
final permission =
owner group permission
∩ api key scope
∩ resource policy
```

API key는 HTTP `Authorization` header의 bearer token으로 전달한다.

```http
Authorization: Bearer pxm_live_xxxxxxxxx
```

### API Key Owner

API key는 둘 중 하나를 owner로 가진다.

```json
{
  "owner_type": "SERVICE_ACCOUNT",
  "owner_id": "nit-system",
  "group_id": "it",
  "scopes": ["workflow:execute", "workflow:read"],
  "workflow_access": "allowlist",
  "allowed_workflow_ids": ["workflow-uuid"]
}
```

- 개인 실행 추적이 필요한 API 호출은 `USER` owner의 개인 API key를 사용한다.
- 공용 시스템/외부 서비스가 실행하는 호출은 `SERVICE_ACCOUNT` owner의 API key를 사용한다.
- 공용 시스템 내부에서 누가 버튼을 눌렀는지는 원칙적으로 해당 시스템의 audit 책임이다.
- `scopes`는 행위 제한이고, `workflow_access`와 `allowed_workflow_ids`는 대상 workflow 제한이다.
- `workflow_access: all_in_group`은 발급 이후 추가되는 같은 그룹 workflow도 동적으로 허용한다. 이때 `allowed_workflow_ids`는 비어 있어야 한다.
- `workflow_access: allowlist`는 `allowed_workflow_ids`에 명시된 workflow만 허용하며, 빈 배열은 아무 workflow도 허용하지 않는다.
- 기존 key처럼 `workflow_access`가 저장되지 않은 레코드는 권한 확대를 막기 위해 `allowlist`로 해석한다.
- 발급 화면은 두 정책 중 하나를 반드시 선택하게 하며, 기본값은 `all_in_group`이다.
- API key 만료일은 optional이다. 기본은 만료 없음이며, 만료일이 있으면 만료 임박/만료 상태를 표시하고 만료된 key는 사용할 수 없다.

API key 지원 scope는 초기 버전에서 아래로 둔다.

- `workflow:read`: workflow metadata와 허용된 instance/result/trace 조회.
- `workflow:execute`: 허용된 workflow start.
- `task:approve`: 승인 대기 task approve/reject API 호출. 승인 주체 추적이 중요하므로 개인 `USER` owner API key로만 허용한다.

`workflow:manage`는 API key scope로 제공하지 않는다. Workflow 생성/수정/삭제/버전 관리는 PXM 웹 콘솔에 로그인한 `admin` 또는 `group_manager`만 수행한다.

### Soft Delete And Version Retention

group과 workflow 삭제는 기본적으로 soft delete다. Hard delete는 MVP 범위에서 제공하지 않는다.

- 삭제된 group/workflow는 일반 목록에서 숨기고 새 실행을 막는다.
- 삭제된 group에 속한 API key는 비활성화한다.
- 실행 이력, audit log, workflow version은 보존한다.
- 삭제 항목 조회/복구는 `admin`만 가능하다.
- 삭제된 group/workflow를 복구해도 비활성화된 API key는 자동 복구하지 않는다. 필요한 key는 관리자가 별도로 재활성화하거나 재발급한다.
- workflow 실행 instance는 실행 당시 `workflow_version_id`를 저장한다.
- workflow 실행 시점에는 immutable workflow version을 생성하거나 기존 immutable version을 참조한다.
- version 저장소에는 실행 당시 workflow definition을 보관해 현재 workflow가 수정/삭제되어도 과거 실행을 재현할 수 있게 한다.
- instance에는 `workflow_name_snapshot`, `group_name_snapshot`, `caller_snapshot`, `api_key_name_snapshot` 같은 표시용 snapshot을 함께 저장한다.

### Optional Business Actor

`business_actor`는 workflow 권한 판단에 사용하지 않는 참고용 audit metadata다. 외부 시스템이 “업무상 요청자/수행자”를 함께 넘기고 싶을 때만 사용한다.

```json
{
  "caller": {
    "type": "SERVICE_ACCOUNT",
    "id": "nit-system",
    "api_key_id": "key_123"
  },
  "business_actor": {
    "external_user_id": "song-sungeun",
    "display_name": "송성은",
    "email": "song@example.com",
    "trust_level": "asserted",
    "verification_method": "caller_provided"
  }
}
```

정책:

- 기본 권한 판단은 항상 API key owner 기준이다.
- 공용 시스템 내부 버튼을 누른 최종 사용자를 PXM이 직접 인증하지 않았다면, 실행과 오남용에 대한 기본 audit 책임은 API key를 소유한 공용 시스템에 있다.
- `business_actor`가 없으면 실행자는 API key owner로만 기록한다.
- `business_actor`가 있으면 “NIT 시스템이 송성은 요청으로 실행”처럼 표시할 수 있으나, PXM이 직접 송성은을 인증한 것으로 간주하지 않는다.
- 강한 검증이 필요한 경우 별도 단계에서 signed user assertion/JWT를 추가한다. 이 경우에만 `trust_level = verified`로 기록한다.

### API Key Storage And Usage Audit

- API key 원문은 최초 1회만 노출한다.
- DB에는 `key_hash`만 저장하고, `key_prefix`는 조회/식별용으로만 저장한다.
- 모든 external start 요청은 `api_key_id`, owner snapshot, group, workflow, endpoint, request id, IP/user-agent를 usage log에 남긴다.
- secret 원문은 request/response/result/trace에 노출하지 않는다.

## Approval Task API

### Approval Aggregate Foundation

Approval 노드는 개인별 Task와 결재 전체 상태를 분리한다. 1차 구현은 단일 단계·단일 승인자만 지원하지만, 모든 신규 승인 실행은 아래 집계 구조를 생성한다.

```text
ApprovalRequest (token당 1개)
└─ ApprovalStep order=1, mode=ALL, required_count=1
   └─ ApprovalTask
```

- `ApprovalRequest`는 instance, token, node와 결재 전체 상태를 연결한다.
- `ApprovalStep`은 현재 단계의 상태와 향후 `ALL`/`ANY` 확장 지점을 제공한다.
- `ApprovalTask`는 개인의 승인·반려와 의견·결과를 기록하며 `approval_request_id`, `approval_step_id`를 가진다.
- Engine은 개별 Task가 아니라 `ApprovalRequest.status`를 기준으로 `WAITING`, 승인 진행 또는 반려 종료를 결정한다.
- 1차에서는 Task 완료가 곧 단일 Step과 Request의 최종 완료다. 다단계와 복수 승인자는 후속 로드맵에서 추가한다.
- 기존 배포에서 이미 생성된 집계 ID 없는 Task는 호환 경로로 처리한다.

### List My Open Tasks

```http
GET /api/tasks
Cookie: pxm_session=...
```

또는 개인 `USER` owner API key를 사용한다.

```http
GET /api/tasks
Authorization: Bearer pxm_live_xxx
```

- 요청자가 `assignee` query로 다른 사용자를 지정할 수 없다.
- 서버가 인증 actor의 `actor_id`와 일치하는 OPEN task만 조회한다.
- session user는 task가 속한 group의 member여야 한다. `admin`도 본인에게 배정된 task만 처리한다.
- API key는 `task:approve` scope, owner group, `allowed_workflow_ids`를 모두 만족해야 한다.
- `SERVICE_ACCOUNT`는 Approval task를 처리할 수 없다.
- 신규 승인 Task 응답에는 결재 전체와 단계를 추적할 수 있는 `approval_request_id`, `approval_step_id`가 포함된다.

### Approve Or Reject Task

```http
POST /api/tasks/{task_id}/complete
Idempotency-Key: approval-request-uuid
Content-Type: application/json

{
  "action": "approve",
  "comment": "요청 내용을 확인했습니다.",
  "result": {
    "approved_limit": 1000000
  }
}
```

`action`은 `approve` 또는 `reject`만 허용한다. `comment`와 object 형식의 `result`는 선택값이다.

```json
{
  "success": true,
  "task_id": "task-uuid",
  "instance_id": "instance-uuid",
  "action": "approve",
  "status": "APPROVED",
  "already_processed": false
}
```

- OPEN Task, ApprovalStep, ApprovalRequest의 최종 상태 변경과 Engine `RESUME` job 생성, instance `RUNNING` 전이는 같은 DB transaction에서 처리한다.
- OPEN 상태 compare-and-set/row lock과 Request 최종 상태 전이로 동시에 여러 요청이 들어와도 `RESUME` job은 하나만 생성한다.
- 동일 actor가 동일 `Idempotency-Key`와 동일 action으로 재호출하면 기존 결과를 반환하고 `already_processed=true`로 표시한다.
- 이미 처리된 task를 다른 key/action으로 호출하면 `409 Conflict`를 반환한다.
- 담당자, group, workflow 또는 API key scope가 맞지 않으면 `403 Forbidden`을 반환한다.
- 처리 audit에는 actor, API key ID, optional `business_actor`, comment/result, instance/workflow/group을 기록한다.
- 브라우저 session의 POST 요청은 기존 CSRF 정책을 그대로 적용한다.

### External Email Approval

Approval 노드의 `approverChannel`이 `external_email`이면 task의 assignee는 이메일 주소다. API 메일 디스패처가 task 생성 후 일회용 링크를 발송하며 토큰 원문은 저장하지 않는다.

```http
GET /api/external-approvals/{token}
POST /api/external-approvals/{token}/otp
POST /api/external-approvals/{token}/complete
Content-Type: application/json

{
  "action": "approve",
  "comment": "확인했습니다.",
  "otp": "123456"
}
```

- 세 endpoint는 PXM 로그인 없이 사용한다.
- 승인 링크는 단회 사용하며 노드에 설정한 시간 이후 만료된다.
- OTP가 필요한 task는 10분 유효한 6자리 OTP를 사용한다. 재발송 간격은 60초이고 실패는 최대 5회다.
- Task·ApprovalStep·ApprovalRequest 완료와 Engine `RESUME`, 링크 소비는 같은 transaction에서 처리한다.
- audit에는 `external_email` 채널, 이메일, `email_link` 또는 `email_otp` 인증 방식과 처리 시각을 기록한다.
- 상세 응답의 이메일은 마스킹하고 form data의 password/secret/token/credential/API key 계열 필드는 제거한다.
- SMTP 및 공개 URL 설정은 `docs/external-approval-email.md`를 따른다.
- OTP SMTP 발송 실패 시 발급 상태와 재발송 제한을 되돌려 즉시 다시 요청할 수 있다.
- 최고관리자 또는 task 소유 group의 그룹 관리자는 `POST /api/tasks/{task_id}/external-approval/retry`로 기존 링크·OTP를 폐기하고 메일 발송을 다시 큐잉할 수 있다.

### Approval Task History

`GET /api/tasks`는 기존 호환성을 위해 현재 actor의 OPEN 결재함만 반환한다. 완료 이력과 검색은 별도 endpoint를 사용한다.

```http
GET /api/tasks/history?status=APPROVED,REJECTED&workflow_id={id}&from=2026-07-01T00:00:00Z&limit=50
GET /api/tasks/{task_id}
GET /api/instances/{instance_id}/tasks?limit=50
Authorization: Bearer pxm_live_xxx
```

목록 응답은 cursor pagination을 사용한다.

```json
{
  "items": [
    {
      "task_id": "task-uuid",
      "instance_id": "instance-uuid",
      "workflow_id": "workflow-uuid",
      "workflow_name": "구매 승인",
      "workflow_version": 3,
      "group_id": "finance",
      "node_id": "manager-approval",
      "node_label": "팀장 승인",
      "approval_request_id": "request-uuid",
      "approval_step_id": "step-uuid",
      "request_status": "APPROVED",
      "current_step_order": 2,
      "total_steps": 2,
      "step_order": 2,
      "step_mode": "ALL",
      "step_status": "APPROVED",
      "source_provider": "acrapoint",
      "external_request_id": "ACRA-2026-0042",
      "external_revision": 1,
      "content_snapshot": {
        "title": "노트북 구매",
        "summary": "개발 장비 구매 요청"
      },
      "approval_line_snapshot": {
        "mode": "sequential",
        "steps": []
      },
      "status": "APPROVED",
      "approver_channel": "pxm_user",
      "approval_channels": ["pxm_user", "external_email"],
      "assignee": "pxm-user-7",
      "action": "approve",
      "comment": "확인했습니다.",
      "result": null,
      "authentication_method": "email_otp",
      "completed_via": "external_email",
      "delivery_status": "SENT",
      "delivery_attempt_count": 1,
      "delivery_last_error": null,
      "link_expires_at": "2026-07-22T00:00:00.000Z",
      "created_at": "2026-07-21T00:00:00.000Z",
      "updated_at": "2026-07-21T00:05:00.000Z",
      "completed_at": "2026-07-21T00:05:00.000Z"
    }
  ],
  "next_cursor": null
}
```

- 지원 filter: `status`, `workflow_id`, `instance_id`, `assignee`, `approver_channel`, `from`, `to`, `cursor`, `limit`.
- `approver_channel` filter는 허용 채널 배열에 해당 값이 포함된 Task를 찾는다.
  `approver_channel` 응답 필드는 기존 클라이언트 호환용 대표값이고, 신규 연동은
  `approval_channels`와 `completed_via`를 사용한다.
- `status`는 `OPEN`, `APPROVED`, `REJECTED`, `CANCELED`를 쉼표로 조합한다.
- 일반 user는 본인에게 배정된 task만, group manager는 관리 group, admin은 전체 이력을 조회한다.
- API key와 service account는 `workflow:read` scope, owner group, `allowed_workflow_ids`를 모두 만족해야 한다.
- 외부 이메일 링크는 해당 OPEN task 상세만 제공하며 이력 API 접근 권한을 부여하지 않는다.
- 승인/반려 transaction은 `TASK_APPROVED` 또는 `TASK_REJECTED`와 최종
  `APPROVAL_REQUEST_APPROVED`, `APPROVAL_REQUEST_REJECTED`,
  `APPROVAL_REQUEST_CANCELED` outbox event를 함께 생성한다.
- 최종 Request event는 상태 전이 CAS를 획득한 transaction에서 한 번만 생성한다.
  Webhook Dispatcher는 이 이벤트에 저장소별 고유 ID를 부여해
  `Idempotency-Key`와 `X-PXM-Event-Id`로 전달한다.

```json
{
  "event_type": "APPROVAL_REQUEST_REJECTED",
  "payload": {
    "approval_request_id": "request-uuid",
    "task_id": "task-uuid",
    "status": "REJECTED",
    "outcome": "rejected",
    "approval_channels": ["pxm_user", "external_email"],
    "completed_via": "external_email",
    "authentication_method": "email_otp",
    "source": {
      "provider": "acrapoint",
      "request_id": "ACRA-2026-0042",
      "revision": 1
    }
  }
}
```

### Final Approval Webhook

최고관리자는 `POST /api/webhooks/endpoints`로 `source_provider`별 결과 수신
Endpoint를 등록한다. Dispatcher는 최종 결재 Outbox event만 읽어 다음 헤더와
함께 at-least-once 방식으로 전달한다.

```text
X-PXM-Event-Id: <database>:<outbox-event-id>
X-PXM-Timestamp: <unix-seconds>
X-PXM-Signature: v1=<HMAC-SHA256(timestamp.raw-body)>
Idempotency-Key: <database>:<outbox-event-id>
```

`2xx`와 `409`는 완료, timeout·`408`·`425`·`429`·`5xx`는 지수 백오프
재시도, 나머지 `4xx`는 `DEAD_LETTER`로 처리한다. 운영자는
`POST /api/webhooks/deliveries/:id/retry`로 실패 건을 재전송할 수 있다. 전체
payload, 서명 검증과 운영 설정은 `docs/webhook-delivery.md`를 따른다.

## History API Permission Model

이력 API 권한 모델은 `/api/instances`, `/api/instances/:id`, `/api/instances/:id/trace`, `/api/instances/:id/result`, `/api/instances/:id/stream`에 동일하게 적용한다. 목록 API는 조회 가능한 instance만 반환하고, 단건/trace/result/stream API는 조회 권한이 없으면 `404 Not Found`를 반환한다. 권한 없는 instance의 존재 여부를 노출하지 않기 위해 `403 Forbidden`은 사용하지 않는다.

### Actor Context

인증 계층은 API handler에 아래 actor context를 전달해야 한다.

```json
{
  "actor_type": "service_account",
  "actor_id": "nit-system",
  "api_key_id": "key_123",
  "group_ids": ["it"],
  "allowed_workflow_ids": ["workflow-uuid"],
  "business_actor": {
    "external_user_id": "song-sungeun",
    "display_name": "송성은",
    "trust_level": "asserted"
  }
}
```

- `actor_type`: `user` 또는 `service_account`.
- `actor_id`: BPM user id 또는 service account id.
- `api_key_id`: API key로 인증한 요청이면 사용한 key id.
- `group_ids`: actor가 속한 group 목록.
- `roles`: 사람 user의 관리 role 목록은 `admin`, `group_manager`, `user`만 사용한다. `service_account` actor는 보통 빈 배열 또는 생략으로 둔다. `operator`, `workflow_owner`, `requester`, `approver`, `api_client`는 session role로 발급하지 않고, 기본 비활성인 actor header 또는 샘플 runtime 호환 경로에서만 유지한다.
- `allowed_workflow_ids`: API key scope 또는 group permission 교집합으로 허용된 workflow/template id 목록.
- `allowed_instance_ids`: MVP에서는 사용하지 않는 future field. task 위임이나 임시 공유 기능이 필요할 때 추가한다.
- `business_actor`: optional audit metadata. 권한 판단에는 사용하지 않는다.

인증이 없는 개발 환경에서는 actor context가 없으면 기존 UI 호환을 위해 operator-equivalent read로 처리할 수 있다. 운영 환경에서는 actor context가 없는 요청을 `401 Unauthorized`로 거부한다.

### Instance Ownership Fields

권한 판단에 필요한 instance 필드는 아래 기준으로 저장한다.

- `group_id`: workflow가 속한 group. group 미지정 legacy workflow는 `default`로 취급한다.
- `process_definition_id` 또는 `template_id`: workflow/template id.
- `workflow_version_id`: 실행 당시 workflow definition version id.
- `caller`: 실행을 인증한 user/service account/API key snapshot.
- `business_actor`: optional 업무상 실행자/요청자 snapshot. 권한 판단에는 사용하지 않는다.
- `approver_ids`: 현재 또는 과거 user task assignee 목록. task repository에서 조인하거나 instance context에 denormalize한다.

외부 start payload의 `input.requester`나 `business_actor`는 업무 데이터/audit metadata로만 취급하고 권한 판단 subject로 사용하지 않는다.

### Role Scopes

- `admin`: 모든 group의 instance, trace, result, stream 조회 가능.
- `group_manager`: 본인 `group_ids`에 포함된 group의 workflow/instance 조회 가능.
- `user`: 본인에게 허용된 API key scope와 `allowed_workflow_ids` 범위에서만 workflow 실행/조회 가능.
- `workflow_owner`: legacy role. `owned_workflow_ids`에 포함된 workflow/template에서 생성된 instance 조회 가능.
- `requester`: legacy/user-portal role. `requester_id === actor_id`인 instance 조회 가능.
- `approver`: `approver_ids`에 `actor_id`가 포함된 instance 조회 가능. 본인에게 배정된 task와 그 관련 instance의 trace/result/stream을 볼 수 있다.
- `api_client`: API key owner가 속한 group permission과 key scope 교집합에서 허용된 workflow/instance만 조회 가능.

여러 role이 있으면 허용 범위는 합집합으로 계산한다.

### Runtime Integrity Admin API

`POST /api/runtime-integrity/scan`

- 최고관리자 `admin`만 호출할 수 있다.
- 기본적으로 마지막 변경 후 60초가 지난 runtime 데이터만 검사한다.
- 점검은 읽기 전용이며 Job, Token, Task, instance 상태를 변경하지 않는다.
- 응답은 안전한 자동 복구 가능 항목과 수동 확인 필요 항목을 구분한다.

`POST /api/runtime-integrity/repair`

- 최고관리자 `admin`만 호출할 수 있고 `Idempotency-Key` header가 필요하다.
- 요청에는 점검 결과의 `finding_type`, `resource_id`, `observed_updated_at`과 처리 사유 `reason`을 전달한다.
- API는 복구 직전에 같은 이상 상태인지 다시 확인한다. 상태가 바뀌었으면 `no_longer_present`로 응답하고 변경하지 않는다.
- 연결 없는 Job·Token·Task 정리와 처리 Job이 사라진 RUNNING instance 재등록만 지원한다.
- 승인 Task 재생성이나 사라진 workflow 정의 추정은 자동 처리하지 않는다.
- 실제 변경과 중복 재요청 결과는 `management_audit_logs`에 기록한다.

### Endpoint Rules

`GET /api/instances`

- `admin`: 전체 목록.
- `group_manager`: `group_id in actor.group_ids`.
- `user`: API key scope와 `allowed_workflow_ids`로 허용된 instance.
- `workflow_owner`: `process_definition_id/template_id in actor.owned_workflow_ids`.
- `requester`: `requester_id = actor.actor_id`.
- `approver`: `approver_ids contains actor.actor_id`.
- `api_client`: 명시 허용 workflow/instance와 group permission 교집합.

`GET /api/instances/:id`

- 목록 API와 같은 scope filter를 단건 instance에 적용한다.
- 권한이 없거나 instance가 없으면 `404 Not Found`.

`GET /api/instances/:id/trace`

- instance 단건 조회 권한이 있을 때만 허용한다.
- trace payload는 secret redaction 후 반환한다.

`GET /api/instances/:id/result`

- instance 단건 조회 권한이 있을 때만 허용한다.
- result payload는 secret redaction 후 반환한다.

`GET /api/instances/:id/stream`

- SSE 연결 시점에 instance 단건 조회 권한을 확인한다.
- 연결 유지 중 권한이 변경될 수 있으므로 장기 연결은 재연결 또는 주기적 재검증 정책을 둔다. 초기 구현은 연결 시점 검증만 적용한다.
