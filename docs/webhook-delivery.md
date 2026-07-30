# 최종 결재 결과 Webhook

PXM은 동적 결재의 최종 승인, 반려, 취소 이벤트를 Outbox에 먼저 기록한 뒤
별도 Dispatcher가 외부 시스템으로 전달한다. 결재 transaction은 외부 HTTP
응답을 기다리지 않으므로 외부 시스템 장애가 워크플로우 상태 전이를 되돌리지 않는다.

## Endpoint 등록

최고관리자만 `/api/webhooks` 관리 API와 Web의 `결과 Webhook` 화면을 사용할 수
있다. API key와 일반 사용자는 접근할 수 없다.

```http
POST /api/webhooks/endpoints
Content-Type: application/json

{
  "name": "AcraPoint 운영",
  "source_provider": "acrapoint",
  "url": "https://acrapoint.example/webhooks/pxm",
  "secret": "32자 이상의 HMAC 공유 Secret",
  "timeout_ms": 5000,
  "max_attempts": 8
}
```

- `source_provider`가 최종 이벤트의 `payload.source.provider`와 같은 경우에만
  전달한다.
- Endpoint 등록 이후 발생한 최종 이벤트부터 전달한다. 등록 전에 이미 완료된
  결재 결과는 자동으로 소급 전송하지 않는다.
- Secret은 `CREDENTIAL_SECRET_KEY`에서 파생된 키로 AES-256-GCM 암호화한다.
- Secret 원문은 생성 응답, 목록, 감사 로그에 반환하지 않는다.
- URL은 목록과 감사 로그에서 origin만 남기고 path를 마스킹한다.
- 운영 환경은 HTTPS URL만 허용한다. 폐쇄망에서 HTTP가 불가피하면
  `WEBHOOK_ALLOW_INSECURE_HTTP=true`를 명시해야 한다.
- Endpoint 비활성화 시 아직 시작하지 않은 전달 건은 `CANCELED`가 된다.

## 전송 계약

```json
{
  "id": "mongodb:66a123...",
  "type": "APPROVAL_REQUEST_APPROVED",
  "occurred_at": "2026-07-30T01:00:00.000Z",
  "data": {
    "instance_id": "instance-uuid",
    "approval_request_id": "request-uuid",
    "task_id": "task-uuid",
    "status": "APPROVED",
    "outcome": "approved",
    "source": {
      "provider": "acrapoint",
      "request_id": "ACRA-2026-0042",
      "revision": 1
    }
  }
}
```

지원하는 `type`은 다음 세 가지다.

- `APPROVAL_REQUEST_APPROVED`
- `APPROVAL_REQUEST_REJECTED`
- `APPROVAL_REQUEST_CANCELED`

요청 헤더:

```text
Content-Type: application/json
User-Agent: PXM-Webhook/1.0
X-PXM-Event-Id: mongodb:66a123...
X-PXM-Timestamp: 1785373200
X-PXM-Signature: v1=<hex hmac sha256>
Idempotency-Key: mongodb:66a123...
```

서명 입력은 `${timestamp}.${raw_request_body}`이며 등록한 Secret으로 HMAC-SHA256
계산한다. 외부 시스템은 timestamp가 허용 시간 범위 안인지 확인한 후
constant-time 방식으로 서명을 비교해야 한다.

외부 소비자는 `Idempotency-Key`를 유일키로 저장하고 이미 처리한 이벤트를 다시
받아도 업무 처리를 반복하지 않아야 한다. PXM은 네트워크 장애에서 같은 이벤트를
다시 보낼 수 있는 at-least-once 전달 방식을 사용한다.

## 응답과 재시도

- `2xx`: 성공
- `409`: 이미 처리한 중복 이벤트로 간주해 성공
- `408`, `425`, `429`, `5xx`, timeout, 연결 오류: 지수 백오프 재시도
- 그 외 `4xx`: 영구 오류로 보고 즉시 `DEAD_LETTER`
- 재시도 횟수 초과: `DEAD_LETTER`

기본 재시도 간격은 5초부터 시작해 최대 1시간이며 운영자가 실패·DLQ·취소 건을
수동 재전송할 수 있다. 수동 재전송은 현재 Endpoint가 활성 상태인 경우에만
가능하고 관리 감사 로그에 남는다.

## 관리 API

```text
GET  /api/webhooks/endpoints
PUT  /api/webhooks/endpoints/:id
GET  /api/webhooks/deliveries
GET  /api/webhooks/deliveries/:id
POST /api/webhooks/deliveries/:id/retry
```

전송 이력 상태는 `PENDING`, `RUNNING`, `SENT`, `FAILED`, `DEAD_LETTER`,
`CANCELED`다. 상세 API는 시도 번호, HTTP status, 소요 시간, 오류와 409 중복
응답 여부를 반환한다.

## 운영 환경 변수

```text
WEBHOOK_DISPATCH_ENABLED=true
WEBHOOK_DISPATCH_POLL_MS=2000
WEBHOOK_DISPATCH_BATCH_SIZE=20
WEBHOOK_DISCOVERY_BATCH_SIZE=200
WEBHOOK_INITIAL_RETRY_DELAY_MS=5000
WEBHOOK_MAX_RETRY_DELAY_MS=3600000
WEBHOOK_ALLOW_INSECURE_HTTP=false
CREDENTIAL_SECRET_KEY=<32자 이상의 운영 Secret>
```

여러 API 프로세스가 동시에 동작해도 Endpoint와 event의 고유키, 전달 lease,
Outbox cursor 덕분에 전달 레코드는 하나만 생성된다. 프로세스가 전송 중 종료되면
lease 만료 후 다른 Dispatcher가 같은 event id로 재시도한다.
