# PXM 베타 오픈 체크리스트

체크 결과에는 실행 일시, 담당자 이름, 증빙 링크 또는 명령 결과를 함께 기록한다.

| 구분 | 필수 항목 | 담당 역할 | 현재 증빙/판정 |
|---|---|---|---|
| 기능 | PXM-13 운영 상태·안전 복구 | PXM 개발 | 완료 |
| 기능 | PXM-14 정상 WAITING 분류 | PXM 개발 | 완료 |
| 기능 | PXM-15 승인 알림 이력 | PXM 개발 | 완료 |
| 기능 | PXM-16 외부 사용자 매핑 관리 | PXM 개발 | 완료 |
| 기능 | PXM-17 브라우저 회귀 9개 | PXM 개발 | `pnpm gate:beta` |
| 배포 | HTTPS 인증서와 만료 알림 | 인프라 | 운영 인증서 적용 후 기록 필요 |
| 배포 | MongoDB 인증·internal network·전용 계정 | 인프라 | production compose 구성 완료, 운영 기동 확인 필요 |
| Secret | 기본 관리자 비밀번호 제거 | PXM 운영 | 최초 로그인 변경 증빙 필요 |
| Secret | DB·Credential·외부 결재·SMTP Secret 외부 주입 | 인프라 | Compose secrets 구성 완료, 운영 저장소 확인 필요 |
| 백업 | 암호화 일일 백업과 30일 보존 | 인프라 | 스크립트 완료, 운영 scheduler 증빙 필요 |
| 복구 | 최신 백업 별도 namespace 복원 | PXM 운영 | `pnpm ops:restore:verify` 결과 기록 필요 |
| 복구 | API/Engine 강제 종료 복구와 중복 방지 | PXM 개발 | `pnpm ops:rehearse` |
| 관측 | live/readiness, DB, 디스크, Job·Outbox 경고 | PXM 운영 | API 및 운영 화면 구성 완료 |
| 로그 | Secret 마스킹과 10MiB × 5 회전 | 인프라 | 코드·Compose 구성 완료 |
| 데이터 | 테스트와 운영 DB·메일·계정 분리 | PXM 운영 | 운영 DB/SMTP 값 확인 필요 |
| 대응 | 담당자 실명·비상 연락망·RTO 승인 | 서비스 책임자 | 비공개 Runbook에 기록 필요 |

## 오픈 판정

- 모든 필수 항목에 담당자와 증빙이 있어야 `GO`다.
- 운영 인증서, Secret 저장소, 백업 scheduler, 연락망 중 하나라도 없으면 `NO-GO`다.
- 기능 테스트 성공만으로 운영 오픈을 승인하지 않는다.
- 오픈 직전 `pnpm gate:release`를 실행해 기능·운영 검사를 같은 commit에서 통과시킨다.
