# PXM 지원 기능

PXM이 **현재 코드에서 실제로 지원하는 기능**과 **지원하지 않는 기능**을 한 문서에 정리한다.
"만들 계획"이 아니라 "지금 동작하는 것"만 지원으로 표기하며, 각 항목에는 확인할 수 있는
코드 또는 문서 위치를 함께 남긴다. 기능을 추가하거나 제거하면 이 문서를 같은 커밋에서 갱신한다.

- 남은 작업과 우선순위: `docs/roadmap.md`
- 외부 공개 API 계약: `docs/public-api-v1.md`
- 문서 전체 목록: `docs/README.md`

## PXM이 무엇인가

DB를 단일 진실 원본으로 사용하는 워크플로우/결재 실행 엔진이다. 워크플로우를 그래프로 설계하고,
토큰 기반으로 실행하며, 사람의 승인과 외부 시스템 연동을 같은 그래프 안에서 처리한다.

```
Web(설계·운영 콘솔)  ─┐
                      ├─→ API/BFF ─→ DB(MongoDB 우선) ←─ Engine(Rust, 워크플로우 실행)
외부 시스템(API Key) ─┘                                        └─→ Plugin Host / 외부 HTTP
```

사용 방식은 두 가지이며 **같은 엔진과 같은 데이터 경로**를 쓴다.

1. **콘솔 사용**: 사람이 Web에 로그인해 설계·실행·운영한다.
2. **API 사용**: 외부 시스템이 API Key로 `/api/v1`을 호출한다.

## 실행 구조

| 구성 | 역할 | 위치 |
|---|---|---|
| API (NestJS) | REST + SSE, 결재 처리, 트리거, 운영 API | `apps/api` |
| Engine (Rust) | Job 획득, 토큰 전이, 노드 실행, 재시도, 타이머 | `apps/engine` |
| Web (React) | 설계·운영 콘솔 및 결재 화면 | `apps/web` |
| Plugin Host | hosted 플러그인 실행 | `apps/plugin-host` |
| api-playground | 외부 소비자 관점 reference client | `apps/api-playground` |

기본 런타임 DB는 MongoDB이며 PostgreSQL 어댑터도 있다 (`apps/api/src/db/adapters/`).

---

# 1. 워크플로우 모델링

## 지원 노드

디자이너에서는 좌측 팔레트 드래그 앤 드롭 외에도 빈 캔버스 더블클릭, 캔버스 메뉴의
`노드 추가…`, `Tab`으로 기본 노드와 플러그인을 함께 검색해 현재 위치에 추가할 수 있다.
연결선 메뉴의 `사이에 노드 추가…`는 기존 연결을 두 개로 나누며, 분기 조건과 라벨은
원래 출발 노드 쪽 연결에 유지한다. 실행 추적 중에는 이 편집 기능을 제공하지 않는다.

Engine의 노드 디스패치(`apps/engine/src/v2/runtime.rs`)가 처리하는 전체 목록이다.

| 노드 | 설명 | BPMN 대응 |
|---|---|---|
| `start` | 프로세스 시작점 | Start Event |
| `gateway` | 조건 분기·병합 | Gateway |
| `approval` | 사람의 승인/반려 | User Task |
| `service` | 플러그인 기반 시스템 연동 | Service Task |
| `script` | 샌드박스 JavaScript 실행 | Script Task |
| `command` | 등록된 실행 파일/원격 명령 실행 | Service Task 확장 |
| `timer` | 지정 시간 대기 후 재개 | Timer Event |
| `workflow_call` | 다른 워크플로우 호출 | Call Activity |
| `end` | 프로세스 종료 | End Event |

## 게이트웨이

`gatewayType` 설정값으로 세 가지를 지원한다 (`runtime.rs`의 `gateway_type`).

- `exclusive`(기본, `and` 아님): 조건을 만족하는 첫 경로 하나만 선택. `is_default` 엣지 지원
- `parallel` / `and`: 모든 출력 경로로 토큰 분기, 입력이 여럿이면 전부 도착할 때까지 조인 대기
- `inclusive` / `or`: 조건을 만족하는 모든 경로로 분기

## 데이터 전달

- 인스턴스 컨텍스트는 `data.formData`(요청 입력)와 `data.outputs`(노드 산출)로 나뉜다
- 각 노드는 `outputPath`로 결과를 컨텍스트에 기록하고, 이후 노드가 이를 읽는다
- `outputPath`를 `formData.x`로 지정하면 `data.formData.x`에, 그 외에는 `data.outputs.x`에 기록된다
  (`normalize_context_write_path`)

