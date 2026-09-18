# PXM 반복 실습 준비

2026-09-07, PXM-37. 기존 업무 데이터와 분리된 `데모 · 보안운영팀`에서 연습한다.
웹·API·MongoDB·Engine을 먼저 실행한다. 기본 실행법은 `CLAUDE.md`를 참고한다.

## 준비 명령

```bash
pnpm demo:seed
pnpm demo:service
pnpm dev:api-playground
```

`demo:service`는 별도 터미널에서 계속 실행한다. `http://127.0.0.1:3020`의 **모의 접근제어 서비스**이며 실제 시스템 권한을 바꾸지 않는다. 다른 프로세스가 3020을 쓰면 종료시키지 말고 `PXM_DEMO_SERVICE_PORT`와 seed의 `PXM_DEMO_SERVICE_URL`을 같은 포트로 맞춘다.

seed는 그룹, 사용자 5명, 자격증명 2개, 직원 샘플 3건, 외부 승인자 매핑, 결과 Webhook Endpoint, 승인된 `lodash@4.17.21`, 배포된 워크플로우 9개와 입력 프리셋, 서비스 계정 1개와 최소 권한 API Key 2개를 준비한다. 같은 데이터는 다시 만들거나 버전을 올리지 않는다. 데모 워크플로우를 편집했다면 기준 그래프로 복구하며 새 버전으로 배포한다. `실습 5 · 디자이너와 배포 수명주기`는 저장·배포 연습 뒤 reset으로 복구하는 전용 데이터다.

## 접속과 계정

- 콘솔: http://localhost:5174
- 외부 API Playground: http://localhost:5175
- 외부 승인 메일함: http://localhost:8025 (Mailpit)
- 최고관리자: 기존 `admin` 계정을 그대로 사용
- 그룹관리자: `demo-secadmin`
- 내부 승인자: `demo-approver1`
- 공동 승인자: `demo-approver2`
- 대리 결재자: `demo-delegate1`
- 신청자: `demo-requester1`

데모 계정 비밀번호와 데모 API Key 원문은 저장소 루트의 `.env.demo-access.json`에 보관한다. 파일은 git에서 제외되며 권한은 0600이다. 기존 `secadmin`·`approver1`·`requester1`을 덮어쓰지 않기 위해 접두사를 사용한다. seed는 다섯 계정의 로그인을 확인하며, API Key는 데모 전용 서비스 계정·사용자에만 발급하고 허용 워크플로우를 실습 1로 제한한다.

## 실습 1 — 기본 결재

1. `demo-requester1`로 로그인한다.
2. **요청하기**에서 `실습 1 · 기본 접근 권한 결재`를 선택한다.
3. 사번 `E-1001`, 권한 `read`, 대상 시스템 `개발 포털`을 입력하고 요청한다.
4. 내 요청에서 승인 대기 상태를 확인한다.
5. 별도 브라우저 프로필 또는 로그아웃 후 `demo-approver1`로 로그인한다.
6. 내 결재함에서 신청 내용을 보고 승인한다.
7. 신청자 화면에서 완료를 확인한다. 새 신청 한 건을 만들어 이번에는 반려한다.

워크플로우는 업무 설계도, 인스턴스는 신청 한 건, 결재 태스크는 사람이 처리할 일이다. 승인과 반려 모두 흐름은 종료될 수 있으므로 완료 상태뿐 아니라 결재 결과와 도착한 종료 노드를 확인한다.

## 실습 2 — 조회·분기·연동

`실습 2 · 협력사 접근 권한 신청`을 사용한다. 관리자 실행 화면에서는 저장된 프리셋을 적용할 수 있다. 신청자 화면에서 프리셋 선택이 없으면 아래 값을 직접 입력한다.

| 프리셋 | 사번 | 권한 | 대상 시스템 | 예상 경로 |
|---|---|---|---|---|
| `demo-auto` | E-1001 | read | 개발 포털 | 직원 조회 → 위험도 AUTO → 모의 권한 반영 → 완료 |
| `demo-review` | E-2001 | admin | 개발 포털 | 직원 조회 → REVIEW → 내부 승인 → 외부 이메일 승인 → 모의 권한 반영 |

고위험 요청을 내부에서 반려하면 권한 반영 노드에 도달하지 않는다. 승인하면 Mailpit의 `partner-approver@pxm.local` 수신 메일에서 링크를 열고 OTP를 요청해 승인한다. 외부 결재 이메일과 OTP에는 API의 SMTP 설정과 Mailpit 기동이 필요하다. SMTP 설정을 임의로 바꾸는 기능은 seed에 없다.

직원 샘플은 같은 개발 DB의 전용 `pxm_demo_employees` 컬렉션에 있다. 계산 결과는 `data.outputs.risk`에 저장하고 `data.outputs.risk.level == AUTO`로 분기한다(PXM-42). 마지막 HTTP 응답의 `simulated: true`, `granted: true`, 신청 사번을 확인한다.

