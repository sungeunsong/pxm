# 외부 이메일 승인 설정

Approval 노드의 승인자 유형을 `외부 이메일`로 선택하면 PXM 계정이 없는 승인자에게 일회용 링크를 보낼 수 있다. 링크 원문과 OTP 원문은 DB에 저장하지 않고 SHA-256/HMAC 해시만 저장한다.

## 처리 흐름

1. Engine이 외부 이메일 Approval task를 `OPEN` 상태로 생성한다.
2. API의 메일 디스패처가 task를 선점하고 일회용 토큰을 생성한다.
3. DB에는 토큰 해시와 만료 시각만 저장하고 SMTP로 승인 링크를 발송한다.
4. 승인자는 `/external-approval/{token}`에서 요청 내용을 확인한다.
5. OTP 옵션이 켜져 있으면 6자리 인증번호를 이메일로 받아 확인한다.
6. 승인 또는 반려 시 task 상태 변경, Engine `RESUME` job 생성, 토큰 소비를 같은 DB transaction에서 처리한다.
7. 처리 이메일, 인증 방식, 처리 시각은 management audit에 기록한다.

OTP는 10분 동안 유효하고 60초마다 재발송할 수 있다. 잘못된 OTP를 5회 입력하면 새 OTP를 요청해야 한다. 승인 링크 유효시간은 노드 설정에서 1~168시간으로 지정한다.

## API 환경변수

SMTP를 설정하지 않으면 외부 승인 메일 디스패처는 비활성화되며 PXM 사용자 승인은 계속 동작한다.

```dotenv
# 링크에 사용할 공개 Web 주소. 운영 환경에서는 HTTPS 주소를 지정한다.
PXM_PUBLIC_WEB_URL=https://pxm.example.com

# OTP HMAC 키. 운영 환경에서는 충분히 긴 무작위 secret을 반드시 지정한다.
PXM_EXTERNAL_APPROVAL_SECRET=replace-with-a-random-secret

# SMTP URL을 사용하거나 아래 개별 SMTP 값을 사용한다.
PXM_SMTP_URL=smtps://user:password@smtp.example.com:465
PXM_SMTP_FROM=PXM <no-reply@example.com>

# 개별 SMTP 설정 예시
# SMTP_HOST=smtp.example.com
# SMTP_PORT=587
# SMTP_USER=user
# SMTP_PASSWORD=password
# SMTP_SECURE=false
# SMTP_REQUIRE_TLS=true

# 선택값
# EXTERNAL_APPROVAL_POLL_MS=2000
# EXTERNAL_APPROVAL_BATCH_SIZE=20
```

설정 변경 후 API 프로세스를 재시작한다. SMTP 비밀번호와 외부 승인 secret은 저장소에 커밋하지 않는다.

로컬 개발 환경에서는 `docker compose -f infra/docker-compose.yml up -d mailpit`으로 메일 수신기를 실행한다. API의 `SMTP_HOST=127.0.0.1`, `SMTP_PORT=1025` 설정을 사용하며 수신 메일은 `http://localhost:8025`에서 확인할 수 있다.

## 공개 API

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

공개 API는 PXM 로그인을 요구하지 않는다. 만료되거나 소비된 링크는 `410 Gone`, 잘못된 링크는 `404 Not Found`, 잘못된 OTP는 `401 Unauthorized`, OTP 재발송 제한은 `429 Too Many Requests`를 반환한다.