### 게이트웨이 조건과 데이터 경로

조건식은 `경로 연산자 값` 한 줄이다. 단일 필드명은 기존과 같이 신청 입력의 최상위 값을 읽고,
점으로 구분된 경로는 노드 설정과 같은 컨텍스트 resolver로 읽는다.

| 조건 예시 | 읽는 값 |
|---|---|
| `amount >= 1000` | `data.formData.amount` (기존 방식 유지) |
| `formData.applicant.level > 2` | 중첩 신청 입력 |
| `data.outputs.risk.score >= 50` | 앞 노드가 저장한 계산 결과 |
| `context.data.outputs.risk.level == REVIEW` | 명시적 컨텍스트 경로 |

일반적으로 입력은 `formData.*`, 노드 결과는 `data.outputs.*`를 명시하면 혼동이 없다.
단일 필드가 입력에 없다고 노드 산출물로 대체하지 않는다. 기존 조건의 분기 의미를 유지한다.
`risk.score`처럼 출처를 생략한 중첩 경로는 문법 오류로 처리한다.

- 연산자는 `==`, `!=`, `>=`, `<=`, `>`, `<`
- 동등 비교는 문자열·숫자·불리언·null, 대소 비교는 숫자를 지원한다
- 공백이나 연산자가 포함된 문자열 값은 따옴표로 감싼다
- 없는 경로 또는 타입 불일치는 거짓이다 (`!=`에서도 동일)
- 출처를 생략한 중첩 경로(`risk.score`), 빈 경로 구간(`a..b`), 배열 인덱스 표기(`rows[0]`),
  `&&`·`||`·괄호 등 복합식은 지원하지 않는다
- 문법 오류는 노드 실패로 처리하며 기본 경로로 조용히 넘기지 않는다

복잡한 판정은 JS 노드에서 계산하고 결과 경로로 분기한다. `outputPath: risk`에
`{ level: "AUTO", score: 0 }`를 저장하면 `data.outputs.risk.level == AUTO`로 읽을 수 있다.

## 워크플로우 수명주기

`DRAFT → PUBLISHED → DISABLED` 및 버전 롤백을 지원한다. 상세는 `docs/workflow-api-contract.md`.

- 외부 실행·API Key·스케줄·DB Watch·Workflow Call은 **배포된 버전만** 실행한다
- 이미 시작한 인스턴스는 시작 시점 버전의 그래프를 계속 사용한다
- 배포 메타데이터 계약과 보정 절차는 `docs/workflow-publish-metadata-repair.md`

---

# 2. 결재 (Approval)

PXM의 가장 깊게 구현된 영역이다. 상세는 `docs/dynamic-sequential-approval.md`.

| 기능 | 지원 |
|---|---|
| 순차 다단계 결재 | ✅ 실행 요청으로 결재라인을 전달하면 하나의 Approval 노드가 여러 단계로 전개된다 |
| 단계별 복수 승인자 | ✅ |
| ALL / ANY 조건 | ✅ 단계별로 전원 승인 또는 1인 승인 선택 |
| 반려 · 취소 · 보류 | ✅ |
| PXM 계정 승인자 | ✅ 결재함 화면 및 `POST /api/v1/tasks/:id/complete` |
| 외부 이메일 승인자 | ✅ 계정 없는 승인자에게 일회용 링크 + OTP (`docs/external-approval-email.md`) |
| Hybrid 채널 | ✅ 한 Task를 PXM 결재함과 이메일 양쪽으로 처리 가능, 메일 중복 발송 방지 |
| 승인자 알림 메일 | ✅ 발송 이력 조회 포함 (`docs/approval-notifications.md`) |
| 승인 처리 기한 / 상위 알림 | ✅ 노드별 기한과 유예 시간, 승인자 독촉 후 그룹 관리자 알림 (`docs/approval-notifications.md`) |
| 결재 이력 조회 | ✅ `GET /api/v1/tasks/history` |

토큰 전이 정책: 중간 단계 승인은 워크플로우 토큰을 움직이지 않고, 마지막 단계 승인 또는
어느 단계의 반려에서만 Engine에 `RESUME`을 한 번 등록한다.

**지원하지 않음**: 승인자 자동 위임·대결(代決), 관리자 수동 재배정, claim/unclaim.
자세한 이유와 우선순위는 `docs/roadmap.md` 참고.

