# BPM/PXM 플랫폼 설명 자료

구현 진행 상태는 `docs/old/bpm-platform-implementation-plan.md`에서 투두 형태로 관리한다.

## 1. 우리가 만든 것

우리는 기존 PXM Engine의 workflow 실행 구조를 살리면서, 범용 BPM 플랫폼으로 확장할 수 있는 구조를 만들었다.

핵심 방향은 다음과 같다.

- BPM Web에서 프로세스를 설계한다.
- API/BFF가 템플릿, 인스턴스, task, plugin registry를 관리한다.
- Engine은 workflow runtime만 담당한다.
- 외부 시스템 연동은 Engine에 하드코딩하지 않고 plugin으로 분리한다.
- DB는 특정 DB에 고정하지 않고 adapter 방식으로 여러 DB를 지원할 수 있게 한다.
- 현재 우선 runtime DB는 MongoDB다.

전체 구조:

```text
Web Flow Designer
  -> API / BFF
    -> DB Adapter
      -> MongoDB 우선
      -> PostgreSQL 확장 가능

Engine
  -> Workflow runtime 실행
  -> Service node 도달 시 plugin_id 기반 실행
  -> Plugin Registry metadata 조회
  -> builtin / hosted / external_http executor 호출

Plugin Host
  -> hosted plugin executor 실행
  -> Slack, ACRA, NIT, Jira, HR, AD 등 업무 connector 수용
```

## 2. 사용 방식

PXM은 두 가지 방식으로 사용할 수 있다.

### 2.1 PXM Web을 통해 사용하는 방식

사용자가 PXM이 제공하는 Web에 로그인해서 직접 workflow를 설계하고 실행/관리하는 방식이다.

```text
사용자
  -> PXM Web
  -> PXM API
  -> Engine
  -> Plugin / DB
```

예:

- 관리자가 프로세스 template을 설계한다.
- 관리자가 workflow를 직접 실행하거나 외부 시스템이 API로 실행한다.
- 운영자가 실행 이력과 trace를 확인한다.

Approval 노드는 기본 Flow Designer 팔레트에 제공한다. 다만 요청/승인 포털과 결재함은 기본 제품 화면이 아니라 샘플 또는 reference UI이며, `VITE_ENABLE_APPROVAL_SAMPLE_UI=true`로 실행한 경우에만 별도 메뉴로 노출한다.

이 방식은 BPM 제품형 사용 방식에 가깝다.

### 2.2 외부 솔루션이 API로 호출하는 방식

다른 솔루션이 PXM Web을 거치지 않고 PXM API를 직접 호출해서 workflow runtime을 사용하는 방식이다.

```text
외부 솔루션
  -> PXM API
  -> Engine
  -> Plugin / DB
```

예:

- 사내 포털이 PXM API로 권한 신청 workflow를 실행한다.
- ITSM이 장애 처리 workflow를 시작한다.
- HR 시스템이 입사/퇴사/부서이동 workflow를 실행한다.
- 기존 업무 시스템이 task 조회/처리 API를 호출한다.

이 방식은 BPM backend platform 또는 workflow runtime으로 사용하는 방식에 가깝다.

핵심은 PXM Web이 기본 UI 역할을 하지만, PXM API만으로도 외부 시스템 연동이 가능하다는 점이다.

## 3. 인증과 접근 제어 방향

사용 방식이 두 가지이므로 인증도 두 축으로 나누는 것이 자연스럽다.

### 3.1 사용자 로그인 기반 인증

PXM Web에 사람이 로그인해서 사용하는 인증이다.

대상:

- 최고관리자(`admin`)
- 그룹 관리자(`group_manager`)
- 개인 API key 소유자 등 제한된 일반 사용자(`user`)

요청자와 승인자는 기본 관리 role이 아니다. Approval 실행 데이터와 샘플 포털에서 사용하는 runtime actor로 분리한다.

필요한 기능:

- Session 또는 JWT 기반 로그인
- SSO / LDAP / AD / OAuth / OIDC 연동 가능성
- 사용자 role / permission
- group 단위 접근 제어
- 프로세스 설계, 실행, 운영 권한 분리

### 3.2 외부 시스템 API 호출 기반 인증

다른 솔루션이 PXM API를 호출할 때 사용하는 machine-to-machine 인증이다.

대상:

- 사내 포털
- ITSM
- HR 시스템
- 권한 신청 시스템
- 기타 업무 솔루션

가능한 인증 방식:

- API Key
- Client ID / Client Secret
- OAuth2 Client Credentials
- mTLS
- IP allowlist
- service account

권한 모델도 사용자 권한과 API 권한을 분리해서 생각해야 한다.

```text
사용자 권한
  -> 누가 어떤 프로세스를 만들고 실행하고 승인할 수 있는가

API 권한
  -> 어떤 외부 시스템이 어떤 workflow를 실행/조회/처리할 수 있는가
```

회의에서 설명할 때는 다음처럼 정리할 수 있다.

```text
PXM은 사람이 Web에 로그인해서 쓰는 제품형 접근과,
외부 시스템이 API로 호출하는 플랫폼형 접근을 모두 지원하는 구조다.
따라서 인증도 user authentication과 machine-to-machine authentication으로 분리해서 설계해야 한다.
```

## 4. BPM 실행 구조

프로세스는 Web에서 node와 edge로 설계된다.

예시:

```text
Start -> Gateway -> Service Plugin -> End
```

실행 흐름:

1. 사용자가 Web에서 workflow template을 만든다.
2. API가 template을 저장한다.
3. 사용자가 template을 실행하면 process instance가 생성된다.
4. Engine이 job을 polling한다.
5. Engine이 token을 따라 node를 실행한다.
6. gateway node에서는 조건에 따라 다음 token을 선택하거나 분기한다.
7. service node에서는 `plugin_id`를 기준으로 plugin executor를 호출한다.
8. 모든 node가 완료되면 instance가 `COMPLETED`가 된다.

Approval runtime과 노드 설계는 기본 제공한다. 사람이 task를 처리하는 결재함 화면만 별도 샘플 UI로 제공한다.

## 5. BPMN 기준 노드 매핑

현재 PXM의 node palette는 BPMN 전체 요소를 모두 노출하는 방식이 아니라, 업무 승인/연동 workflow에 필요한 핵심 요소를 제품 노드로 단순화한 것이다.

| PXM node | BPMN 기준 | 설명 |
|---|---|---|
| Start | Start Event | 프로세스 시작점 |
| Approval | User Task | 사람이 승인/반려하는 작업. 처리 포털은 별도 샘플 UI로 제공 |
| Gateway | Gateway | 조건에 따라 다음 경로 선택 |
| Service | Service Task | 시스템/API/plugin 실행 |
| Executable / Command | Service Task 확장 | 서버/에이전트에 등록된 실행파일 또는 명령 실행 |
| End | End Event | 프로세스 종료점 |

DB node는 별도 Engine primitive로 만들지 않고, BPMN의 Service Task에 해당하는 plugin connector로 제공한다.

```text
PXM DB Node
  -> BPMN Service Task
  -> node_type = service
  -> plugin_id = connector.db.mongodb.query
  -> connection_uri 또는 connection_id를 node config에서 읽음
```

PXM runtime DB의 `MONGODB_URL`은 workflow template, instance, task, token 저장용이다. DB Node가 조회할 업무 DB 연결 정보는 노드 설정의 `connection_uri` 또는 향후 connection registry의 `connection_id`로 분리한다. DB Node는 연결 정보가 없을 때 PXM runtime DB로 fallback하지 않고 실패해야 한다.

Script 계열 노드는 Python 등 여러 언어를 지원하는 generic Script Node로 확장하지 않고, JavaScript만 지원하는 JS Node로 확정한다.

