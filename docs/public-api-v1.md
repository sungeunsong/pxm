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