---

# 3. 외부 시스템 연동

## 플러그인

Service 노드는 `plugin_id`로 executor를 선택한다. 상세는 `docs/plugin-sdk-guide.md`.

| 유형 | 실행 위치 |
|---|---|
| `builtin` | Engine 내장. 현재 `builtin.http_request`, `builtin.ssh`, `connector.db.mongodb.query` |
| `hosted` | `apps/plugin-host` 안에서 실행 |
| `external_http` | 별도 HTTP 서비스로 분리 실행 |
| `mock` | 개발·스모크 테스트 전용 |

Plugin Registry는 hot reload를 지원하며, 콘솔에서 플러그인별 사용 통제와 감사 로그를 제공한다.

## 내장 커넥터의 현재 제한

| 플러그인 | 반환값 | 제한 |
|---|---|---|
| `builtin.http_request` | `status_code`, `ok`, `headers`, `body` | 응답 본문이 상한(기본 256KB)을 넘으면 잘라서 저장하고 `body_truncated`, `body_bytes`를 함께 남긴다. 상한은 `HTTP_RESPONSE_BODY_LIMIT_BYTES`로 조정한다 |
| `connector.db.mongodb.query` | `rows`, `row_count`, `database`, `operation` | 읽기 전용. `find`/`findOne`만 지원하며 insert·update·aggregate 없음. **MongoDB 전용**이며 다른 DBMS는 `hosted`/`external_http` 플러그인으로 만들어야 한다 |
| `builtin.ssh` | `exit_code`, `stdout`, `stderr`, `duration_ms` | Credential Store의 `ssh` 자격증명 필요 |

`hosted`와 `external_http` 플러그인은 응답 본문의 `output`을 그대로 컨텍스트에 반환한다.

HTTP 노드의 반환 구조는 디자이너의 "노드 테스트" 결과와 동일하다. 테스트에서 본 모양과
실제 실행 결과가 달라지면 안 되므로 두 경로가 같은 계약을 사용한다.
`content-type`이 JSON일 때만 본문을 파싱하고, 파싱에 실패하면 원문 문자열을 유지한다.
2xx가 아닌 응답은 노드 실패로 처리되어 재시도 정책을 탄다.

## 노드 설정에서 실행 데이터 참조

Service 노드 설정 값에 `{{ 경로 }}`로 인스턴스 컨텍스트를 참조할 수 있다.

```json
{ "filter": { "emp_id": "{{formData.emp_id}}" },
  "body":   { "message": "grant {{formData.emp_id}} -> {{formData.privilege_level}}" } }
```

| 규칙 | 동작 |
|---|---|
| 문자열 전체가 참조 하나 | **값의 타입을 보존한다.** 숫자·불리언·객체·배열이 그대로 들어간다 |
| 문자열 안에 섞인 참조 | 스칼라만 허용한다. 객체·배열은 오류 |
| 경로가 없음 | **노드 실패.** 빈 값으로 흘리면 조건 없는 조회나 잘못된 호출이 된다 |
| 스칼라 길이 | 4096바이트 초과 시 오류 |
| `plugin_id`, `credential_id`, `secrets` | 치환하지 않는다 |

`{{ }}` 없는 설정은 그대로 유지되므로 기존 워크플로우는 영향받지 않는다.

### URL은 규칙이 다르다

`builtin.http_request`의 `url`에 넣은 값은 **퍼센트 인코딩**되고,
**scheme과 host는 정적이어야 한다.**

```text
http://acl.local/grant/{{formData.emp_id}}   ✅
http://{{formData.host}}/grant               ❌ 오류
{{formData.url}}                             ❌ 오류
```

호스트를 실행 데이터로 만들 수 있으면 신청자가 내부망 주소를 주입할 수 있다(SSRF).
값 인코딩만으로는 막을 수 없어 origin 자체를 설계 시점에 고정한다.

### 치환 순서

`secret://`·`env://` 참조를 먼저 풀고 → 실행 데이터를 치환하고 → 자격증명을 주입한다.
사용자 입력에 담긴 `secret://`가 비밀값으로 해석되지 않고, 자격증명은 치환 대상이 되지 않는다.

**게이트웨이 조건식**은 `{{ }}` 없이 `data.outputs.risk.score >= 50`처럼 경로를 직접 사용한다.

## 자격증명 주입