```text
PXM JS Node
  -> BPMN Script Task
  -> node_type = script
  -> script_type = javascript
```

JS Node는 workflow context의 입력 데이터를 가공하고, 결과를 output/context에 기록해서 다음 노드로 넘기는 용도다. Python runtime은 dependency, sandbox, runtime version, package 관리 부담이 크므로 기본 제품 범위에 포함하지 않는다.

회의에서 나온 실행파일 실행 요구사항은 End Node가 아니라 Service Task 계열로 보는 것이 맞다. 예를 들어 "exe 실행 후 결과값을 받아 Slack/API로 전송"하는 흐름은 다음처럼 모델링한다.

```text
Start
  -> Executable Node
  -> JS Node
  -> HTTP Request 또는 Slack Connector
  -> End
```

Executable Node는 사용자가 임의 경로를 직접 입력해서 실행하는 방식이 아니라, 서버/에이전트에 사전 등록된 `command_id`를 선택하고 허용된 argument만 전달하는 방식으로 설계해야 한다. 실행 결과는 `exit_code`, `stdout`, `stderr`, `duration_ms` 형태로 다음 노드에 전달한다.

## 6. DB 구조와 Mongo 우선 전략

DB는 특정 구현에 Engine/API가 직접 묶이지 않도록 adapter 구조로 분리했다.

현재 방향:

- 우선 MongoDB를 runtime DB로 사용한다.
- PostgreSQL adapter도 확장 가능한 구조로 둔다.
- API와 Engine 모두 DB adapter/port를 통해 runtime data를 다룬다.

MongoDB를 우선 적용한 이유:

- workflow instance, node context, execution log처럼 JSON 형태가 많은 데이터와 잘 맞는다.
- process context와 form data를 유연하게 저장할 수 있다.
- BPM runtime을 빠르게 검증하기 좋다.
- 향후 customer 환경에 따라 MongoDB/PostgreSQL 등으로 확장할 여지를 남길 수 있다.

주요 Mongo runtime collection:

```text
v2_process_definitions
v2_process_instances
v2_tokens
v2_tasks
v2_engine_jobs
v2_event_outbox
v2_execution_logs
v2_advisory_locks
```

테스트/운영 관점에서는 `v2_engine_jobs`, `v2_tokens`, `v2_tasks`, `v2_execution_logs`가 runtime 상태를 보는 핵심이다.

## 7. 플러그인 방식으로 바꾼 이유

기존 방식은 외부 시스템 연동이 Engine/API 코드 안에 하드코딩되기 쉽다.

예를 들어 HTTP 호출, DB 조회, 고객사 업무 시스템 연동 같은 기능이 Engine 코드에 직접 들어가면 문제가 생긴다.

- 새 연동을 추가할 때 Engine을 수정해야 한다.
- Engine 배포가 잦아진다.
- 고객사별 connector 차이를 흡수하기 어렵다.
- workflow runtime과 업무 연동 책임이 섞인다.

그래서 service node 실행을 다음 구조로 바꿨다.

```text
node_type = service
plugin_id = connector.db.mongodb.query
```

Engine은 `plugin_id`를 보고 plugin registry에서 실행 정보를 찾는다. Engine은 MongoDB query node를 Service Task로 실행하며, PostgreSQL/MySQL 같은 DB 종류는 실제 executor를 구현한 뒤 하나씩 추가한다.

## 8. Plugin Registry

Plugin Registry는 사용할 수 있는 plugin 목록과 실행 계약을 담는 manifest 저장소다.

manifest에는 다음 정보가 들어간다.

- `plugin_id`
- version
- display name
- category
- icon
- node type
- config schema
- executor type
- executor ref
- secrets policy
- input/output schema
- timeout/retry policy
- trusted source
- isolation/resource limits

예시:

```json
{
  "plugin_id": "connector.db.mongodb.query",
  "version": "1.0.0",
  "display_name": "MongoDB Query",
  "category": "Database",
  "node_type": "service",
  "executor_type": "builtin",
  "executor_ref": "builtin.mongodb_query"
}
```

API는 이 registry를 Web에 제공한다.

```text
GET /api/plugins
GET /api/plugins/:plugin_id
GET /api/plugins/:plugin_id/versions
```

Web은 이 manifest를 보고 plugin palette와 node 설정 form을 렌더링한다.

## 9. Web에서 플러그인을 사용하는 방식

Web Flow Designer에서는 plugin이 generic Service node의 dropdown 옵션이 아니라, 팔레트의 1급 노드로 보인다.

예시:

```text
HTTP Request
MongoDB Query
```

사용 방식:

1. 왼쪽 팔레트에서 plugin을 검색한다.
2. 원하는 plugin node를 canvas에 drag/drop한다.
3. 오른쪽 속성 패널에서 설정값을 입력한다.
4. 설정 form은 plugin manifest의 `config_schema`를 기반으로 자동 렌더링된다.
5. 저장되는 runtime shape은 `node_type = service`와 `plugin_id`다.

이 방식의 장점:

- n8n처럼 각 연동이 독립 노드처럼 보인다.
- 사용자가 어떤 업무 연동을 쓰는지 명확하다.
- 새 plugin을 추가해도 Web 코드를 크게 바꾸지 않아도 된다.

## 10. Plugin Executor 유형

플러그인 실행 방식은 세 가지로 나뉜다.

### builtin

Engine 안에 들어가는 작은 generic executor다.

예:

```text
builtin.http_request
```

업무 connector는 builtin에 넣지 않는다.

### hosted

`pxm-plugin-host` 안에서 실행되는 공식/고객사 connector다.

예:

```text
connector.customer_hr.lookup_user
connector.customer_iam.grant_permission
```

on-prem 기본 모델은 hosted 방식이다.

장점:

- Engine을 수정하지 않고 connector executor를 추가할 수 있다.
- 업무 연동 코드를 `pxm-plugin-host`에 모을 수 있다.
- Engine은 workflow runtime에 집중한다.

### external_http

별도의 HTTP service로 실행되는 plugin이다.

예:

```text
connector.db.mongodb.query
```

무거운 연동, 격리가 필요한 연동, 별도 runtime이 필요한 연동에 적합하다. 현재 실제 동작하는 DB node는 MongoDB Query 하나이며, 다른 DB connector는 executor 구현 후 추가한다.

### command / executable

서버 또는 별도 agent 환경에서 사전 등록된 실행파일/명령을 실행하는 executor 유형이다.

예:

```text
connector.command.exec
connector.executable.run
```

주요 용도:

- 기존 고객사 업무 도구가 `.exe` 또는 shell command 형태로만 제공되는 경우
- 파일 변환, 레거시 배치, 사내 유틸리티 실행
- 실행 결과를 stdout/stderr로 받고 다음 노드에서 JS로 가공하는 경우

이 유형은 보안 위험이 크므로 임의 명령 실행을 허용하지 않는다. 운영 환경에서는 `command_id` 기반 allowlist, timeout, working directory 제한, argument schema, 동시 실행 제한, audit log, agent 격리가 필요하다.

## 11. 플러그인 실행 흐름

Service node 실행 시 흐름:

```text
Engine
  -> node_type == service 확인
  -> plugin_id 확인
  -> plugin manifest 조회
  -> executor_type 확인
  -> builtin / hosted / external_http 중 하나로 실행
  -> 표준 plugin response 수신
  -> execution log 기록
  -> 다음 node로 token 이동
```

Hosted plugin 호출 request:

```json
{
  "plugin_id": "connector.db.mongodb.query",
  "instance": {
    "id": "instance-id"
  },
  "node": {
    "id": "node-id",
    "token_id": "token-id"
  },
  "config": {},
  "context": {},
  "secrets": {},
  "attempt": 1,
  "retry": {},
  "isolation": {},
  "resource_limits": {}
}
```

