# BPM/PXM 플랫폼 설명 자료

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
- 요청자가 신청서를 작성하고 workflow를 실행한다.
- 승인자가 task 목록에서 승인/반려한다.
- 운영자가 실행 이력과 trace를 확인한다.

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

- 관리자
- 요청자
- 승인자
- 운영자

필요한 기능:

- Session 또는 JWT 기반 로그인
- SSO / LDAP / AD / OAuth / OIDC 연동 가능성
- 사용자 role / permission
- workspace 또는 tenant 단위 접근 제어
- 프로세스 설계, 실행, 승인, 운영 권한 분리

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
Start -> Approval -> Service Plugin -> End
```

실행 흐름:

1. 사용자가 Web에서 workflow template을 만든다.
2. API가 template을 저장한다.
3. 사용자가 template을 실행하면 process instance가 생성된다.
4. Engine이 job을 polling한다.
5. Engine이 token을 따라 node를 실행한다.
6. approval node에서는 task를 만들고 대기한다.
7. task가 승인되면 Engine이 resume job을 처리한다.
8. service node에서는 `plugin_id`를 기준으로 plugin executor를 호출한다.
9. 모든 node가 완료되면 instance가 `COMPLETED`가 된다.

## 5. DB 구조와 Mongo 우선 전략

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

## 6. 플러그인 방식으로 바꾼 이유

기존 방식은 외부 시스템 연동이 Engine/API 코드 안에 하드코딩되기 쉽다.

예를 들어 Slack, Jira, ACRA, NIT 같은 연동이 Engine 코드에 직접 들어가면 문제가 생긴다.

- 새 연동을 추가할 때 Engine을 수정해야 한다.
- Engine 배포가 잦아진다.
- 고객사별 connector 차이를 흡수하기 어렵다.
- workflow runtime과 업무 연동 책임이 섞인다.

그래서 service node 실행을 다음 구조로 바꿨다.

```text
node_type = service
plugin_id = connector.slack.send_message
```

Engine은 `plugin_id`를 보고 plugin registry에서 실행 정보를 찾는다. Engine은 Slack/Jira/ACRA 같은 업무 의미를 몰라도 된다.

## 7. Plugin Registry

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
  "plugin_id": "connector.slack.send_message",
  "version": "1.0.0",
  "display_name": "Slack Send Message",
  "category": "Collaboration",
  "node_type": "service",
  "executor_type": "hosted",
  "executor_ref": "pxm-plugin-host:connector.slack.send_message"
}
```

API는 이 registry를 Web에 제공한다.

```text
GET /api/plugins
GET /api/plugins/:plugin_id
GET /api/plugins/:plugin_id/versions
```

Web은 이 manifest를 보고 plugin palette와 node 설정 form을 렌더링한다.

## 8. Web에서 플러그인을 사용하는 방식

Web Flow Designer에서는 plugin이 generic Service node의 dropdown 옵션이 아니라, 팔레트의 1급 노드로 보인다.

예시:

```text
Slack Send Message
NIT Create Issue
ACRA Grant Permission
Jira Create Issue
HR Lookup User
AD Grant Group
HTTP Request
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

## 9. Plugin Executor 유형

플러그인 실행 방식은 네 가지로 나뉜다.

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
connector.slack.send_message
connector.acra.grant_permission
connector.nit.create_issue
connector.jira.create_issue
connector.hr.lookup_user
connector.ad.grant_group
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
connector.external_echo
```

무거운 연동, 격리가 필요한 연동, 별도 runtime이 필요한 연동에 적합하다.

### mock

개발/테스트용 executor다.

## 10. 플러그인 실행 흐름

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
  "plugin_id": "connector.slack.send_message",
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

## 11. 플러그인 추가 방식

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

## 12. 운영 통제

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
pnpm plugin:control -- disable connector.slack.send_message
pnpm plugin:control -- enable connector.slack.send_message
pnpm plugin:control -- pin connector.slack.send_message 1.0.0
pnpm plugin:control -- allow customer-a connector.slack.send_message
```

## 13. 테스트 결과

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
[v2_engine] Executing plugin: connector.slack
```

## 14. 회의에서 강조할 포인트

핵심 메시지:

- 우리는 workflow runtime과 외부 연동 책임을 분리했다.
- PXM Web으로 사용하는 제품형 접근과 API로 호출하는 플랫폼형 접근을 모두 지원한다.
- 인증도 사용자 로그인과 machine-to-machine API 인증을 분리해서 설계해야 한다.
- Engine은 BPM 실행에 집중하고, connector는 plugin으로 확장한다.
- Web은 registry 기반으로 plugin node를 렌더링한다.
- DB는 adapter 구조로 여러 DB를 지원할 수 있게 했고, 현재는 MongoDB를 우선 적용했다.
- 플러그인 추가는 Engine 수정 없이 manifest와 executor 등록으로 처리할 수 있다.
- 운영 환경을 위해 enable/disable, allowlist, trusted source, audit, resource limit을 넣었다.

한 문장 요약:

```text
PXM/BPM Core는 workflow runtime에 집중하고, 외부 시스템 연동은 plugin registry와 plugin-host를 통해 확장하는 구조로 만들었다.
```

## 15. 남은 논의거리

회의에서 결정이 필요한 항목:

- Web 사용자 인증 방식을 SSO/OIDC/LDAP/AD 중 어디까지 지원할지
- 외부 시스템 API 인증을 API Key, OAuth2 Client Credentials, mTLS 중 무엇으로 시작할지
- 고객사별 plugin 배포 방식을 hosted 중심으로 할지, external_http를 얼마나 허용할지
- plugin manifest를 파일 registry로 유지할지, 운영 단계에서 DB-backed registry로 확장할지
- secret store를 환경변수/file 기반에서 Vault/KMS 계열로 확장할지
- plugin signature 검증을 실제 cryptographic signature까지 강화할지
- workspace/customer-level allowlist 정책을 누가 관리할지
- UI에서 plugin install/control 화면을 제공할지