노드 설정에 `credential_id`만 두면 Engine이 실행 시점에 워크플로우 그룹 권한을 확인한 뒤 주입한다.
플러그인별로 주입 대상 설정 키가 정해져 있다.

| 플러그인 | 주입되는 키 |
|---|---|
| `builtin.http_request` | `authorization_header` |
| `connector.db.mongodb.query` | `connection_uri` |
| `builtin.ssh` | `ssh_credential` |

워크플로우에 소유 그룹이 지정되지 않으면 자격증명을 사용할 수 없다.

## Script 노드 (JavaScript)

`node:vm` 컨텍스트에서 실행하며 **기본 차단이 적용되어 있다**.

- 주입되는 전역은 `input`, `context`, `console` 세 개뿐
- `require`, `process` 미제공. `eval`과 `Function` 생성자는 `codeGeneration: false`로 차단
- timeout 기본 1000ms (50~5000ms 범위), console 출력 200줄 / 64KB 제한

**제한**: 메모리 상한과 출력 크기 상한은 아직 없다. 다른 언어(Python 등)는 지원하지 않는다.

## Command 노드

임의 shell 실행을 제공하지 않는다. `command_id` 기반 allowlist registry만 실행하며 shell 문자열이 아닌
`Command::new(executable).args(...)` 형태로만 호출한다. 원격 실행은 SSH Credential을 사용한다.
상세는 `docs/command-node-execution-model.md`.

## Credential Store

AES-256-GCM으로 암호화 저장하며 원문은 다시 조회할 수 없다. 지원 유형: `api_key`, `basic_auth`,
`bearer_token`, `connection_string`, `ssh`, `custom`. 사용 이력은 감사 로그에 남는다.

---

# 4. 실행 트리거

| 트리거 | 설명 |
|---|---|
| API 호출 | `POST /api/v1/templates/:id/execute` (별칭 `/start`) |
| 콘솔 수동 실행 | 관리자가 콘솔에서 즉시 실행 |
| 스케줄 | `interval`(초 단위) 또는 `cron` 표현식 |
| DB Watch | MongoDB `change_stream` 또는 `polling` 모드로 데이터 변경 시 실행 |
| Workflow Call | 다른 워크플로우가 하위 워크플로우로 호출 |

## 실행 모드

- **비동기(기본)**: 인스턴스 ID를 즉시 반환하고 결과는 조회·SSE·Webhook으로 받는다
- **동기(`mode: "sync"`)**: 완료까지 대기하고 결과를 인라인 반환한다

## 결과 수신

- `GET /api/v1/instances/:id/result` 조회
- `GET /api/v1/instances/:id/stream` SSE 실시간 스트림
- 결과 Webhook: 서명 포함, 실패 시 재시도 및 수동 재전송 (`docs/webhook-delivery.md`)

---

# 5. 신뢰성과 운영

이 영역이 PXM의 실질적 강점이다.

| 기능 | 내용 |
|---|---|
| 재시도 | Exponential backoff + jitter. 노드별 `max_attempts` 재정의 가능 |
| 분산 실행 안전성 | `FOR UPDATE SKIP LOCKED` job 획득 + advisory lock + lease + heartbeat |
| 멱등성 | `Idempotency-Key` 재전송 시 같은 `instance_id` 반환. 인스턴스 명령에도 적용 |
| 이벤트 로그 | Outbox append-only. 모든 상태 전이가 기록되며 SSE로 전달 |
| 실행 추적 | `GET /api/v1/instances/:id/trace` 및 콘솔의 읽기 전용 그래프 추적. 노드의 실행 중·대기·완료·실패와 실제로 지나간 연결을 구분해 표시 |
| 인스턴스 제어 | terminate / pause / resume / 실패 지점 재시도(preview 포함) |
| 운영 상태 | Job 적체, 장시간 WAITING, 만료 lease, Webhook·Outbox DLQ 진단과 안전 재처리 |
| 실행 이상 점검 | 런타임 무결성 scan / repair |
| 감사 로그 | 관리 작업 감사 기록 및 콘솔 조회 화면 |

운영 화면 판정 기준(HEALTHY / WARNING / DANGER)은 `docs/operations-monitoring.md`.