Plugin response:

```json
{
  "success": true,
  "output": {}
}
```

실패 시:

```json
{
  "success": false,
  "retryable": false,
  "error": {
    "code": "PLUGIN_ERROR",
    "message": "error message"
  }
}
```

## 12. 플러그인 추가 방식

새 hosted plugin을 추가하는 흐름:

1. plugin manifest를 만든다.
2. `apps/api/plugin-manifests` 또는 plugin package에 manifest를 둔다.
3. `pxm-plugin-host`에 executor module을 추가한다.
4. `PluginHostService`에 `plugin_id`로 executor를 등록한다.
5. `pnpm plugin:install -- <plugin-package-dir>`로 manifest를 등록한다.
6. API/Engine/plugin-host를 재시작한다.
7. Web palette에서 새 plugin node를 확인한다.

새 external HTTP plugin을 추가하는 흐름:

1. 별도 HTTP service를 만든다.
2. `/invoke` endpoint가 표준 request/response 계약을 만족하게 한다.
3. manifest의 `executor_type`을 `external_http`로 설정한다.
4. `executor_ref`에 invoke URL을 넣는다.
5. conformance test를 실행한다.
6. manifest를 설치한다.

conformance 예시:

```bash
pnpm plugin:conformance -- \
  --manifest ../../examples/external-http-plugin/plugin.json \
  --endpoint http://127.0.0.1:3020/invoke
```

## 13. 운영 통제

운영 통제는 `apps/api/plugin-controls.json`에서 관리한다.

가능한 통제:

- plugin enable/disable
- version pinning
- workspace/customer-level allowlist
- trusted source 검사
- install/control/execute audit log
- hosted/external isolation policy
- plugin-host payload limit, timeout boundary

예:

```json
{
  "default_enabled": true,
  "disabled_plugins": [],
  "version_pins": {},
  "workspace_allowlists": {
    "default": ["*"]
  },
  "trusted_sources": ["local", "official", "customer"],
  "require_trusted_source": true
}
```

명령 예시:

```bash
pnpm plugin:control -- disable connector.db.mongodb.query
pnpm plugin:control -- enable connector.db.mongodb.query
pnpm plugin:control -- pin connector.db.mongodb.query 1.0.0
pnpm plugin:control -- allow customer-a connector.db.mongodb.query
```

## 14. 테스트 결과

현재 확인한 테스트:

```text
pnpm build: pass
pnpm db:mongo:check: pass
pnpm smoke:mongo:approval: pass
pnpm smoke:mongo:gateway: pass
hosted plugin conformance: pass
external_http plugin conformance: pass
plugin install/control flow: pass
```

Approval smoke 예시 결과:

```text
[mongo:smoke:approval] passed
instance=9977c5f5-f42c-44e0-8b4a-4798f4f9007d
task=e15ddeb3-0568-4538-aa94-cc0f7ad3c65d
```

Engine 로그 예시:

```text
[v2_engine] Executing plugin: connector.db.mongodb.query
```

## 15. 회의에서 강조할 포인트

핵심 메시지:

- 우리는 workflow runtime과 외부 연동 책임을 분리했다.
- PXM Web으로 사용하는 제품형 접근과 API로 호출하는 플랫폼형 접근을 모두 지원한다.
- 인증도 사용자 로그인과 machine-to-machine API 인증을 분리해서 설계해야 한다.
- Engine은 BPM 실행에 집중하고, connector는 plugin으로 확장한다.
- Web은 registry 기반으로 plugin node를 렌더링한다.
- DB는 adapter 구조로 여러 DB를 지원할 수 있게 했고, 현재는 MongoDB를 우선 적용했다.
- DB node는 plugin 기반 Service Task로 제공하고, script 계열은 JS Node만 지원한다.
- 플러그인 추가는 Engine 수정 없이 manifest와 executor 등록으로 처리할 수 있다.
- 운영 환경을 위해 enable/disable, allowlist, trusted source, audit, resource limit을 넣었다.