## 실습 3 — 대리 결재와 기한 알림

seed가 `demo-approver1`의 `실습 3 · 대리 결재와 기한 알림` 결재를 `demo-delegate1`에게 위임해 둔다. 기존 미결 결재도 포함하며 만료 시각은 2099년 말이다.

이 실습은 발표 필수 장면이다. `demo:reset` → `demo:seed`를 실행하면 전용 위임, 1분 독촉, 추가 1분 상위 알림 설정과 이전 실행·알림 이력이 초기화된다.

1. `demo-requester1`로 로그인해 **요청하기**에서 `실습 3 · 대리 결재와 기한 알림`을 실행한다.
2. 입력은 사번 `E-1001`, 권한 `read`, 대상 시스템 `개발 포털`을 사용한다.
3. `demo-approver1`로 로그인한다. 위임 기간 중이므로 새 결재가 원래 승인자의 결재함에 보이지 않는지 확인한다.
4. `demo-delegate1`로 로그인한다. 같은 결재가 `대리 결재` 배지와 원래 승인자 정보와 함께 보이는지 확인한다.
5. 1분 이상 처리하지 않고 기다려 승인자 알림 또는 Mailpit의 기한 독촉을 확인한다. 상위 알림 유예 시간도 1분이므로 다시 1분 뒤 그룹 관리자 알림 대상이 된다.
6. 대리 결재자가 승인하고 신청자 화면에서 워크플로우 완료를 확인한다.

1분은 현재 Approval 노드가 허용하는 최소 처리 기한이다. 이 위임은 해당 실습 워크플로우 하나에만 적용되므로 다른 데모 결재 동선에는 영향을 주지 않는다.
기한 독촉은 `demo-delegate1@pxm.local`, 상위 알림은 `demo-secadmin@pxm.local`로 발송되며 Mailpit에서 확인할 수 있다.

## 실습 4 — 승인된 JS 라이브러리

`admin`으로 **플랫폼 설정 → JS 라이브러리**에서 `lodash@4.17.21`의 승인 상태와 사용 범위를 확인한다. 실제 설계와 실행은 `demo-secadmin` 또는 실행 전용 `demo-requester1`을 사용한다.

1. `demo-secadmin`으로 로그인해 **워크플로우 설계**에서 `실습 4 · 승인된 JS 라이브러리 사용`을 연다.
2. `lodash로 숫자 집계` JS 노드를 선택해 `lodash@4.17.21`이 연결돼 있고 코드가 `libs['lodash']`를 사용하는지 확인한다.
3. 저장된 `lodash 숫자 집계` 프리셋으로 실행하거나 `demo-requester1`의 **요청하기**에서 같은 워크플로우를 실행한다.
4. 입력값 `12, 7, 12, 30, 7`의 결과가 개수 5, 중복 제거 `[12, 7, 30]`, 정렬 `[7, 12, 30]`, 합계 68인지 확인한다.

등록 절차 자체를 보여주려면 `admin`으로 다른 패키지명을 입력한 뒤 **최신 버전**을 눌러 정확한 버전이 채워지는 데까지만 시연한다. **준비**를 누르면 실제 다운로드와 검증을 수행하므로 발표 환경의 npm 레지스트리 연결 상태를 먼저 확인한다.

## 실습 5 — 디자이너와 배포 수명주기

`demo-secadmin`으로 전용 워크플로우를 열어 빠른 노드 추가, 자동 정렬과 되돌리기, 캔버스 넓게 보기, 저장 후 미배포 표시, 버전 비교와 배포를 연습한다. 노드는 일부러 고르지 않게 배치돼 있다. 저장·배포로 버전이 올라가도 다음 `demo:reset`이 기준 그래프를 새 버전으로 복구하고 배포한다.

## 실습 6 — 다단계 공동 결재

프리셋 `공동 결재 데모 요청`으로 실행한다. 1단계는 `demo-approver1`과 `demo-approver2`가 모두 승인해야 하는 ALL 단계이고, 2단계는 PXM 웹과 이메일을 함께 쓰는 `demo-secadmin` Task와 외부 메일 승인자 중 한 명만 처리하면 되는 ANY 단계다. 최종 결과는 `pxm-demo-hr` Provider의 `데모 · 결재 결과 수신` Endpoint를 통해 `demo:service`의 `/webhook`으로 전달된다.

이 실습도 발표 필수 장면이다. 첫 승인자에서 보류 이력을 남기고, 실행 모니터링에서 일시중지·재개한 뒤 `ALL → ANY`를 끝내고 결과 Webhook HTTP 200까지 확인한다. `demo:reset` → `demo:seed`는 이전 실행·Task·Webhook 전송 이력을 정리하고 Endpoint를 다시 활성화한다.

같은 외부 요청 번호를 진행 중인 상태로 다시 실행하지 않는다. 반복할 때는 번호를 바꾸거나 기존 실행을 완료한 뒤 `demo:reset`을 실행한다. 상세 발표 동선은 루트의 `시연.md`를 따른다.