디자이너의 노드 유형은 아이콘 색으로, 현재 선택은 파란 외곽선으로 구분한다. 실시간 실행과 이력
추적에서는 카드 테두리와 상태 아이콘을 사용해 실행 중(파랑), 대기(주황 점선), 완료(초록),
실패(빨강)를 표시하며 미니맵과 캔버스 범례도 같은 의미를 쓴다. 실행 상태와 연결선 강조는
워크플로우 정의와 분리된 화면 상태이므로 저장 데이터와 탭의 변경 여부에 포함되지 않는다.
실행·이력 모드에서는 통과하지 않은 승인·반려 분기도 회색으로 바뀌며, 분기의 업무 의미는
연결선 라벨로 구분한다.
실행 상세 패널을 닫아도 캔버스 표시는 유지되며, 범례의 `표시 지우기`를 누르거나 다른
워크플로우로 전환하거나 새 실행을 시작할 때 초기화된다.

인스턴스 종료는 공개 `/api/v1/instances/:id/terminate`에서도 지원한다. `workflow:execute` scope와
대상 워크플로우 권한이 있어야 하며 같은 사용자 또는 서비스 계정 소유자의 API Key로 시작한 실행만
종료할 수 있다. Key를 재발급해도 소유자 기준으로 판단한다. 시작 소유자를 확인할 수 없는 기존 실행은
공개 API에서 종료할 수 없다.
키의 그룹·워크플로우 접근 범위를 적용한다. pause/resume은 운영자용 관리 경로 `/api`에만 둔다.

---

# 6. 인증과 접근 제어

## 사용자 인증 (콘솔)

- opaque 세션 + CSRF 토큰, 세션 활동 정책 설정 UI
- 역할: `admin`(최고관리자) / `group_manager`(그룹 관리자) / `user`(일반 사용자)
- 역할별 사이드바 메뉴와 화면 접근 제어 적용

**지원하지 않음**: SSO, LDAP/AD, OAuth/OIDC 연동.

## API Key 인증 (외부 시스템)

| 통제 | 내용 |
|---|---|
| scope | `workflow:read`, `workflow:execute`, `task:approve` 세 가지 |
| 워크플로우 접근 정책 | `all_in_group`(그룹에 이후 추가되는 것도 허용) 또는 `allowlist`(명시된 것만) |
| IP allowlist | 지원 |
| Rate limit | 지원 |
| 만료 · 회전 · 비활성화 | 지원 |
| 키 노출 | 발급 시 1회만 원문 표시, 이후 prefix만 조회 |
| 발급·사용 이력 | 그룹 관리 화면에서 키 소유자, 발급자, 발급 시각, 마지막 사용 시각과 호출 이력을 조회 |

서비스 계정은 결재자가 될 수 없다. API로 결재를 처리하려면 사용자 소유 키 + `task:approve` scope를 쓴다.
호출 이력은 인증된 키 소유자와 외부 시스템이 전달한 업무 수행자 정보를 구분하며, 그룹 관리자와
최고관리자만 조회할 수 있다. 요청 접수 시 기록을 만들고 응답 완료 후 HTTP 상태 코드·처리 시간·완료
시각을 채운다. 연결이 먼저 끊기면 응답 중단으로 표시한다. 성공 표시는 워크플로우 전체 완료가 아니라
API 요청이 정상 처리됐다는 뜻이다.

## 그룹 삭제와 복구

최고관리자는 삭제 전에 소속 워크플로우, 진행 중 실행과 미결 결재, 자동 트리거, API Key와 연동
리소스의 영향과 실제 적용될 삭제 방식을 확인한다. 연결 자원과 과거 사용 이력이 모두 없는 그룹만
영구 삭제하며 복구할 수 없음을 명시한다. 현재 비어 있어도 사용 이력이 있으면 복구 가능한 삭제를 적용한다.
진행 중 실행이 있으면 삭제를 차단하며 자동 종료하지 않는다.

복구 가능한 삭제는 그룹과 소속 워크플로우를 논리 삭제하고, 스케줄·DB Watch를 중지하며 활성 API Key를
비활성화한다. 실행 이력, 워크플로우 버전, 감사 기록과 Credential 공유 설정은 보존한다. 그룹을 복구하면
함께 삭제된 워크플로우만 비활성 상태로 복구하고 자동 트리거는 자동으로 다시 켜지 않는다. 그룹 삭제로
비활성화된 API Key는 재활성화하지 않고 필요한 연동에 새 키를 발급한다. 화면은 복구 후 확인이 필요한
항목과 각 관리 화면으로 가는 동선을 제공하며, 관리자가 확인을 완료할 때까지
그룹에 배지를 표시한다. 활성 그룹과 삭제된 그룹은 별도 탭에서 조회한다.

## 오류 계약

