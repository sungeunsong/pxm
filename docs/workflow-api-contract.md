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

저장된 workflow를 이식 가능한 JSON 문서로 반환한다. Export에는 원본 template id를 포함하지 않으며, import 시 새 template id를 발급한다.

```json
{
  "schema_version": "pxm.workflow.v1",
  "exported_at": "2026-06-18T04:31:00.000Z",
  "workflow": {
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
