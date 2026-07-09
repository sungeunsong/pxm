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

Phase 1에서는 인증/권한 구현은 포함하지 않는다. 계약 초안은 아래 기준으로 둔다.

- 외부 start API는 API client credential 또는 bearer token 기반으로 보호한다.
- API client는 허용된 workflow/template만 start할 수 있어야 한다.
- result/trace/stream 조회는 requester, owner, operator/admin 범위로 제한한다.
- 모든 external start 요청은 requester/client id, source, request id를 audit field로 남긴다.
- secret 원문은 request/response/result/trace에 노출하지 않는다.

## History API Permission Model

Phase 2의 이력 API 권한 모델은 `/api/instances`, `/api/instances/:id`, `/api/instances/:id/trace`, `/api/instances/:id/result`, `/api/instances/:id/stream`에 동일하게 적용한다. 목록 API는 조회 가능한 instance만 반환하고, 단건/trace/result/stream API는 조회 권한이 없으면 `404 Not Found`를 반환한다. 권한 없는 instance의 존재 여부를 노출하지 않기 위해 `403 Forbidden`은 사용하지 않는다.

### Actor Context

인증 계층은 API handler에 아래 actor context를 전달해야 한다.

```json
{
  "actor_type": "user",
  "actor_id": "kim",
  "roles": ["requester"],
  "workspace_ids": ["default"],
  "owned_workflow_ids": ["workflow-uuid"],
  "allowed_workflow_ids": ["workflow-uuid"],
  "allowed_instance_ids": ["instance-uuid"]
}
```

- `actor_type`: `user` 또는 `api_client`.
- `actor_id`: 사용자 id 또는 API client id.
- `roles`: `admin`, `operator`, `workflow_owner`, `requester`, `approver` 중 하나 이상.
- `workspace_ids`: actor가 접근 가능한 workspace 범위. workspace를 아직 저장하지 않는 instance는 `default` workspace로 취급한다.
- `owned_workflow_ids`: workflow owner가 관리하는 workflow/template id 목록.
- `allowed_workflow_ids`: API client 또는 제한 사용자에게 명시적으로 허용된 workflow/template id 목록.
- `allowed_instance_ids`: API client 또는 task 위임으로 명시적으로 허용된 instance id 목록.

인증이 없는 개발 환경에서는 actor context가 없으면 기존 UI 호환을 위해 operator-equivalent read로 처리할 수 있다. 운영 환경에서는 actor context가 없는 요청을 `401 Unauthorized`로 거부한다.

### Instance Ownership Fields

권한 판단에 필요한 instance 필드는 아래 기준으로 저장한다.

- `workspace_id`: workflow가 속한 workspace. 없으면 `default`.
- `process_definition_id` 또는 `template_id`: workflow/template id.
- `requester_id`: start 요청의 최종 신청자. UI 신청은 로그인 사용자 id, 외부 API 신청은 payload의 requester가 아니라 인증된 subject에서 결정한다.
- `client_id`: API client로 시작한 경우의 client id.
- `approver_ids`: 현재 또는 과거 user task assignee 목록. task repository에서 조인하거나 instance context에 denormalize한다.

외부 start payload의 `input.requester`는 업무 데이터로만 취급하고 권한 판단 subject로 사용하지 않는다.

### Role Scopes

- `admin`: 모든 workspace의 instance, trace, result, stream 조회 가능.
- `operator`: 본인 `workspace_ids`에 포함된 workspace의 모든 instance 조회 가능.
- `workflow_owner`: `owned_workflow_ids`에 포함된 workflow/template에서 생성된 instance 조회 가능. trace/result/stream도 같은 범위로 허용한다.
- `requester`: `requester_id === actor_id`인 instance 조회 가능.
- `approver`: `approver_ids`에 `actor_id`가 포함된 instance 조회 가능. 본인에게 배정된 task와 그 관련 instance의 trace/result/stream을 볼 수 있다.
- `api_client`: `client_id === actor_id`인 instance, `allowed_instance_ids`에 포함된 instance, 또는 `allowed_workflow_ids`에 포함된 workflow/template에서 생성된 instance만 조회 가능.

여러 role이 있으면 허용 범위는 합집합으로 계산한다.

### Endpoint Rules

`GET /api/instances`

- `admin`: 전체 목록.
- `operator`: `workspace_id in actor.workspace_ids`.
- `workflow_owner`: `process_definition_id/template_id in actor.owned_workflow_ids`.
- `requester`: `requester_id = actor.actor_id`.
- `approver`: `approver_ids contains actor.actor_id`.
- `api_client`: `client_id = actor.actor_id` 또는 명시 허용 workflow/instance.

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