- 인증 실패는 `401`, 읽기 가능한 리소스에 실행 권한만 없으면 `403`, 숨겨야 하는 리소스는 `404`
- 모든 응답에 `X-Request-ID`가 있고, 오류 본문의 `request_id`·`code`와 서버 로그가 같은 값으로 연결된다
- 500 응답은 내부 예외나 stack trace를 노출하지 않는다

---

# 7. 개발자 경험

- 반복 실습: `demo:seed` / `demo:reset`으로 전용 그룹·계정·워크플로우·입력 프리셋 준비. `demo:service`는 모의 권한 반영, `demo:check`는 실제 API/Engine 경로 검증. 사용법은 `docs/demo-practice.md`.

- OpenAPI 3.1: Swagger UI `/api/docs`, JSON `/api/docs/openapi.json`, 빌드 산출물 `apps/api/openapi.json`
- 코드와 DTO가 문서의 원본이며, 저장된 산출물이 코드와 달라지면 API 테스트가 실패한다
- 공개 엔드포인트 15개. 목록은 `docs/public-api-v1.md`
- reference client `apps/api-playground`: API Key만으로 접속, 요청/응답과 재사용 가능한 cURL 표시
- 워크플로우 정의 import / export (독자 JSON 포맷)
- 워크플로우 관리 상세에서 생성자·최근 수정자 이름/ID/시각과 가져온 원본을 확인한다. 관리 권한이 필요하며 작성자를 모르면 확인 불가로 표시한다.

**지원하지 않음**: 5분 Quick Start 문서, 공식 클라이언트 SDK, BPMN 2.0 XML 입출력.

---

# 8. 지원하지 않는 기능

물어보면 반드시 나오는 항목들이다. "언젠가 될 것"이 아니라 **현재 없다**는 사실을 명확히 한다.

## BPMN 표준

| 항목 | 상태 |
|---|---|
| BPMN 2.0 XML 입출력 | ❌ 독자 JSON 포맷만 지원 |
| Boundary Event (타이머·에러 경계) | ❌ |
| Message / Signal Event | ❌ |
| Multi-instance (반복 실행) | ❌ |
| 보상 트랜잭션(Compensation) | ❌ |
| DMN 룰 엔진 | ❌ |

## 실행 의미

| 항목 | 상태 |
|---|---|
| 에러 분기 엣지 | ❌ 노드 실패 시 재시도 후 인스턴스가 `FAILED`가 되고, 복구는 운영자의 재시도 API로 한다 |
| 진행 중 인스턴스의 신버전 이관 | ❌ 인스턴스는 시작 시점 버전에 고정된다 |

## 결재 업무 기능

| 항목 | 상태 |
|---|---|
| 승인 기한 / SLA 에스컬레이션 | ✅ 노드별 처리 기한, 유예 시간 후 그룹 관리자 알림. 자동 승인·반려·재배정 없음 |
| 위임 · 대결(代決) | ❌ |
| Task claim / unclaim | ❌ |

## 그 외

| 항목 | 상태 |
|---|---|
| SSO / LDAP / OIDC | ❌ |
| 멀티테넌시 | ❌ 그룹 단위 접근 제어까지만 |
| 클라이언트 SDK | ❌ OpenAPI로 생성해야 한다 |
| SaaS 제공 | ❌ 현재 온프레미스 설치형 기준 |

---

# 9. 배포 형태

- **온프레미스 단일 서버 설치형**이 현재 기준이다. SaaS는 범위 밖이다.
- 진입점은 Nginx HTTPS `443`, API가 빌드된 Web 정적 파일을 함께 제공한다
- Engine은 외부 포트를 열지 않고 DB 내부망에만 연결한다
- 운영 프로필 저장소는 MongoDB 7 replica set으로 고정한다
- 절차와 백업·복구는 `docs/production-beta-runbook.md`

## 검증 명령

| 명령 | 내용 |
|---|---|
| `pnpm gate:beta` | API·Web 빌드 + Engine 단위 테스트 + 브라우저 E2E |
| `pnpm gate:operations` | 운영 설정·compose 검증 + 복구 리허설 |
| `pnpm gate:release` | 위 둘 전부 |
| `pnpm e2e:browser` | 동적 결재 브라우저 회귀 (`docs/dynamic-approval-browser-regression.md`) |
| `pnpm demo:verify` | 격리 환경의 발표 데이터 준비 + 백엔드 6개 시나리오 + 브라우저 발표 동선 |
