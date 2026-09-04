# PXM 문서

## 여기부터 읽는다

| 문서 | 내용 |
|---|---|
| [features.md](features.md) | **PXM이 지원하는 기능과 지원하지 않는 기능.** 기능 질문은 여기서 답한다 |
| [roadmap.md](roadmap.md) | 남은 작업과 우선순위. 현재 전제도 여기에 있다 |
| [demo-scenario.md](demo-scenario.md) | 시연 각본. 장면별 화면·설정·예상 질문과 사전 준비 체크리스트 |

기능을 추가하거나 제거하면 `features.md`를 같은 커밋에서 갱신한다.

## 외부 연동

| 문서 | 내용 |
|---|---|
| [public-api-v1.md](public-api-v1.md) | 공개 API `/api/v1` 엔드포인트 목록과 오류 계약 |
| [workflow-api-contract.md](workflow-api-contract.md) | 워크플로우 실행 계약 상세와 배포 수명주기 |
| [api-consumer-demo.md](api-consumer-demo.md) | `apps/api-playground` reference client 사용법 |
| [webhook-delivery.md](webhook-delivery.md) | 결재 결과 Webhook 등록·서명·재전송 |
| [plugin-sdk-guide.md](plugin-sdk-guide.md) | 플러그인 개발 가이드 (hosted / external_http) |

## 결재

| 문서 | 내용 |
|---|---|
| [dynamic-sequential-approval.md](dynamic-sequential-approval.md) | 순차 다단계·복수 승인자·ALL/ANY 결재 |
| [external-approval-email.md](external-approval-email.md) | 계정 없는 외부 승인자의 이메일 + OTP 결재 |
| [approval-notifications.md](approval-notifications.md) | 승인자 알림 발송과 이력 |

## 실행 엔진

| 문서 | 내용 |
|---|---|
| [command-node-execution-model.md](command-node-execution-model.md) | Command 노드 allowlist 실행 모델 |
| [workflow-publish-metadata-repair.md](workflow-publish-metadata-repair.md) | 배포 메타데이터 계약과 보정 절차 |

## 운영

| 문서 | 내용 |
|---|---|
| [production-beta-runbook.md](production-beta-runbook.md) | 온프레미스 배포·백업·복구 절차 |
| [operations-monitoring.md](operations-monitoring.md) | 운영 상태 화면의 판정 기준 |
| [dev-mongo-runbook.md](dev-mongo-runbook.md) | 개발 환경 MongoDB 기동 절차 |

## 프론트엔드

| 문서 | 내용 |
|---|---|
| [ui-ux-handoff.md](ui-ux-handoff.md) | 프론트엔드 정리 인수인계 (진행 중) |
| [ui-components.md](ui-components.md) | 공용 UI 컴포넌트 계약 |
| [dashboard-metrics.md](dashboard-metrics.md) | 대시보드 각 지표의 조회 범위 |

## 테스트

| 문서 | 내용 |
|---|---|
| [dynamic-approval-browser-regression.md](dynamic-approval-browser-regression.md) | 브라우저 회귀 게이트 (`pnpm e2e:browser`) |
| [plugin-platform-test-scenarios.md](plugin-platform-test-scenarios.md) | 플러그인 플랫폼 테스트 시나리오 |
| [session-auth-test-scenario.md](session-auth-test-scenario.md) | 세션 인증 수동 테스트 시나리오 |

## 보관 문서

[old/](old/)에는 시점이 지났거나 현재 전제와 다른 문서를 보관한다.
**현재 상태를 확인할 때 참고하지 않는다.** 사유는 [old/README.md](old/README.md)에 있다.
