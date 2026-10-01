# PXM Public API v1

외부 소비자는 `/api/v1`만 사용한다. 베타 마이그레이션 동안 동일 기능의 기존 `/api` 경로도 유지하지만, 내부 관리 API는 버전 경로로 노출하지 않는다.

- Swagger UI: `/api/docs`
- OpenAPI 3.1 JSON: `/api/docs/openapi.json`
- 빌드 산출물: `apps/api/openapi.json`

API 코드와 DTO가 문서의 원본이다. 서버를 다시 실행하면 Swagger UI가 갱신되고, `pnpm --filter api build`는 DB 연결 없이 `openapi.json`을 다시 생성한다. API 테스트는 저장된 산출물이 코드와 달라지면 실패한다.

## 공개 엔드포인트

### 워크플로우

- `GET /api/v1/templates`
- `GET /api/v1/templates/:id`
- `POST /api/v1/templates/:id/execute`
- `POST /api/v1/templates/:id/start` (호환 별칭)

### 실행 및 결과

- `GET /api/v1/instances`
- `GET /api/v1/instances/:id`
- `GET /api/v1/instances/:id/result`
- `POST /api/v1/instances/:id/terminate` (`workflow:execute` scope, 선택적 `Idempotency-Key`)
- `GET /api/v1/instances/:id/trace`
- `GET /api/v1/instances/:id/stream`

### 결재

- `GET /api/v1/tasks`
- `GET /api/v1/tasks/history`
- `GET /api/v1/tasks/:id`
- `POST /api/v1/tasks/:id/complete`
- `GET /api/v1/instances/:instanceId/tasks`

### AI Tool

AI 하네스용이다. 게시된 워크플로우를 Tool 이름으로 부르고, Tool에 고정된 버전을 실행한다.
게시·관리는 콘솔 전용 `/api/entry-points`에서 한다.

- `GET /api/v1/tools` (`tool:read`) — LLM tool 정의로 바로 바꿀 수 있는 목록. `naming=auto|qualified|plain`, `side_effect`, `tags`
- `GET /api/v1/tools/:name` (`tool:read`)
- `POST /api/v1/tools/:name/invoke` (`tool:invoke`, 선택적 `Idempotency-Key`) — `{ arguments, group_id?, mode?, sync_timeout_ms? }`
- `GET /api/v1/tools/invocations/:instance_id` (`tool:invoke`) — 202를 받은 뒤 결과 확인. 응답 모양은 실행과 같다

이름은 Tool 이름(`request_access`) 또는 한정 이름(`{그룹 공개 이름}__{Tool 이름}`)이다.
같은 Tool 이름이 여러 그룹에 있으면 추측해서 실행하지 않고 `409 TOOL_NAME_AMBIGUOUS`를 준다.
여러 턴에 걸쳐 이름을 캐시하는 하네스는 `naming=qualified`를 쓴다.

| 응답 | HTTP | 뜻 |
|---|---|---|
| `status: ok` | 200 | 완료. 결과는 `result` |
| `status: error`, `error.kind: business` | 200 | 업무 실패(반려, 업무 실패로 종료). 재시도하지 않는다 |
| `status: pending_approval` | 202 | 결재 대기. `pending.approvers`, 결과는 `result_url` |
| `status: running` | 202 | 진행 중(`mode: async` 또는 대기 한도 초과) |
| `TOOL_EXECUTION_FAILED` | 422 / 502 / 504 / 500 | 실행 실패. `failure_type`·`retryable`, 재시도 가능하면 `Retry-After` |
| `TOOL_EXECUTION_TERMINATED` | 409 | 운영자·호출자가 실행을 종료했다 |

시작 전 오류: `400 TOOL_INPUT_INVALID`(항목별 `details[].path`), `403 MISSING_SCOPE`, `404 TOOL_NOT_FOUND`(권한 밖도 같다),
`409 TOOL_DISABLED`, `409 TOOL_VERSION_UNAVAILABLE`. 모든 오류에 `retryable`이 있다.

- 자동 재시도는 HTTP 코드가 아니라 `retryable`로 판단한다. `side_effect`가 `read_only`가 아니면 첫 호출과 같은 `Idempotency-Key`로 재시도한다
- 최종 사용자 전달(`on_behalf_of`)은 아직 받지 않는다(`400 ON_BEHALF_OF_UNSUPPORTED`). 검증 기능과 함께 연다(PXM-71)
- `trace_url`·`stream_url`은 키에 `workflow:read`가 있을 때만 응답에 넣는다. Tool 이름에는 `__`를 쓸 수 없다(한정 이름 구분자)

그룹, 사용자, API Key, credential, plugin, webhook 설정, 운영 복구 API는 관리 콘솔용 `/api` 경로에만 존재한다.
인스턴스 `pause`와 `resume`도 운영자 제어 기능이므로 관리 콘솔용 `/api` 경로에만 둔다.

종료 요청은 해당 키의 그룹과 허용 워크플로우에 속하면서, **같은 소유자(사용자 또는 서비스 계정)의
API Key로 시작한 실행**만 처리한다. Key를 재발급해도 소유자가 같으면 종료할 수 있다. 다른 소유자가
시작했거나 시작 소유자 정보가 없는 기존 실행, 그 밖의 범위 밖 실행은 `404`로 숨긴다.
`workflow:execute` scope가 없으면 `403`을 반환한다. 이미 완료·실패·종료된 실행은 오류로 만들지 않고
`terminated_instances: []`로 응답한다. 같은 `Idempotency-Key`를 다시 보내면 최초 응답을 재생한다.

## 실행 결과 판정

`GET /api/v1/instances/:id/result`의 `status`는 실행 상태다. 업무 결과는 `outcome`
(`SUCCESS` / `REJECTED` / `FAILURE` / `CANCELLED`, 진행 중이면 `null`)과 `outcome_reason`으로 판정한다.
결재 반려는 `status: "COMPLETED"`, `outcome: "REJECTED"`다. 자동 재시도는 `outcome_reason.retryable`을
기준으로 한다. 상세 규칙은 `docs/features.md`의 "실행 상태와 처리 결과"를 따른다.

## 오류 응답과 요청 추적

클라이언트는 최대 128자의 영문자·숫자 및 `._:-`로 구성된 `X-Request-ID`를 보낼 수 있다. 생략하거나 유효하지 않으면 서버가 새 ID를 생성한다. 서버는 모든 응답의 `X-Request-ID` 헤더에 실제 사용한 값을 반환한다.

공개 API 오류는 다음 공통 필드를 사용한다.

```json
{
  "statusCode": 403,
  "error": "Forbidden",
  "code": "MISSING_SCOPE",
  "message": "workflow:execute scope is required",
  "required_scope": "workflow:execute",
  "request_id": "client-request-42",
  "timestamp": "2026-08-26T06:00:00.000Z",
  "path": "/api/v1/templates/workflow-1/start"
}
```

- `code`는 프로그램에서 분기할 안정적인 오류 코드다.
- `request_id`는 응답 헤더와 서버 요청 로그에서 동일하다.
- 여러 입력 검증 오류가 있으면 `details` 배열도 제공한다.
- 호출자가 스스로 풀 수 없는 오류에는 `remediation`(해결 방법), `remediation_actor`(`self` / `group_manager` / `admin`),
  필요하면 `remediation_group_id`를 함께 준다.
- 처리되지 않은 서버 오류는 `INTERNAL_SERVER_ERROR`와 일반 메시지만 반환하며 내부 예외나 stack trace를 노출하지 않는다.