## 실습 7 — 명령 실행 터미널

`실습 7 · 명령 실행 터미널`은 관리자 허용 목록에 있는 `builtin.echo`만 실행한다. 실행 패널에서 `PXM demo command completed` 표준 출력, 종료 코드 `0`, 소요 시간을 확인한다.

## 실습 9 — SSH 원격 명령

`실습 9 · SSH 원격 명령 실행`은 원격 명령 실습용 샘플 워크플로우다. `hostname && uname -sr && ls -1 <경로> | wc -l`을 실행하고, 시작 폼의 `확인할 원격 경로`(기본 `/tmp`)가 `{{formData.target_path}}`로 전달된다. 후속 JS 노드가 stdout을 `{ hostname, kernel, entryCount, exitCode }`로 구조화한다.

**이 워크플로우는 그룹에 SSH 자격증명이 있을 때만 만들어진다.** 접속 대상이 환경마다 다르므로 seed는 자격증명을 만들지 않는다. 연동 자격증명에서 Type `SSH`로 접속 정보를 등록하고(**서버 키 가져오기**로 Host Key 지문을 채운다) `pnpm demo:seed`를 실행하면, 그룹의 첫 번째 활성 SSH 자격증명을 연결해 배포한다. 자격증명이 없으면 경고만 남기고 실습 9를 건너뛴다.

## API 실행·결재 실습

`.env.demo-access.json`의 `api_keys.trigger.api_key`를 API Playground에 입력해 실습 1을 실행한다. 이 키는 서비스 계정 소유이며 `workflow:read`, `workflow:execute`만 가진다. 결재 대기 Task가 생기면 연결을 끊고 `api_keys.approver.api_key`로 다시 연결해 OPEN 이력과 상세를 조회한 뒤 승인한다. 결재 키는 `demo-approver1` 사용자 소유이며 `task:approve`를 가진다. 마지막으로 실행 키로 결과가 `COMPLETED`인지 확인한다.

두 키 모두 실습 1만 허용한다. 관리자 화면에서는 키 소유자·발급자·scope·허용 워크플로우와 API 사용 이력의 Business Actor, Endpoint, 상태 코드를 함께 확인한다. 전체 발표 동선과 입력 JSON은 루트의 `시연.md`를 따른다.

## 검증 및 초기화

```bash
pnpm demo:verify
pnpm demo:check
pnpm demo:reset
```

발표 직전에는 `demo:verify` 하나를 실행한다. 전용 PostgreSQL·MongoDB·Mailpit과 별도 API·Engine·Web·모의 접근제어 서비스를 자동으로 띄우고 `reset` → `seed` → 백엔드 시나리오 → 브라우저 발표 동선을 순서대로 검증한 뒤 정리한다. 기본 결재 승인/반려, 종합 시연의 자동 처리·내부 반려·외부 OTP 승인, 다단계 결재·Webhook, 허용 명령 실행, API 실행→상태 조회→API 승인→결과 조회까지 검사한다. 기존 개발 DB와 현재 실행 중인 서버 데이터는 건드리지 않는다.

실패 화면, trace, 비디오, 로그는 `apps/e2e/test-results/`에 남는다. `demo:verify`가 통과한 뒤 실제 발표 환경에는 `demo:reset`, `demo:seed`를 차례로 실행하고 `demo:service`를 유지한다.

`demo:check`는 현재 실행 중인 실제 API·Engine·Mailpit으로 같은 백엔드 경로를 확인한다. 실행 이력이 남는다.

reset은 등록된 데모 워크플로우의 **종료된 실행**과 연결된 결재·이벤트·알림·Webhook 전송 이력을 정리하고 seed를 다시 수행한다. 진행 중 실행이 있으면 삭제하지 않고 중단한다. 콘솔에서 완료 또는 종료 처리한 뒤 다시 실행한다. 초기화 중에는 새 데모 실행을 시작하지 않는다.

기존 그룹·워크플로우, 직접 복제한 실습, 전역 카운터·전송 커서·관리 감사 이력과 Mailpit 메일은 보존한다. Mailpit에서는 가장 최근 요청 메일을 선택한다. 전체 DB 초기화나 기존 계정 비밀번호 변경은 하지 않는다.

기본 대상은 loopback API `3011`과 로컬 MongoDB의 `pxm_db`이다. 분리 검증에는 `API_BASE_URL`, `MONGODB_URL`, `MONGO_DB_NAME=pxm_demo...`, `PXM_DEMO_ACCESS_FILE`을 사용할 수 있다. 운영 모드, 원격 주소, 허용 범위 밖 DB는 거부한다.

명령이 강제로 중단되어 실행 잠금이 남으면 먼저 다른 demo 명령이 실행 중인지 확인한다. 실행 중이 아니라는 것을 확인한 뒤 해당 개발 DB의 `pxm_demo_manifests`에서 `_id: pxm-guided-demo-v1`의 `busy` 필드만 해제하고 다시 실행한다.
