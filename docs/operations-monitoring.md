# 실행·Outbox 운영 모니터링

최고관리자는 Web의 `운영 상태` 화면에서 Engine Job, 장시간 `WAITING`
인스턴스, 만료된 인스턴스 lease와 Webhook 전송 적체를 함께 확인할 수 있다.
화면은 15초마다 갱신되며 조회 자체는 실행 데이터를 변경하지 않는다.

## 상태 기준

- `HEALTHY`: 실패·만료 잠금이 없고 적체 임계값 이내
- `WARNING`: 재개 근거가 없는 장시간 `WAITING`, 5분 이상 QUEUED 또는 Webhook PENDING
- `DANGER`: FAILED Job, FAILED/DEAD_LETTER 전송 또는 만료 잠금 존재

기본 장기 대기 기준은 60분이다. Queue와 Outbox 경고 기준은 각각
`OPERATIONS_QUEUE_WARNING_MS`, `OPERATIONS_OUTBOX_WARNING_MS`로 조정하며
기본값은 300000ms다.

장시간 `WAITING` 자체는 장애로 보지 않는다. 처리 가능한 `OPEN` Task, 실행
예정 Job 또는 진행 중인 하위 워크플로우가 있으면 `EXPECTED` 정상 대기로
분류해 정보만 표시한다. 이 세 가지 재개 근거가 모두 없을 때만
`SUSPICIOUS`로 분류해 경고 상태에 반영한다.

## 관리 API

```text
GET  /api/operations/overview
POST /api/operations/jobs/:id/retry
POST /api/operations/instances/:id/reclaim-lock
POST /api/operations/outbox/:id/retry
```

모든 API는 최고관리자만 사용할 수 있다. 변경 요청은 3자 이상의 `reason`을
요구하고 실행 전 상태를 다시 확인한다.

```json
{ "reason": "worker 재기동 후 실패 Job 복구" }
```

- Job 재시도는 현재도 `FAILED`인 행만 원자적으로 `QUEUED`로 바꾼다.
- 잠금 회수는 현재도 lease가 만료된 인스턴스만 처리한다.
- Outbox 재전송은 활성 Endpoint의 `FAILED`, `DEAD_LETTER`, `CANCELED`
  전달만 `PENDING`으로 되돌린다.

같은 버튼을 중복으로 눌러도 첫 조건부 갱신 이후 요청은 `409 Conflict`가 된다.
실행자, 시각, 사유와 결과는 management audit에 기록된다. Engine 자체는 시작 시
만료 lease 또는 stale `RUNNING` Job을 다시 `QUEUED`로 회수하므로 Worker 강제
종료 후에도 재기동으로 자동 복구할 수 있다.
