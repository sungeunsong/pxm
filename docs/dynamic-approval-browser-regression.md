# 동적 결재 브라우저 회귀 게이트

PXM-17의 Playwright 회귀 테스트는 운영 데이터와 분리된 환경에서 동적 결재의 브라우저/API/Engine 동작을 함께 검증한다.

## 실행

사전 조건은 Docker다. 테스트 실행기는 다음 자원을 자동으로 만들고 종료한다.

- 전용 PostgreSQL 컨테이너와 고유 DB: 전체 SQL 마이그레이션의 신규 설치 가능 여부 검증
- 전용 MongoDB replica set과 고유 DB: API 및 Engine 회귀 데이터
- 전용 Mailpit: 이메일 결재 링크와 중복 발송 검증
- API `3211`, 웹 `5274`, SMTP `1126`, Mailpit UI/API `8126`, MongoDB `27127`, PostgreSQL `55432`

브라우저 회귀만 실행한다.

```bash
pnpm e2e:browser
```

API·웹 빌드와 Engine 테스트를 포함한 베타 배포 게이트를 실행한다.

```bash
pnpm gate:beta
```

하나라도 실패하면 명령이 0이 아닌 종료 코드를 반환하므로 CI 또는 배포 작업은 `pnpm gate:beta` 성공을 필수 조건으로 사용한다.

## 검증 범위

- 순차 3단계의 전체 결재라인, 현재 단계, 의견 및 최종 1회 재개
- ALL 전원 승인과 ANY 선착 승인·잔여 Task 취소
- 반려 분기의 정상 완료와 `FAILED` 오판 방지
- 운영 종료 시 열린 Task 취소와 늦은 결재 거부
- 일시중지 중 결재 저장, 명시적 재개 전 후속 실행 차단
- 외부 `request_id + revision` 재전송, 충돌, 새 revision
- 매핑 사용자의 PXM 웹 전용·이메일 전용·하이브리드 채널
- 미등록 외부 사용자의 이메일 전용 처리와 PXM 채널 거부
- 하이브리드 웹/이메일 경합의 단일 Task·단일 완료·단일 재개
- `approval_channels`, `completed_via`, 인증 방식 이력과 이메일 중복 방지

## 실패 진단

실패 시 `apps/e2e/test-results/` 아래에 다음 자료가 남는다.

- 실패 화면
- Playwright trace와 비디오
- HTML 리포트
- API, Engine, 웹 서버 로그

성공하면 임시 DB와 컨테이너는 제거되고 서버 로그도 정리된다. 포트나 외부 Mailpit이 필요한 실행 환경에서는 `PXM_E2E_*` 환경 변수로 기본값을 재정의할 수 있다.
