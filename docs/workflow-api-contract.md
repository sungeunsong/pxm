# Workflow API Contract

Phase 1 기준의 외부 연동용 workflow 실행 계약이다.

## Start Workflow

`POST /api/templates/:template_id/start`

기존 UI 호환 엔드포인트인 `POST /api/templates/:template_id/execute`도 같은 실행 로직을 사용한다. 외부 연동은 `/start`를 표준으로 사용한다.

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

### Async Response

HTTP `202 Accepted`

```json
{
  "instance_id": "uuid",
  "template_id": "uuid",
  "template_name": "Workflow Name",
  "status": "CREATED",
  "mode": "async",
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
  "allowed_workflow_ids": ["workflow-uuid"]
}
```

- 개인 실행 추적이 필요한 API 호출은 `USER` owner의 개인 API key를 사용한다.
- 공용 시스템/외부 서비스가 실행하는 호출은 `SERVICE_ACCOUNT` owner의 API key를 사용한다.
- 공용 시스템 내부에서 누가 버튼을 눌렀는지는 원칙적으로 해당 시스템의 audit 책임이다.
- `scopes`는 행위 제한이고, `allowed_workflow_ids`는 대상 workflow 제한이다.
- 기본 발급 화면은 owner group에서 접근 가능한 workflow 전체를 선택하되, 발급자가 일부 workflow만 남기도록 축소할 수 있어야 한다.
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