한 문장 요약:

```text
PXM/BPM Core는 workflow runtime에 집중하고, 외부 시스템 연동은 plugin registry와 plugin-host를 통해 확장하는 구조로 만들었다.
```

## 16. 남은 논의거리

회의에서 결정이 필요한 항목:

- Web 사용자 인증 방식을 SSO/OIDC/LDAP/AD 중 어디까지 지원할지
- 외부 시스템 API 인증을 API Key, OAuth2 Client Credentials, mTLS 중 무엇으로 시작할지
- 고객사별 plugin 배포 방식을 hosted 중심으로 할지, external_http를 얼마나 허용할지
- plugin manifest를 파일 registry로 유지할지, 운영 단계에서 DB-backed registry로 확장할지
- secret store를 환경변수/file 기반에서 Vault/KMS 계열로 확장할지
- plugin signature 검증을 실제 cryptographic signature까지 강화할지
- workspace/customer-level allowlist 정책을 누가 관리할지
- UI에서 plugin install/control 화면을 제공할지

## 17. 회의 리뷰 기반 제품 요구사항과 실행 계획

이번 회의에서 나온 요구사항을 반영하면 PXM/BPM 플랫폼의 제품 방향은 다음과 같다.

```text
PXM은 전체 업무 화면을 모두 제공하는 포털이 아니라,
workflow 설계/실행/이력/운영을 API 중심으로 제공하는 BPM backend platform이다.
Web은 디자이너, 대시보드, 이력/모니터링 중심으로 제공하고,
요청/승인 화면은 샘플 또는 reference UI로 제공한다.
```

### 17.1 제품 범위

핵심 화면:

- Flow Designer
- Dashboard
- Execution History / Trace
- Plugin / Connection 설정 화면

샘플 화면:

- 요청 화면
- 승인 화면
- 간단한 포털 연동 예시

핵심 API:

- workflow 실행 API
- task 조회/처리 API
- instance/result/trace 조회 API
- export/import API
- retry API
- workflow 호출 API

### 17.2 주요 요구사항 정리

| 요구사항 | 판단 | 설계 방향 |
|---|---|---|
| exe 실행 후 결과 사용 | 필요 | Executable/Command Node로 제공 |
| API 방식 중심 | 확정 방향 | Web은 디자이너/대시보드/이력 중심 |
| Export/Import | 필요 | 정해진 JSON/YAML 포맷과 schema version 제공 |
| 워크플로우 그룹화 | 필요 | group, namespace, tags 추가 |
| 속도 | 최우선 | sync/async 실행 모드 분리, 빠른 instance 생성 |
| 입력 -> DB 조회 -> JS 가공 -> output | 핵심 흐름 | MongoDB Query + JS Node + output path |
| secret DB 관리 | 가능 | secret 원문은 workflow에 저장하지 않고 secret_ref 사용 |
| 인사 데이터 추출 후 update/delete/post | Service Node에서 처리 | End 전 HTTP/DB/Command 노드에서 처리, End는 종료 의미 |
| Start 스케줄링 | 필요 | Start Event type으로 schedule/webhook/api/manual 구분 |
| DB watch | 후순위 | DB Watch Start Trigger로 검토 |
| 이력 API | 필요 | 권한 기반 instance/trace/result 조회 |
| 워크플로우 설명 | 필요 | description, tags, version note 추가 |
| 워크플로우가 워크플로우 호출 | 필요 | Call Workflow Node 또는 workflow.call plugin |
| 완료 데이터 반환 | 필요 | End가 실행하지 않고 resultPath로 완료 결과 지정 |
| 대시보드 Retry | 필요 | 실패 노드 또는 instance 재시도 |
| Start API 응답 방식 | 둘 다 필요 | sync는 완료 결과, async는 instance_id 반환 |

