# PXM 승인자 알림

PXM 사용자 전용 채널(`approval_channels: [pxm_user]`)의 승인 Task가 `OPEN`으로 생성되면
Notification Dispatcher가 이메일 알림을 발송한다. API 시작 전에 이미 존재하던
Task는 소급 발송하지 않으며, 시작 이후 새로 열린 순차 단계부터 처리한다.

`approval_channels: [pxm_user, external_email]`인 Hybrid Task는 별도의 PXM 알림
메일을 만들지 않는다. External Approval Dispatcher가 보내는 한 통의 메일에
이메일 승인 링크와 PXM 결재함 링크를 함께 넣어 중복 발송을 막는다.

## 전달 내용

- 결재 제목
- 요청자
- 단계명 또는 단계 순서
- PXM 결재함 링크
- 외부 요청에 원문 URL이 있는 경우 원문 링크

수신 이메일은 PXM 사용자 프로필의 email을 우선 사용하고, 동적 결재 요청의
승인자 snapshot email을 fallback으로 사용한다. 관리 API와 로그에는 이메일
원문이나 결재 본문을 노출하지 않으며 성공 이력에는 마스킹된 수신자 힌트만
저장한다.

## 멱등성과 취소 억제

`task_id + email`은 발송 레코드의 유일키다. 같은 Task를 Dispatcher가 다시
발견해도 발송 레코드는 하나만 생성된다. 발송 직전에 Task가 여전히 `OPEN`이고
PXM 사용자 전용 채널인지 다시 확인한다. 따라서 ANY 단계에서 다른 승인자가 먼저
처리해 `CANCELED`된 Task나 이미 완료된 Task에는 메일을 보내지 않는다.

다음 순차 단계가 열리면 그때 생성된 새 Task ID로 해당 단계 승인자에게만 새
알림을 보낸다.

## 재시도와 운영

상태는 `PENDING`, `RUNNING`, `SENT`, `FAILED`, `DEAD_LETTER`, `CANCELED`다.
SMTP 오류와 timeout은 30초부터 최대 1시간까지 지수 백오프로 재시도한다.
기본 최대 시도는 5회다.

```text
GET  /api/notifications/deliveries
GET  /api/notifications/deliveries/:id
POST /api/notifications/deliveries/:id/retry
```

최고관리자는 Web의 `승인자 알림` 화면에서 상태와 시도별 오류를 확인하고,
사유를 입력해 실패·DLQ·취소 건을 재발송할 수 있다. 재발송 시에도 Task가
현재 `OPEN`인지 다시 확인하며 조치는 management audit에 남는다.

```text
APPROVAL_NOTIFICATION_POLL_MS=2000
APPROVAL_NOTIFICATION_DISCOVERY_BATCH_SIZE=200
APPROVAL_NOTIFICATION_BATCH_SIZE=20
APPROVAL_NOTIFICATION_MAX_ATTEMPTS=5
APPROVAL_NOTIFICATION_TIMEOUT_MS=10000
PXM_PUBLIC_WEB_URL=https://pxm.example
PXM_SMTP_URL=smtp://...
```
