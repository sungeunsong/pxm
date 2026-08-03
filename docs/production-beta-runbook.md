# PXM 베타 운영 Runbook

이 문서는 PXM 베타를 단일 운영 서버에 배포하고 백업·복구하는 기준 절차다.
멀티 리전과 완전 무중단 배포는 현재 범위에 포함하지 않는다.

## 확정 운영 구조

- 공개 진입점: Nginx HTTPS `443`만 공개한다. HTTP `80`은 HTTPS로 이동한다.
- 애플리케이션: API가 빌드된 Web 정적 파일을 함께 제공한다.
- 실행기: Engine은 외부 포트를 열지 않고 DB 내부망에만 연결한다.
- 저장소: 베타 운영 프로필은 **MongoDB 7 replica set**으로 고정한다.
- MongoDB: 인증을 활성화하고 Docker internal network에만 둔다. 호스트 포트는 공개하지 않는다.
- Secret: Compose secret 파일로 주입하며 이미지, Git, 일반 환경 파일에 저장하지 않는다.

현재 자격증명·명령·감사 하위 시스템 일부가 MongoDB를 직접 사용하므로 PostgreSQL은
베타 운영 저장소로 선택하지 않는다. PostgreSQL 전환은 해당 직접 의존성을 제거하고
전체 회귀 테스트를 통과한 뒤 별도 결정한다.

## 최초 배포

담당: PXM 운영 담당자, 인프라 담당자

1. `infra/production/.env.production.example`을 `.env.production`으로 복사한다.
2. 실제 도메인, CORS origin, 디스크 임계값과 세션 정책을 입력한다.
3. `infra/production/secrets/README.md`에 명시된 Secret 파일을 권한 `0600`으로 생성한다.
4. TLS 인증서는 공인 인증기관에서 발급받아 `tls_cert.pem`, `tls_key.pem`으로 둔다.
5. `pnpm gate:release`를 통과시킨다.
6. `docker compose -f infra/production/docker-compose.yml build --pull`을 실행한다.
7. `docker compose -f infra/production/docker-compose.yml up -d mongodb` 후 healthy를 확인한다.
8. API, Engine, Proxy 순으로 올린다.
9. `https://<domain>/api/health/live`와 `/api/health/ready`가 200인지 확인한다.
10. 최초 관리자 로그인 직후 비밀번호를 변경하고 다른 로그인 세션이 없는지 확인한다.

운영 모드 API는 다음 조건이 하나라도 맞지 않으면 기동을 거부한다.

- 인증된 MongoDB URL
- 32자 이상의 Credential 및 외부 결재 Secret
- 16자 이상의 비기본 bootstrap 관리자 비밀번호
- HTTPS 공개 URL
- 명시적인 reverse proxy 신뢰 범위
- SMTP 사용 시 TLS와 SMTP 비밀번호

## 배포와 재시작 순서

허용 중단 시간은 베타 기준 10분, 목표 복구 시간(RTO)은 60분이다.

1. 배포 전 암호화 백업과 복원 검증을 완료한다.
2. `pnpm gate:release`를 통과한다.
3. 새 이미지를 빌드한다.
4. API를 교체하고 readiness를 확인한다.
5. Engine을 교체한다. 시작 시 stale `RUNNING` Job과 만료 lease를 자동 회수한다.
6. Proxy 설정을 검사한 뒤 reload 또는 교체한다.
7. 운영 상태 화면에서 FAILED Job, 만료 잠금, Outbox/DLQ를 확인한다.

MongoDB는 애플리케이션 배포 중 재시작하지 않는다. DB 재시작이 필요하면 먼저 API와
Engine을 중지하고 MongoDB 정상화 후 API, Engine 순서로 시작한다.

## 백업 정책