### 17.3 End Node와 후속 작업 기준

End Node는 외부 API 호출, DB update/delete, exe 실행 같은 작업을 수행하는 노드가 아니다. End는 프로세스 종료를 의미한다.

따라서 다음 흐름이 맞다.

```text
Start
  -> DB Query
  -> JS Node
  -> HTTP Request / DB Update / Executable Node
  -> End
```

완료 데이터를 반환해야 하는 경우에도 End Node가 별도 작업을 수행하는 것이 아니라, End Node 또는 workflow 설정에 `resultPath`를 지정해서 context의 특정 값을 완료 결과로 노출한다.

예:

```text
JS Node outputPath = result
End Node resultPath = result
```

### 17.4 Executable / Command Node 설계

회의에서 나온 "exe 실행" 요구사항은 별도 중요 기능으로 관리한다.

초기 노드 형태:

```json
{
  "node_type": "service",
  "plugin_id": "connector.command.exec",
  "command_id": "hr_export_tool",
  "args": {
    "date": "2026-06-15",
    "department": "IT"
  },
  "timeout_ms": 30000,
  "output_path": "execResults.hrExport"
}
```

실행 결과:

```json
{
  "exit_code": 0,
  "stdout": "...",
  "stderr": "",
  "duration_ms": 1240
}
```

운영 정책:

- 사용자가 임의 실행 경로를 입력하지 못하게 한다.
- 서버/에이전트에 등록된 `command_id`만 실행한다.
- command별 argument schema를 둔다.
- timeout은 필수다.
- stdout/stderr 크기 제한을 둔다.
- working directory와 environment variable을 제한한다.
- 실행 이력을 audit log에 남긴다.
- 고객사 on-prem 환경에서는 별도 agent 실행 모델을 검토한다.

이 기능은 HTTP/DB/JS보다 보안 리스크가 크므로 MVP 즉시 범위보다는 2차 핵심 기능으로 둔다.

### 17.5 Start Node 타입

Start Node는 단순 시작점이 아니라 trigger type을 가져야 한다.

초기 타입:

```text
api       외부 API 호출로 시작
manual    디자이너/관리 화면에서 수동 시작
schedule  cron 또는 interval 기반 시작
webhook   외부 webhook 수신으로 시작
```

후속 타입:

```text
db_watch  Mongo Change Stream 또는 DB polling 기반 시작
event     message queue/event bus 기반 시작
```

DB Watch는 DB Query Node가 아니라 Start Trigger에 가깝다. 예를 들어 HR DB에 직원 변경이 발생하면 workflow를 시작하는 구조다.

### 17.6 실행 API 응답 모델

속도가 중요하므로 실행 API는 sync와 async를 분리한다.

Async:

```http
POST /api/workflows/:id/start?mode=async
```

응답:

```json
{
  "instance_id": "instance-id",
  "status": "RUNNING"
}
```

Sync:

```http
POST /api/workflows/:id/start?mode=sync
```

응답:

```json
{
  "instance_id": "instance-id",
  "status": "COMPLETED",
  "result": {}
}
```

sync mode는 제한 시간이 필요하다. 제한 시간 안에 끝나지 않으면 `202 Accepted`와 `instance_id`를 반환하고, 호출자는 이력 API 또는 stream으로 추적한다.

조회 API:

```text
GET /api/instances/:id
GET /api/instances/:id/trace
GET /api/instances/:id/result
GET /api/instances/:id/stream
```

### 17.7 Export / Import 포맷

워크플로우 export/import는 제품 핵심 기능으로 둔다.

포맷에 포함할 정보:

- `schema_version`
- workflow id/name/description
- group/namespace/tags
- workflow version
- nodes
- edges
- plugin dependencies
- start trigger config
- end result config
- created/updated metadata

