# PXM Public API v1

외부 소비자는 `/api/v1`만 사용한다. 베타 마이그레이션 동안 동일 기능의 기존 `/api` 경로도 유지하지만, 내부 관리 API는 버전 경로로 노출하지 않는다.

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
- `GET /api/v1/instances/:id/trace`
- `GET /api/v1/instances/:id/stream`

### 결재

- `GET /api/v1/tasks`
- `GET /api/v1/tasks/history`
- `GET /api/v1/tasks/:id`
- `POST /api/v1/tasks/:id/complete`
- `GET /api/v1/instances/:instanceId/tasks`

그룹, 사용자, API Key, credential, plugin, webhook 설정, 운영 복구 API는 관리 콘솔용 `/api` 경로에만 존재한다.

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
- 처리되지 않은 서버 오류는 `INTERNAL_SERVER_ERROR`와 일반 메시지만 반환하며 내부 예외나 stack trace를 노출하지 않는다.