- 주기: 매일 02:00 KST, 큰 변경 및 배포 직전 추가 실행
- RPO: 최대 24시간
- 보존: 일별 30일, 월말본 12개월은 별도 스토리지에서 관리
- 암호화: `age` 공개키 암호화 필수
- 저장: 운영 호스트와 다른 계정·스토리지에 복제하고 삭제 권한을 분리
- 무결성: 각 백업의 SHA-256 파일을 함께 보관

```bash
PXM_BACKUP_AGE_RECIPIENT=age1... \
PXM_BACKUP_DIR=/var/backups/pxm \
pnpm ops:backup
```

평문 백업은 허용하지 않는다. 백업 명령은 MongoDB root Secret을 컨테이너 내부에서만
읽고, 호스트에는 암호화된 archive만 생성한다.

## 복원 검증

매월 1회 및 스키마 변경 배포 전에 최신 백업을 별도 DB namespace로 복원한다.
검증용 DB는 성공·실패와 관계없이 자동 삭제된다.

```bash
PXM_BACKUP_AGE_IDENTITY=/secure/pxm-backup-key.txt \
PXM_RESTORE_MIN_WORKFLOWS=1 \
pnpm ops:restore:verify -- /var/backups/pxm/<backup>.archive.gz.age
```

복원 후 최소 한 개 이상의 워크플로우 정의가 조회돼야 성공이다. 운영 데이터베이스에
`--drop` 복원하지 않는다. 실제 재해 복구는 새 MongoDB 환경에 먼저 복원하고 검증 후
애플리케이션의 `mongodb_url` Secret을 교체한다.

## 장애 판단과 대응

| 신호 | 판단 기준 | 1차 대응 | 담당 |
|---|---|---|---|
| Readiness 실패 | DB 연결 실패 또는 디스크 임계값 미만 | 배포 중단, DB·디스크 확인 | 인프라 담당자 |
| FAILED Job | 1건 이상 | 원인 확인 후 운영 화면에서 조건부 재시도 | PXM 운영 담당자 |
| QUEUED 적체 | 가장 오래된 Job 5분 이상 | Engine 상태·DB latency 확인 | PXM 운영 담당자 |
| Outbox/DLQ | FAILED 또는 DEAD_LETTER 1건 이상 | Endpoint 확인 후 사유를 남기고 재전송 | 연동 담당자 |
| 의심 WAITING | 재개 근거 없이 60분 이상 | trace·Task·Job 확인, 임의 DB 수정 금지 | PXM 운영 담당자 |
| 디스크 부족 | 5GiB 미만 또는 15% 미만 | 로그/백업 보존 확인, 용량 증설 | 인프라 담당자 |

장애 시각, 영향 사용자·워크플로우, 판단 근거, 수행 명령과 복구 시각을 이슈 또는
장애 기록에 남긴다. 담당자의 실제 이름과 비상 연락 수단은 운영 서버에 배포하는
비공개 Runbook 사본에 반드시 채운다.

## 로그와 민감정보

- Docker 로그는 서비스별 10MiB × 5개로 회전한다.
- 운영 보존 기간은 애플리케이션 30일, 보안·관리 감사 90일을 기본으로 한다.
- 워크플로우 export, trace, result, command output은 Secret key를 마스킹한다.
- 비밀번호, SMTP Secret, Webhook Secret, MongoDB URL 전체를 이슈나 채팅에 붙이지 않는다.
- 민감 결재 본문은 장애 분석에 필요한 최소 범위만 접근하고 외부 로그 수집기로 전송하지 않는다.

## 격리 리허설

다음 명령은 운영 데이터를 사용하지 않고 임시 MongoDB 두 개를 생성하여 실제
`mongodump`/`mongorestore`와 API·Engine 강제 종료 복구를 검증한다.

```bash
pnpm gate:operations
```

성공 기준은 백업 복원 1회, API 강제 종료 후 재기동 1회, Engine 강제 종료·재기동
2회, 중복 event/log 증가 없음이다. 모든 임시 컨테이너와 DB는 종료 시 제거된다.