예:

```json
{
  "schema_version": "pxm.workflow/v1",
  "name": "HR Sync",
  "description": "인사 데이터 동기화 workflow",
  "group": "LG.HR",
  "tags": ["hr", "sync"],
  "version": 3,
  "nodes": [],
  "edges": [],
  "dependencies": {
    "plugins": [
      {
        "plugin_id": "connector.db.mongodb.query",
        "version": "1.0.0"
      }
    ]
  }
}
```

사람이 에디터로 수정 가능해야 하므로 JSON을 우선으로 하고, 추후 YAML export를 추가할 수 있다.

### 17.8 Secret / Connection 관리

초기 개발에서는 `connection_uri` 직접 입력을 허용할 수 있지만, 운영 모델은 `connection_id`와 `secret_ref` 기반이어야 한다.

원칙:

- workflow definition에 secret 원문을 저장하지 않는다.
- export 파일에도 secret 원문을 포함하지 않는다.
- node config에는 `connection_id` 또는 `secret_ref`만 저장한다.
- runtime이 실행 시점에 secret store 또는 DB에서 resolve한다.
- secret 조회/사용 이력을 audit log에 남긴다.

### 17.9 이력과 권한

이력 API는 필요하지만 모든 이력을 누구나 보는 구조는 안 된다.

권한 기준:

- admin: 전체 group 이력 조회
- group_manager: 본인에게 할당된 group의 workflow 이력 조회
- user/API key owner: 본인 또는 허용된 workflow 실행 범위만 조회
- API client: 권한이 부여된 workflow/instance 범위만 조회

requester/approver runtime actor는 `admin`, `group_manager`, `user` 관리 role과 별개다. 기본 엔진과 API에서 지원하며, 별도 샘플 결재 UI에서도 사용한다.

필요 API:

```text
GET /api/instances
GET /api/instances/:id
GET /api/instances/:id/trace
GET /api/instances/:id/result
GET /api/tasks
GET /api/tasks/:id
POST /api/tasks/:id/complete
```

### 17.10 Retry 정책

대시보드에서 retry를 지원한다.

초기 범위:

- 실패한 instance 전체 재실행
- 실패한 node부터 재시도
- retry 전 이전 실패 원인과 input/context 표시

주의사항:

- 외부 API 호출이나 DB update 같은 side effect가 있는 노드는 중복 실행 위험이 있다.
- plugin manifest에 idempotency 여부를 표현할 수 있어야 한다.
- retry 시 이전 output을 재사용할지 다시 실행할지 정책이 필요하다.

### 17.11 우선순위 로드맵

1차:

- workflow metadata 보강: description, group, tags
- 외부 연동용 Workflow API 계약 정리
- 실행 성능 기준 정의: sync timeout, async 응답 목표, trace 조회 기준
- End resultPath 추가
- workflow export/import JSON 포맷 정의
- Start API sync/async 응답 모델 정리
- node test UX 확장: 결과 JSON path 제안

2차:

- Connection/Secret 관리 화면과 API
- Schedule Start
- Dashboard retry
- Workflow call node
- 이력 API 권한 모델 정리

3차:

- Executable/Command Node
- DB Watch Start
- Plugin control UI
- workflow version diff/rollback
- external agent 실행 모델

### 17.12 다음 결정 사항

다음 회의 또는 설계 단계에서 결정해야 할 항목:

- export/import 포맷을 JSON만 할지 YAML도 제공할지
- workflow group을 단순 문자열로 할지 계층 namespace로 할지
- Start API sync timeout 기본값
- End resultPath를 End Node 속성으로 둘지 workflow 설정으로 둘지
- secret store를 DB 기반으로 시작할지 Vault/KMS 연동까지 포함할지
- Executable Node를 core 기능으로 둘지 restricted plugin으로 둘지
- Retry를 instance 단위부터 할지 failed node 단위부터 할지
