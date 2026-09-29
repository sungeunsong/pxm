# Workflow를 AI Tool로 공개 (설계)

PXM 워크플로우를 LLM이 호출할 수 있는 **Tool**로 공개하는 기능의 설계 문서다.
**아직 구현하지 않았다.** 지원 기능 목록(`docs/features.md`)에는 구현 후 반영한다.

- 1단계 범위: Tool Registry + Tool Invoke API + **인스턴스 `outcome` 1급 상태화**
- Rust 엔진 수정은 1단계에서 **딱 한 가지**다 — 종료 전이에서 `outcome`을 함께 기록한다 (9.1)
- 2단계 이후(LLM Node, Agent Node)는 방향과 **지금 지켜야 할 계약**만 기록한다
- 관련 문서: `docs/workflow-api-contract.md`, `docs/public-api-v1.md`, `docs/plugin-sdk-guide.md`

---

## 1. 목적과 역할 분리

고객사 엔지니어가 PXM에서 만든 워크플로우를 AI 하네스(Promtic 등)가 호출할 수 있는 Tool로
공개한다. **판단은 LLM이, 실행은 PXM이** 한다.

```
사용자 질문
  → Promtic: 사용 가능한 Tool 목록 조회 (GET /api/v1/tools)
  → LLM: Tool과 arguments 선택
  → Promtic: PXM Tool Invoke 호출 (POST /api/v1/tools/{name}/invoke)
      → PXM: 입력 스키마 검증 → 고정 버전 워크플로우 실행
      → PXM: 결재 / 재시도 / 타이머 / Trace 는 기존 그대로
      → PXM: Tool 응답 계약으로 결과 반환
  → Promtic: 결과를 LLM에 전달, 필요하면 반복
  → 최종 응답
```

| 구성 | 책임 |
|---|---|
| Promtic | AI 판단, Agent Loop, 사용자 응답 |
| PXM | 워크플로우 실행, 권한, 승인, 재시도, 상태, Trace |

**Agent Loop는 1단계에서 PXM 밖에 있다.** PXM은 Tool 실행 서버 역할만 한다.

## 2. 단계

| 단계 | 내용 | Rust 수정 | 착수 조건 |
|---|---|---|---|
| **1** | Tool Registry + Invoke API + Promtic 실연동 | **작음** — 종료 전이의 `outcome` 기록 1건 (9.1) | 지금 |
| **2** | LLM Node (입력 → LLM 1회 호출 → 구조화 결과) | 없음(권고안) | 1단계 사용 후 "워크플로우 안에서도 AI 판단이 필요하다"가 확인되면 |
| **3** | Agent Node (LLM ↔ Tool 반복) | 큼 | 2단계 사용 후 실제 요구 확인 시 |
| 별도 | MCP Adapter | 없음 | 1단계 안정화 이후 |
| 별도 트랙 | Resource Grant 권한 통합 | — | 이 기능과 분리해 진행 |

LLM Node와 Agent Node는 **다른 개념이다.** 단순 분류·요약·판정에 Agent Runtime을 태우지 않는다.

---

# 1단계 설계

## 3. Tool Registry

Tool은 워크플로우와 **수명주기가 다르다.** 워크플로우가 재배포돼도 Tool 계약은 그대로여야 한다.
따라서 워크플로우 문서 안에 넣지 않고 별도 컬렉션에 둔다.

### 3.1 스키마

```
pxm_ai_tools
  _id                    tool id (uuid)
  name                   Tool 이름. ^[a-z][a-z0-9_]{2,63}$
  display_name           콘솔 표시명
  description            LLM이 읽는 설명 (필수)
  definition_id          연결 워크플로우 id
  pinned_version         고정된 워크플로우 버전 (필수, null 금지)
  input_schema           JSON Schema (벤더 중립)
  output_schema          JSON Schema | null
  output_contract        "declared" | "free_form"
  side_effect            "read_only" | "mutating" | "requires_approval"
  group_id               소유 그룹. 권한 판정의 기준
  tenant_id              null. 예약 필드. 권한 판정에 사용하지 않는다
  status                 "draft" | "active" | "disabled"
  tags                   string[]
  resource_digest        의존 자원 스냅샷 (권한 아님, 진단용)
  invoke_defaults        { mode, sync_timeout_ms }
  created_by / created_at / updated_by / updated_at
```

인덱스:

| 인덱스 | 용도 |
|---|---|
| `{ group_id: 1, name: 1 }` **unique** | 이름 유일성 (4장) |
| `{ group_id: 1, status: 1, updated_at: -1 }` | 목록 조회 |
| `{ definition_id: 1, pinned_version: 1 }` | 워크플로우 역참조, 재배포 영향 분석 |
| `{ tags: 1, status: 1 }` | 태그 기반 Tool 선택 |

PostgreSQL은 `infra/db/migrations/012_ai_tool_registry.sql`에 같은 테이블을 추가한다.
저장소는 기존 패턴(`ToolRegistryRepositoryPort` 추상 클래스 + Mongo/PG 어댑터 + `db.module` 등록)을 따른다.

### 3.2 pinned_version

**워크플로우 재배포와 Tool 계약 변경은 분리한다.**

- Tool은 항상 특정 버전을 실행한다. 최신 배포본을 따라가지 않는다
- 워크플로우를 재배포해도 Tool은 기존 버전을 계속 실행한다
- 새 버전을 쓰려면 `POST /api/tools/:id/rebind`를 명시적으로 호출한다
- rebind 시 **스키마 diff를 보여주고 확인을 받는다.** 입력 필수 항목 추가/삭제, 타입 변경, 출력 스키마 변경은 하위 호환이 깨지는 변경으로 표시한다

LLM이 알고 있는 계약과 실제 실행 대상이 말없이 달라지면 안 된다는 것이 이 규칙의 이유다.

### 3.3 tenant_id

`tenant_id`는 **nullable 예약 필드**다.

- 현재 PXM에 멀티테넌시는 없다 (`docs/features.md` 8장)
- 온프레미스 설치 단위가 사실상 고객사 경계다
- Tenant와 Group은 의미가 다르므로 **`tenant_id`에 `group_id` 값을 복사해 넣지 않는다**
- 모든 권한 판정은 `group_id`로 한다. `tenant_id`를 읽는 코드는 1단계에 존재하지 않는다

멀티테넌시를 도입할 때 컬럼 추가 없이 채울 수 있도록 자리만 둔다.

### 3.4 side_effect

하네스가 실행 전 정책을 적용할 근거다. PXM이 제공하지 않으면 하네스가 만들 수 없다.

| 값 | 의미 | 하네스의 통상 처리 |
|---|---|---|
| `read_only` | 조회만 한다 | 확인 없이 실행 |
| `mutating` | 외부 상태를 바꾼다 | 사용자 확인 후 실행 |
| `requires_approval` | 실행 경로에 결재 노드가 있다 | 승인 대기 응답을 전제로 실행 |

**최종 정책 집행은 LLM이 아니라 PXM이 한다.** `side_effect`는 힌트이며, 실제 차단은
워크플로우 권한과 결재 노드가 수행한다. 하네스가 `read_only`로 잘못 판단해도 PXM의
권한 검사와 결재는 그대로 동작한다.

`requires_approval`은 publish 시 워크플로우 그래프에 `approval` 노드가 있으면 자동 제안하고,
`read_only`는 설계자가 명시적으로 선언한다(자동 판정하지 않는다).

## 4. Tool 이름과 namespace

### 4.1 유일성

**`(group_id, name)` 단위로 유일하다.** 전역 유일이 아니다.

여러 그룹이 같은 업무 이름(`investigate_access`)을 쓸 수 있어야 하기 때문이다.
그룹 간 이름 조율을 강제하면 조직마다 접두사를 붙이게 되고, 그 접두사가 LLM 프롬프트에
그대로 노출된다.

### 4.2 tool_namespace

한정 이름(qualified name)의 접두사는 **그룹 표시명에서 파생하지 않는다.**
그룹 이름은 바뀔 수 있고, 바뀌면 LLM이 알고 있던 Tool 이름이 따라 바뀐다.

`PxmGroup`에 **생성 후 변경되지 않는** `tool_namespace`를 둔다.

| 항목 | 규칙 |
|---|---|
| 형식 | `^[a-z][a-z0-9_]{1,31}$` |
| 유일성 | 전역 unique |
| 생성 | 그룹 생성 시 부여. 그룹 이름에서 초기값을 제안하되 **저장 후에는 그룹 이름과 무관** |
| 변경 | **불가.** 그룹 표시명·설명을 바꿔도 변하지 않는다 |
| 기존 그룹 | 마이그레이션에서 1회 부여. 충돌 시 숫자 접미사 |
| 삭제된 그룹 | 값을 해제하지 않는다. 재사용 금지 |

`tool_namespace`는 그룹의 표시 속성이 아니라 **식별자**다. 콘솔에서는 읽기 전용으로 보여준다.

```
qualified_name = {tool_namespace}__{name}
                 secops__investigate_access
```

`(group_id, name)`이 유일하고 `tool_namespace`가 그룹별로 유일하며 불변이므로,
`qualified_name`은 **Tool의 수명 동안 변하지 않는다.**

### 4.3 평소에는 Tool name만 노출한다

API Key 하나가 여러 그룹에 속할 수 있으므로 목록 응답에 같은 `name`이 둘 이상 나올 수 있다.
**충돌이 있을 때만** 한정 이름을 쓴다.

응답은 두 이름을 **항상 함께** 준다.

```json
{
  "tools": [
    {
      "name": "investigate_access",
      "qualified_name": "secops__investigate_access",
      "group_id": "...", "group_name": "보안운영팀",
      "tool_namespace": "secops",
      "name_conflict": false,
      "description": "...", "input_schema": {...}, "output_schema": {...},
      "output_contract": "declared",
      "side_effect": "read_only"
    }
  ],
  "has_name_conflict": false
}
```

`naming` 쿼리 파라미터로 LLM에 넣을 이름을 고른다.

| `naming` | 동작 |
|---|---|
| `auto` (기본) | **충돌하는 Tool만** `qualified_name`을 `name` 자리에 넣는다 |
| `qualified` | 전부 `qualified_name`을 쓴다 |
| `plain` | 전부 `name`을 쓴다. 충돌이 있으면 `409`와 충돌 목록을 반환한다 |

> `qualified_name` 자체는 불변이지만, `auto`에서 **어느 이름이 선택되는지**는 키의 그룹 권한이
> 바뀌면 달라질 수 있다. 여러 턴에 걸쳐 Tool 이름을 캐시하는 하네스는 `naming=qualified`를
> 고정하는 편이 안전하다. 이 주의사항은 API 문서에 명시한다.

### 4.4 Invoke 시점의 이름 해석

```
POST /api/v1/tools/{name}/invoke
```

| `{name}` 형태 | 해석 |
|---|---|
| `secops__investigate_access` | qualified. 그룹까지 확정 |
| `investigate_access` | 키의 접근 가능 그룹 안에서 유일하면 실행 |
| `investigate_access` + body `group_id` | 명시된 그룹으로 확정 |

plain 이름이 둘 이상에 해당하면 실행하지 않고 `409 TOOL_NAME_AMBIGUOUS`와 후보 목록을
반환한다. **추측해서 실행하지 않는다.**

## 5. Input / Output Schema

Tool을 공개하는 순간 스키마가 **API 계약**이 된다.

### 5.1 Input Schema

Start 노드의 `formSchema`를 기본 원천으로 삼아 JSON Schema를 파생한다.

| FormField | JSON Schema |
|---|---|
| `id` | property key |
| `type: text / textarea` | `"string"` |
| `type: number` | `"number"` |
| `type: checkbox` | `"boolean"` |
| `type: select / radio` + `options` | `"string"` + `enum` |
| `type: date` | `"string"`, `format: "date"` |
| `type: file` | **지원하지 않는다.** publish 차단 |
| `required` | `required[]` |
| `min` / `max` / `minLength` / `maxLength` / `pattern` | 그대로 |
| `label` + `helperText` | `description` — **LLM이 읽는 부분** |
| `condition` (조건부 표시) | 스키마로 옮기지 않는다. `description`에 서술 |

publish 화면에서 파생 결과를 보여주고 **수동 override를 허용한다.** override하면
`input_schema_source: "manual"`로 기록하고, 이후 워크플로우 `formSchema`가 바뀌어도
자동 갱신하지 않는다(rebind 시 diff로 알린다).

**`formSchema`를 실행 계약으로 승격한다.** 지금 `formSchema`는 화면 렌더링 전용이고
실행 API는 `formData`를 검증 없이 통과시킨다. 검증기 자체는
`validateInputPresetValues`(`apps/api/src/templates/templates.controller.ts`)로 이미 있으나
입력 프리셋 저장에만 쓰인다. 이 검증을 실행 경로에서도 수행한다.

- 대상: `POST /api/v1/templates/:id/execute`, `POST /api/v1/tools/:name/invoke`
- 기존 워크플로우 호환: `formSchema`가 없거나 필드가 0개면 검증하지 않는다(현재 동작 유지)
- Tool을 통한 실행은 `formSchema` 없이 publish할 수 없다

### 5.2 Output Schema

End 노드에 `resultSchema`(JSON Schema, 선택)를 추가한다. 엔진은 이 값을 읽지 않는다.
End 노드가 `resultPath`로 `context.result`를 채우는 기존 동작은 그대로다.

| 상태 | `output_contract` | publish |
|---|---|---|
| `resultSchema` 있음 | `declared` | 통과 |
| 없음 | `free_form` | **경고 후 통과.** 차단하지 않는다 |

Output Schema가 없어도 LLM은 결과를 쓸 수 있다. 다만 목록 응답에 `output_contract`를
함께 주어 하네스가 판단할 수 있게 한다.

### 5.3 스키마 방언 제한

모델마다 받아들이는 JSON Schema 범위가 다르다. 일부는 OpenAPI 제한 서브셋만 받는다.
Registry는 **보수적인 서브셋**을 권장하고 publish 시 점검한다.

| 검사 | 처리 |
|---|---|
| 최상위가 `object`가 아님 | **차단** |
| `type: file` 필드 포함 | **차단** |
| property에 `description` 없음 | **경고** — LLM 선택 정확도에 직접 영향 |
| `$ref` 사용 | **경고** — 일부 모델에서 표현되지 않는다 |
| `oneOf` / `anyOf` / `allOf` | **경고** |
| 3단계 이상 중첩, `additionalProperties`가 객체 | **경고** |

경고는 publish 화면에 표시하고 응답의 `warnings[]`로도 반환한다. 막지는 않는다.

## 6. 권한

**Tool은 새 권한 축을 만들지 않는다.**

Credential / JS 라이브러리 / Plugin / Command / API Key의 권한 모델이 이미 분산되어 있고,
Resource Grant 통합은 별도 트랙으로 진행한다. 그 통합 전에 Tool이 독자 권한 어휘를 만들면
통합 대상만 하나 늘어난다.

> **규칙: Tool 접근 권한 = 연결된 워크플로우의 실행 권한.**
> Tool은 워크플로우 권한의 별칭이며 독립 권한이 아니다.

판정 순서:

```
1. API Key에 tool:invoke scope 가 있는가          (tool:read 는 목록 조회)
2. tool.group_id ∈ actor.group_ids                (기존 canReadTemplate 규칙)
3. tool.definition_id ∈ actor.allowed_workflow_ids (기존 assertCanExecuteWorkflow 규칙)
4. tool.status == "active"
```

2·3번은 `apps/api/src/templates/templates.controller.ts`의 기존 함수를 그대로 재사용한다.

새로 추가하는 것은 scope 2개뿐이다.

| scope | 용도 |
|---|---|
| `tool:read` | `GET /api/v1/tools` 목록·상세 |
| `tool:invoke` | `POST /api/v1/tools/:name/invoke` |

이 둘은 권한 축이 아니라 **키 용도 구분**이다. "Tool만 호출하고 워크플로우 목록은 볼 수 없는
하네스 전용 키"를 표현하기 위해 나눈다. 그 아래에서는 여전히 그룹과 워크플로우 allowlist가
적용된다.

`resource_digest`(의존 플러그인 / JS 라이브러리 / 자격증명 목록)는 **권한이 아니라 진단
정보**다. publish 시점에 계산해 저장하고, 자원이 비활성화되면 Tool 상세에 경고를 표시한다.
나중에 Resource Grant 트랙이 이 지점을 흡수한다.

`required_scopes` 같은 Tool 전용 권한 필드는 **두지 않는다.**

`on_behalf_of`가 함께 오면 여기에 **축소 조건이 하나 더** 붙는다. 권한을 넓히는 일은 없다 (7.2).

## 7. 호출자 신원과 상관관계

### 7.1 두 개의 신원을 구분한다

| 구분 | 무엇의 신원인가 | 상태 |
|---|---|---|
| API Key | **호출 애플리케이션** (Promtic 등) | 인증됨 |
| `on_behalf_of` | **최종 사용자** (챗봇에 질문한 사람) | 주장됨 — 검증이 필요하다 |

**둘 다 Trace와 감사 기록에 남긴다.** 하나로 합치거나 한쪽을 다른 쪽으로 덮어쓰지 않는다.
"어떤 애플리케이션이, 누구를 대신해서" 실행했는지가 모두 필요하다.

### 7.2 on_behalf_of

#### 식별자

**변하지 않는 외부 사용자 ID를 기준으로 한다.** 이메일과 사번은 표시·감사용 부가 속성일 뿐
식별자가 아니다. 사람은 부서를 옮기고 이메일을 바꾼다.

```json
"on_behalf_of": {
  "provider": "promtic",
  "subject": "u-7f3a91c2",
  "attributes": { "email": "kim@corp.example", "employee_no": "E20231" }
}
```

| 필드 | 규칙 |
|---|---|
| `provider` | 기존 `normalizeExternalProvider` 재사용. `^[A-Za-z0-9][A-Za-z0-9._-]*$`, 100자 이하 |
| `subject` | 기존 `normalizeExternalSubject` 재사용. 200자 이하, 제어문자 금지 |
| `attributes` | 선택. 표시·감사 전용. **권한 판정에 절대 사용하지 않는다** |

> 필드 이름은 `source`가 아니라 **`provider`** 로 둔다. 기존
> `ExternalPrincipalMapping.provider`, `approver.principal.{provider, subject}`와 같은 어휘이고,
> `trace_context.source`(호출 경로 종류)와 의미가 충돌하지 않게 하기 위함이다.

#### 기존 ExternalPrincipalMapping 재사용

`{provider, subject}`는 이미 PXM에 있는 외부 주체 식별 형태다. 새 매핑 체계를 만들지 않는다.

```
findExternalPrincipalMapping(provider, subject)
  → { pxm_user_id, group_id, display_name, email, department, status }
```

- 컬렉션 `v2_external_principal_mappings`, `{provider, subject}` unique
- 상태가 `active`가 아니면 매핑되지 않은 것으로 본다

> **알려진 제약:** 매핑은 `{provider, subject}`에 전역 unique이고 행마다 `group_id`가 하나다.
> 한 외부 사용자가 여러 그룹에 속하는 경우를 매핑 행으로 표현할 수 없다.
> 따라서 유효 그룹 집합은 `mapping.group_id`가 아니라
> **`mapping.pxm_user_id` → `PxmUser.group_ids`** 에서 얻는다.
> `mapping.group_id`는 매핑 관리 화면의 소유 그룹으로만 쓴다.

#### 가장(impersonation) 방지

호출자가 임의의 사용자를 주장할 수 있으면 `on_behalf_of`는 권한 근거가 될 수 없다.
API Key에 정책을 둔다.

```
pxm_api_keys 에 추가
  on_behalf_of_policy           "forbidden" | "mapped_only" | "asserted"
  allowed_on_behalf_providers   string[]
```

| policy | 동작 |
|---|---|
| `forbidden` (**기본값**) | `on_behalf_of`가 오면 `400`. 기존 키의 동작을 바꾸지 않는다 |
| `mapped_only` (**권장**) | 활성 매핑이 있어야 한다. 없으면 `403 ON_BEHALF_OF_NOT_MAPPED` |
| `asserted` | 매핑 없이 값을 **기록만** 한다. 권한에 영향을 주지 않는다 |

금지 규칙:

- `provider: "pxm"`은 `on_behalf_of`에서 **금지**한다 (`400`). PXM 내부 계정 가장을 막는다
- `allowed_on_behalf_providers`에 없는 provider는 `403`. 빈 배열이면 모두 거부
- `attributes`의 값은 매핑 조회에 쓰지 않는다. 조회 키는 `{provider, subject}`뿐이다

#### 권한 효과 — 넓히지 않는다

> **규칙: `on_behalf_of`는 권한을 축소만 한다. 확대하는 경로는 존재하지 않는다.**

```
실행 가능 = API Key 권한
            ∩ (policy == "mapped_only" 이면) 매핑된 PXM 사용자의 권한
```

- `mapped_only`에서 매핑 사용자가 접근할 수 없는 Tool은 `GET /tools`에 나오지 않고
  invoke도 `404`다 (권한 밖은 숨긴다는 기존 오류 계약)
- `asserted`에서는 API Key 권한만 적용된다. 하네스가 문자열을 자유롭게 넣을 수 있으므로
  **권한 근거로 쓰면 안 된다.** 감사 추적 용도로만 허용한다
- 매핑 사용자가 `disabled`·`deleted`이면 매핑 없음으로 처리한다

#### 기록

| 위치 | 내용 |
|---|---|
| `instance.access.caller` | `api_key_id`, `owner_type`, `owner_id` |
| `instance.access.on_behalf_of` | `provider`, `subject`, `resolved_pxm_user_id`, `policy` |
| `runtime.snapshot.business_actor` | 기존 필드 유지 (외부 시스템이 전달한 업무 수행자) |
| API Key 호출 이력 | 두 신원을 **각각** 남긴다 |
| Tool 호출 이력 | 두 신원 + `trace_context` |

`attributes`는 그대로 저장하지 않고 민감 키 검사(`findSensitivePresetPaths`)를 통과한 것만 남긴다.

### 7.3 trace_context

하네스가 한 번의 사용자 요청에서 Tool을 여러 번 호출한다. PXM 쪽에서 보면 무관한 실행
N개이므로 "이 상호작용이 무엇을 실행했는가"를 묶을 수 없다.

**PXM Core는 특정 하네스의 대화 개념에 종속되지 않는다.** 범용 상관관계 식별자만 받는다.

```
trace_context
  correlation_id    상위 상호작용 묶음 식별자
  interaction_id    단일 상호작용 식별자
  source            "ai_harness" | "api_client" | "console" | "schedule" | "db_watch"
  attributes        제한된 key/value (선택)
```

| PXM 필드 | Promtic | 다른 소비자 예 |
|---|---|---|
| `correlation_id` | `conversation_id` | 티켓 번호, 배치 실행 id |
| `interaction_id` | `turn_id` | 개별 요청 id |
| `source` | `"ai_harness"` | `"api_client"` |

매핑은 **하네스 쪽에서** 한다. PXM 코드와 DB에 `conversation`, `turn`, `promtic` 같은
이름이 등장하면 안 된다.

`trace_context.source`는 **호출 경로의 종류**이고 `on_behalf_of.provider`는 **외부 신원 체계**다.
이름이 비슷하지만 다른 값이다.

제약:

| 항목 | 값 |
|---|---|
| id 형식 | `^[A-Za-z0-9._:-]{1,128}$` (기존 `X-Request-ID` 규칙과 동일) |
| `attributes` | 최대 10개 키, 키 64자 / 값 256자 이하, 문자열만 |
| 민감정보 | 기존 민감 키 탐지(`findSensitivePresetPaths`)를 적용해 거부 |
| 신뢰 수준 | **외부 입력이다.** 권한 판정에 사용하지 않는다. 조회·감사용 |

저장 위치는 기존 `business_actor`와 같다.

- `instance.access.trace_context`
- `context.runtime.snapshot.trace_context`

조회:

```
GET /api/v1/instances?correlation_id=...&interaction_id=...
```

**이 필드는 1단계에 넣는다.** 나중에 추가하면 과거 실행에 소급할 수 없다.

## 8. API

### 8.1 관리 (`/api`, 콘솔 · group_manager)

| 메서드 | 경로 | 내용 |
|---|---|---|
| `GET` | `/api/tools` | 목록 (관리 관점, 비활성 포함) |
| `POST` | `/api/tools` | publish. 워크플로우 + 버전 → Tool |
| `GET` | `/api/tools/:id` | 상세 + `resource_digest` 상태 + 경고 |
| `PATCH` | `/api/tools/:id` | description / tags / side_effect / status |
| `POST` | `/api/tools/:id/rebind` | `pinned_version` 갱신. 스키마 diff 확인 필요 |
| `DELETE` | `/api/tools/:id` | 삭제 |
| `POST` | `/api/tools/:id/test` | 시험 호출 (콘솔에서 인자 넣어 실행) |
| `GET` | `/api/tools/:id/invocations` | 호출 이력 |

`POST`·`PATCH`·`DELETE`·`rebind`는 `assertCanManageGroup(actor, tool.group_id)`를 적용한다.
API Key로는 관리 API를 호출할 수 없다(기존 규칙).

### 8.2 공개 (`/api/v1`, 하네스용 API Key)

| 메서드 | 경로 | scope |
|---|---|---|
| `GET` | `/api/v1/tools` | `tool:read` |
| `GET` | `/api/v1/tools/:name` | `tool:read` |
| `POST` | `/api/v1/tools/:name/invoke` | `tool:invoke` |

`GET /api/v1/tools` 쿼리: `tags`, `side_effect`, `naming`, `on_behalf_of`.

응답은 **그대로 LLM tool definition 배열로 변환 가능한 모양**으로 준다.

### 8.3 Invoke 요청

```json
POST /api/v1/tools/investigate_access/invoke
Idempotency-Key: <선택>

{
  "arguments": { "user_id": "E20231", "date": "2026-09-20" },
  "group_id": "...",
  "on_behalf_of": {
    "provider": "promtic",
    "subject": "u-7f3a91c2",
    "attributes": { "email": "kim@corp.example" }
  },
  "trace_context": {
    "correlation_id": "conv-8f1c",
    "interaction_id": "turn-3",
    "source": "ai_harness"
  },
  "mode": "sync",
  "sync_timeout_ms": 15000
}
```

`on_behalf_of`는 **최종 사용자**를, API Key는 **호출 애플리케이션**을 나타낸다.
검증 규칙과 권한 효과는 7.2에 있다.


### 8.4 Invoke 응답과 오류

**HTTP 상태 코드는 기존 의미를 유지한다.**

> `status: "error"` + HTTP 200은 **워크플로우가 정상 실행됐고 업무 결과가 실패**인 경우에만 쓴다.
> 입력 검증, 인증, 권한, Tool 미존재, 이름 충돌, 실행 실패, PXM 시스템 오류는 전부 4xx/5xx다.

응답은 인스턴스의 `state` + `outcome`(9.1)에서 직접 만든다. **Outbox를 조회하지 않는다.**

#### 정상 실행 결과 (2xx)

| `state` | `outcome` | status | HTTP | 설명 |
|---|---|---|---|---|
| `COMPLETED` | `SUCCESS` | `ok` | 200 | 업무 결과는 `result` |
| `COMPLETED` | `REJECTED` | `error` (`kind: "business"`) | 200 | 결재 반려. 워크플로우는 정상 완료했다 |
| `COMPLETED` | `FAILURE` | `error` (`kind: "business"`) | 200 | End 노드가 `outcome: "failure"`로 선언한 업무 실패 |
| `WAITING` (+ 결재 Task) | `null` | `pending_approval` | 202 | 오류가 아니다 |
| `CREATED` / `RUNNING` / `WAITING` | `null` | `running` | 202 | sync 제한 시간 초과 또는 `mode: "async"` |

```json
{
  "tool": "investigate_access",
  "qualified_name": "secops__investigate_access",
  "status": "pending_approval",
  "instance_id": "uuid",
  "result": null,
  "pending": {
    "reason": "approval_required",
    "node_id": "approval-1",
    "approvers": ["보안운영팀 관리자"]
  },
  "result_url":  "/api/v1/instances/uuid/result",
  "trace_url":   "/api/v1/instances/uuid/trace",
  "stream_url":  "/api/v1/instances/uuid/stream",
  "idempotent_replay": false,
  "request_id": "..."
}
```

업무 실패 응답 — `kind: "business"`는 **재시도 대상이 아니다.**

```json
{
  "tool": "investigate_access",
  "status": "error",
  "instance_id": "uuid",
  "error": {
    "kind": "business",
    "code": "APPROVAL_REJECTED",
    "message": "결재가 반려되었습니다.",
    "retryable": false
  },
  "result": null,
  "request_id": "..."
}
```

#### 실행 실패 — 원인별로 나눈다

`FAILED`를 하나의 HTTP 코드로 고정하지 않는다. 외부 API 장애와 설정 오류는 다른 문제다.

오류 본문에 **`code` · `failure_type` · `retryable`** 을 항상 담는다.

| `failure_type` | 원인 | `retryable` | HTTP |
|---|---|---|---|
| `configuration` | 노드 설정 오류, 대상 미지정, 필수 설정 누락 | `false` | **422** |
| `upstream_error` | 외부 시스템이 오류를 반환하거나 연결이 실패 | 연결 실패·5xx `true` / 4xx `false` | **502** |
| `timeout` | 노드 실행 또는 외부 호출 제한 시간 초과 | `true` | **504** |
| `script_error` | JS 노드 예외, Command 비정상 종료 | `false` | **500** |
| `subworkflow_failed` | `workflow_call` 자식 실패 | 자식의 값을 **승계** | 자식의 값을 승계 |
| `internal` | 분류할 수 없음 | `false` | **500** |

```json
{
  "statusCode": 502, "error": "Bad Gateway",
  "code": "TOOL_EXECUTION_FAILED",
  "failure_type": "upstream_error",
  "retryable": true,
  "message": "노드 실행이 실패했습니다.",
  "instance_id": "uuid",
  "failed_node_id": "service-2",
  "trace_url": "/api/v1/instances/uuid/trace",
  "request_id": "..."
}
```

> **하네스는 HTTP 상태 코드가 아니라 `retryable`을 기준으로 자동 재시도를 판단한다.**
> HTTP 코드는 사람과 중간 인프라(로그, 프록시, 모니터링)를 위한 것이고,
> 재시도 계약은 `retryable`이다. `retryable: true`에는 `Retry-After` 헤더를 함께 준다.

> **재시도 시 멱등성:** `retryable: true`라도 Tool의 `side_effect`가 `read_only`가 아니면
> 하네스는 **첫 호출과 같은 `Idempotency-Key`** 로 재시도해야 한다. 키 없이 재시도하면
> 새 인스턴스가 생성되어 부수효과가 두 번 일어난다.

`failure_type`과 `retryable`은 인스턴스의 `outcome_reason`(9.1)에 저장된 값을 그대로 전달한다.
Invoke API가 다시 추론하지 않는다.

#### 요청·권한 오류 (4xx)

기존 공개 API 오류 계약(`statusCode`, `error`, `code`, `message`, `request_id`, `X-Request-ID`)을
그대로 따른다. 아래는 워크플로우가 시작되기 전에 나는 오류이며 `retryable: false`다.

| code | HTTP | 상황 |
|---|---|---|
| `TOOL_INPUT_INVALID` | 400 | 입력이 `input_schema`를 위반 |
| `ON_BEHALF_OF_INVALID` | 400 | 형식 오류, `provider: "pxm"` 사용, 정책이 `forbidden` |
| `UNAUTHENTICATED` | 401 | API Key 인증 실패 |
| `MISSING_SCOPE` | 403 | `tool:invoke` 없음 |
| `ON_BEHALF_OF_NOT_MAPPED` | 403 | `mapped_only`인데 활성 매핑이 없다 |
| `TOOL_NOT_FOUND` | 404 | 없거나 권한 밖 (숨긴다) |
| `TOOL_NAME_AMBIGUOUS` | 409 | plain 이름이 여러 그룹에 존재 |
| `TOOL_DISABLED` | 409 | `status != active` |
| `TOOL_VERSION_UNAVAILABLE` | 409 | `pinned_version`이 없거나 비활성 |
| `TOOL_EXECUTION_TERMINATED` | 409 | 운영자가 인스턴스를 종료했다 (`outcome: CANCELLED`) |
| `RATE_LIMITED` | 429 | 기존 API Key rate limit. **`retryable: true`** |
| `INTERNAL_SERVER_ERROR` | 500 | PXM 자체 오류. 내부 예외·stack trace를 노출하지 않는다 |

입력 검증 실패는 **LLM이 스스로 고칠 수 있도록 구조화**해서 반환한다.

```json
{
  "statusCode": 400, "error": "Bad Request", "code": "TOOL_INPUT_INVALID",
  "failure_type": "configuration", "retryable": false,
  "message": "arguments does not match input_schema",
  "details": [
    { "path": "date", "code": "FORMAT", "message": "date must be YYYY-MM-DD" },
    { "path": "user_id", "code": "REQUIRED", "message": "user_id is required" }
  ],
  "request_id": "..."
}
```


## 9. 실행과 결과 판정

### 9.1 인스턴스 outcome — 1급 런타임 상태

**DB가 단일 진실 원본이고 Outbox는 전달 수단이다.** 업무 결과를 판정하려고 Outbox를 되읽지
않는다. 종료 결과를 인스턴스 런타임 상태에 **1급 필드**로 저장한다.

```
v2_process_instances
  state           CREATED | RUNNING | WAITING | COMPLETED | FAILED | TERMINATED   (기존)
  outcome         SUCCESS | REJECTED | FAILURE | CANCELLED | null                 (신규)
  outcome_reason  { code, failure_type, retryable, message, node_id } | null      (신규)
```

유효한 조합:

| `state` | `outcome` | 언제 |
|---|---|---|
| `CREATED` / `RUNNING` / `WAITING` | `null` | 진행 중 |
| `COMPLETED` | `SUCCESS` | 정상 종료 (기본값) |
| `COMPLETED` | `REJECTED` | 결재 반려로 종료 |
| `COMPLETED` | `FAILURE` | End 노드가 `outcome: "failure"`로 선언 |
| `FAILED` | `FAILURE` | 노드 실행 실패 (재시도 소진 포함) |
| `TERMINATED` | `CANCELLED` | 운영자 또는 API가 종료 |

규칙:

- **종료 상태와 `outcome`은 같은 트랜잭션에서 함께 쓴다.** 둘이 어긋난 순간이 존재하면 안 된다
- 종료 상태가 아니면 `outcome`은 반드시 `null`이다
- `outcome_reason`은 `FAILURE`와 `REJECTED`에만 채운다
- Outbox의 `INSTANCE_COMPLETED` / `INSTANCE_FAILED` 페이로드에 `outcome`과 `outcome_reason`을
  **실어 보내기만** 한다. 소비자가 Outbox에서 결과를 재구성할 필요가 없다
- **기존 인스턴스는 `outcome`이 `null`이다.** 백필하지 않고 추론도 하지 않는다.
  운영 데이터가 없는 개발 단계에서 도입했으므로 추론 경로를 만들지 않았다

> **구현됨 (UX 3단계).** 마이그레이션은 `012_instance_outcome.sql`이다. 설계와 다른 점:
> `CANCELLED`에도 `outcome_reason`(취소 주체 `code`, `cancelled_by`)을 채운다.
> 아직 남은 것: `INSTANCE_FAILED` 이벤트 페이로드에 `outcome` 싣기,
> `subworkflow_failed`의 `retryable`을 자식에게서 물려받기(현재 항상 `false`),
> 디자이너에서 End 노드 `outcome` 선택.

`outcome_reason.failure_type`과 `retryable`은 **실패한 지점에서** 판정한다. 분류 기준은 8.4의 표를
따르며, Invoke API는 저장된 값을 그대로 전달할 뿐 다시 추론하지 않는다.

#### 필요한 변경

| 대상 | 내용 |
|---|---|
| `infra/db/migrations/012_instance_outcome.sql` | `v2_process_instances`에 `outcome`, `outcome_reason` 추가 (006의 `is_paused` 추가와 같은 형태) |
| `apps/engine/src/v2/ports.rs` | `update_instance`에 `outcome` 전달 경로 추가 |
| `apps/engine/src/v2/infrastructure/{mongo,postgres}_adapter.rs` | 각 1곳 |
| `apps/engine/src/v2/runtime.rs` | 종료 전이 지점(`COMPLETED` 2곳, `FAILED` 9곳)에서 `outcome` 지정 |
| `apps/api/src/instances/` | 종료(`TERMINATED`) 경로에서 `CANCELLED` 기록, 조회 응답에 `outcome` 노출 |

**이것이 1단계의 유일한 Rust 수정이다.** 실행 의미는 바꾸지 않는다 — 이미 결정된 종료 결과를
기록만 추가한다.

이 변경은 AI Tool과 무관하게 이득이 있다. 지금은 "결재 반려로 끝난 실행"과 "정상 완료된 실행"이
공개 API 응답에서 구분되지 않는다.

### 9.2 실행 흐름

```
POST /api/v1/tools/{name}/invoke
  1. 이름 해석            plain / qualified / group_id 명시  → 모호하면 409
  2. Tool 조회            status == active
  3. 호출자 신원          API Key 인증 (기존)
     on_behalf_of 검증    정책 확인 → 매핑 조회 → 유효 사용자 확정            (7.2)
  4. 권한 판정            tool:invoke + group_id + allowed_workflow_ids       (6장)
                          ∩ (mapped_only 이면) 매핑 사용자 권한
  5. 입력 검증            arguments ← input_schema                            → 실패 시 400
  6. 정의 로드            definition_id + pinned_version            ★ 최신 배포본 아님
  7. 실행                 기존 startWorkflow 본문 재사용
                            - ctx.data.formData        ← arguments
                            - access.trace_context     ← 요청의 trace_context
                            - access.on_behalf_of      ← 검증된 최종 사용자
                            - snapshot.business_actor  ← 기존 규칙 유지
                            - Idempotency-Key 처리 동일
  8. 대기                 mode=sync 이면 기존 waitForInstanceResult
  9. 응답 변환            인스턴스의 state + outcome 만으로 판정 (Outbox 조회 없음)
                            COMPLETED / SUCCESS   → ok                200
                            COMPLETED / REJECTED  → error(business)   200
                            COMPLETED / FAILURE   → error(business)   200
                            WAITING + 결재 Task   → pending_approval  202
                            진행 중 / 시간 초과   → running           202
                            FAILED   / FAILURE    → outcome_reason.failure_type 으로 매핑 (8.4)
                            TERMINATED / CANCELLED→ 409 TOOL_EXECUTION_TERMINATED
```

6번이 기존 `execute`와 다른 유일한 지점이다. 현재 `findForExecution`은 최신 배포본을 반환하므로
**버전을 지정해 정의를 로드하는 경로**가 필요하다. 버전별 정의는 이미 저장되어 있다
(`GET /api/templates/:id/versions/:version`).

`startWorkflow`는 컨트롤러 private 메서드이므로 Tool에서도 호출할 수 있도록 서비스로 분리한다.
**실행 의미는 바꾸지 않는다.**


## 10. Publish 검증

publish 시 아래를 점검하고 결과를 화면과 응답의 `warnings[]`에 함께 담는다.

| 검사 | 차단 / 경고 |
|---|---|
| 워크플로우가 `PUBLISHED`이고 지정 버전이 존재하는가 | **차단** |
| Start 노드에 `formSchema`가 있고 필드가 1개 이상인가 | **차단** |
| `file` 타입 필드가 있는가 | **차단** |
| End 노드가 있는가 | **차단** |
| `(group_id, name)` 중복 | **차단** |
| 스키마 방언 제한 (5.3) | 경고 |
| End 노드에 `resultSchema`가 없음 | 경고 (`free_form`으로 기록) |
| property `description` 누락 | 경고 |
| 의존 자원(플러그인·JS 라이브러리·자격증명)이 소유 그룹에서 유효한가 | 경고 + `resource_digest` 저장 |
| 그래프에 `approval` 노드가 있는데 `side_effect != requires_approval` | 경고 |

---

# 2단계 이후 (방향과 계약)

**아직 착수하지 않는다.** 1단계 설계가 2단계를 막지 않도록 지킬 것만 기록한다.

## 11. LLM Node

입력 → LLM **1회** 호출 → 구조화된 결과 반환. 반복하지 않는다.

권고 구현: **새 노드 타입을 만들지 않고 `service` 노드 + `llm.chat` hosted 플러그인으로 시작한다.**

| 필요한 것 | `service` 노드가 이미 제공 |
|---|---|
| 설정 UI | 매니페스트 `config_schema` |
| 실행 데이터 참조 | `{{ formData.x }}`, `{{ data.outputs.y }}` |
| 자격증명 주입 | `credential_id` + `credential_binding` |
| 결과 기록 | `outputPath` |
| 재시도 · 타임아웃 · 감사 | 기존 정책 |

디자이너 팔레트에는 별도 노드로 보인다(플러그인은 이미 `nodeType: 'service'`로 팔레트에 들어간다).

**hosted로 만드는 이유:** Engine은 외부 포트를 열지 않고 DB 내부망에만 연결한다는 배포 전제가
있다(`docs/features.md` 9장). LLM 호출을 builtin(Rust)으로 만들면 Engine이 외부 egress를 갖게 되어
그 전제가 바뀐다. `plugin-host`에서 호출하면 방화벽을 plugin-host에만 열면 된다.

## 12. Model Provider

**새 추상 계층을 만들지 않는다.** 기존 플러그인 매니페스트가 이미 그 계층이다
(`plugin_id`, `version`, `config_schema`, `input_schema`, `output_schema`, `executor_type`,
`secrets_policy`, `timeout_ms`, `retry_policy`).

| plugin_id | 대상 | 우선순위 |
|---|---|---|
| `llm.openai_compatible.chat` | Ollama, vLLM, LM Studio, 사내 게이트웨이 | 1 — 온프렘 대부분을 커버한다 |
| `llm.ollama.chat` | Ollama 고유 기능 (`/api/chat`, `keep_alive`, `format`) | 2 |
| `llm.gemini.chat` | 외부 모델 선택지 | 3 |

**기본 구성은 Gemma + Ollama 완전 온프렘이다.** 외부 모델은 Provider 하나를 추가해
선택적으로 쓴다. 로컬 모델은 `credential_id` 없이 동작해야 한다.

Provider 추가에 Rust 수정은 필요 없다. 자격증명 대상은 노드 설정의 `credential_binding.target`으로
명시한다(엔진의 `infer_credential_target` 하드코딩 경로를 타지 않는다).

## 13. Capability와 Structured Output

모든 모델이 Tool Calling / JSON Schema / Structured Output을 같게 지원한다고 가정하지 않는다.
Capability는 **2계층**이다.

| 계층 | 위치 | 내용 |
|---|---|---|
| Provider capability | 플러그인 매니페스트 `capabilities` | 이 provider가 **표현할 수 있는** 것 |
| Model profile | `pxm_model_profiles` (신규) | 이 **모델**이 실제로 되는 것 + 운영 파라미터 |

```
pxm_model_profiles
  id, display_name
  provider_plugin_id          llm.openai_compatible.chat
  model                       gemma3:12b-it-qat
  endpoint_ref                http://ollama.internal:11434   (scheme+host 고정)
  credential_id               null 가능 (로컬 모델)
  capabilities                { tool_calling, structured_output, json_mode,
                                streaming, vision }
  max_context                 8192
  structured_output_strategy  native_schema | json_mode | prompted_json
  max_repair_attempts         2
  default_timeout_ms          120000
  group_id, status
```

3단 하강:

| 전략 | 조건 | 동작 |
|---|---|---|
| `native_schema` | 모델이 스키마 강제를 지원 | 스키마를 그대로 전달 |
| `json_mode` | JSON 형식만 강제 가능 | 스키마는 프롬프트로, 형식만 강제 |
| `prompted_json` | 둘 다 없음 | 스키마를 프롬프트에 서술 → 출력 파싱 |

**어느 전략이든 최종 스키마 검증은 PXM이 한다.** native 지원 모델도 신뢰하지 않는다.
검증 실패 시 오류 내용을 포함해 `max_repair_attempts`회까지 재요청한다.

### 13.1 벤더 종속 차단 규칙

> **Tool Registry와 LLM Node 설정은 JSON Schema만 저장한다.
> 벤더 포맷(OpenAI `tools[]`, Gemini `functionDeclarations`, 프롬프트 텍스트)으로의 변환은
> Provider Adapter 안에서만 일어난다.**

코드 리뷰에서 판정할 수 있는 형태로 적는다 — Registry·Tool DTO·노드 설정에 벤더 이름이
나오면 위반이다.

### 13.2 LLM 호출의 재시도 정책

LLM은 기존 플러그인 기본값과 맞지 않는다.

| 항목 | 기존 기본값 | LLM 기본값 | 이유 |
|---|---|---|---|
| `timeout_ms` | 5,000 | 60,000~180,000 | 로컬 모델은 첫 토큰까지 수초~수십초 |
| `max_attempts` | 3 (exponential) | **1** | LLM 재시도는 비싸고 **비멱등**이다 |

**재시도와 repair를 같은 카운터로 세지 않는다.**

- 재시도(retry): 연결 실패·타임아웃 복구. 기존 엔진 재시도 정책
- repair: 스키마 검증 실패 후 재요청. 플러그인 내부, `max_repair_attempts`

### 13.3 repair 관측 가능성

**repair 과정이 black box가 되면 안 된다.** 다음을 PXM 실행 Trace에서 확인할 수 있어야 한다.

| 항목 | 예 |
|---|---|
| provider / model | `llm.openai_compatible.chat` / `gemma3:12b-it-qat` |
| model profile | `mp-gemma-12b` |
| structured output 전략 | `prompted_json` |
| 일반 호출 횟수 | `generate: 1` |
| repair 횟수 | `repair: 2` |
| 스키마 검증 결과 | `passed` / `failed` |
| 각 repair의 실패 사유 | `["risk_level not in enum", "missing field: score"]` |
| 소요 시간 / 토큰 사용량 | `duration_ms`, `usage` |

노드 출력에 진단 블록을 함께 담는다. hosted 플러그인의 `output`은 그대로 컨텍스트에
반환되므로 **엔진 수정 없이** 동작한다.

```json
{
  "risk_level": "HIGH",
  "score": 82,
  "_llm": {
    "provider_plugin_id": "llm.openai_compatible.chat",
    "model_profile_id": "mp-gemma-12b",
    "model": "gemma3:12b-it-qat",
    "structured_output_strategy": "prompted_json",
    "attempts": { "generate": 1, "repair": 2 },
    "repair_reasons": ["risk_level not in enum", "missing field: score"],
    "schema_validation": "passed",
    "finish_reason": "stop",
    "usage": { "prompt_tokens": 1820, "completion_tokens": 96 },
    "duration_ms": 8410
  }
}
```

- 콘솔 실행 추적의 노드 상세에 위 항목을 표로 표시한다
- **프롬프트 본문과 모델 응답 원문은 기본 저장하지 않는다.** 개인정보와 용량 문제가 있다.
  노드 설정의 옵트인 옵션으로만 저장하고 길이 상한을 적용한다
- 진단 블록을 출력 본문과 완전히 분리된 채널로 옮기려면 엔진 수정이 필요하다.
  2단계에서는 `_llm` 키로 시작하고, 필요가 확인되면 별도 채널로 승격한다

## 14. Agent Node (3단계)

LLM ↔ Tool 반복. **실제 요구가 확인된 뒤에 착수한다.**

선결 조건:

- `execute_token_flow`는 `while let Some(token) = active_tokens.pop()`이고 **순환 탐지도 스텝
  상한도 없다**. Agent 루프를 그래프 사이클로 표현하면 한 트랜잭션 안에서 무한 루프가 된다.
  **루프는 노드 내부에서 돌리고, 스텝 상한을 먼저 넣는다**
- Tool이 결재로 `WAITING`이 되면 Agent 노드도 대기해야 한다.
  `workflow_call`의 하위 인스턴스 · 부모 resume · `call_depth` · `WORKFLOW_CALL_MAX_DEPTH`
  기구를 재사용하고, 옆에 `agent_iteration` 상한을 둔다
- Outbox 이벤트 추가: `AGENT_TURN`, `TOOL_SELECTED`, `TOOL_INVOKED`, `AGENT_COMPLETED`.
  없으면 "LLM이 왜 저 Tool을 골랐는가"를 추적할 수 없다

## 15. MCP Adapter

순서: **Workflow → Tool Registry → Invoke API → Promtic 실연동 → 안정화 → MCP Adapter.**

PXM 내부 Tool 모델이 MCP에 종속되지 않고, 안정된 Registry 위에 Adapter를 얹는다.
지금은 **필드 대응만 지켜둔다**(비용 0, 나중에 Registry 스키마를 바꾸지 않기 위해).

| Registry | MCP |
|---|---|
| `name` / `qualified_name` | `name` |
| `description` | `description` |
| `input_schema` | `inputSchema` |
| `output_schema` | `outputSchema` |
| `side_effect: read_only` | `annotations.readOnlyHint` |

저장하는 것은 중립 표준인 JSON Schema이고 MCP는 그 위의 변환이므로, 13.1의 벤더 종속 차단
규칙과 같은 원리로 종속이 생기지 않는다.

---

## 16. 명시적 비목표

| 항목 | 이유 |
|---|---|
| 1단계에서 실행 의미를 바꾸는 Rust 수정 | 종료 결과 기록(9.1) 외에는 엔진을 건드리지 않는다 |
| PXM 안의 Agent Loop (1·2단계) | Promtic이 담당한다 |
| Tool 전용 권한 모델 (`required_scopes` 등) | 워크플로우 권한의 별칭으로만 둔다 |
| `tenant_id`를 권한에 사용 | 멀티테넌시는 현재 없다. 예약 필드다 |
| Tool이 워크플로우를 생성·수정 | Tool은 **실행**만 한다 |
| LLM에 자격증명·비밀값 노출 | Tool 스키마와 결과에서 기존 민감정보 규칙을 그대로 적용한다 |
| Resource Grant 권한 통합 | 별도 트랙 |
| 파일 입출력 Tool | `formSchema`의 `file` 타입은 publish 차단 |
| `on_behalf_of`로 권한을 넓히는 경로 | 축소만 한다. 확대 경로는 만들지 않는다 (7.2) |
| SSO / OIDC 연동 | `on_behalf_of`는 외부 주체 **매핑**이지 인증 연동이 아니다 |

## 17. 미결 사항

| 질문 | 영향 | 필요 시점 |
|---|---|---|
| Tool 호출 이력을 API Key 호출 이력에 합칠지, 별도 컬렉션을 둘지 | 조회 화면, 보존 정책 | 1단계 중 |
| `on_behalf_of` 매핑이 없는 사용자의 기본 응대 (403 고정 / Tool별 허용) | `mapped_only` 정책 세부 | 1단계 중 |
| Model profile 관리 주체 (admin 전용 / group_manager 허용) | Resource Grant 트랙과 맞물림 | 2단계 착수 전 |
| sync 상한(`START_SYNC_MAX_TIMEOUT_MS` 30초) 조정 | LLM Node가 들어간 워크플로우를 Tool로 공개할 때 | 2단계 착수 전 |

결정된 사항:

| 항목 | 결정 |
|---|---|
| `on_behalf_of` 식별자 | 불변 외부 ID 기준 `{provider, subject}`. 이메일·사번은 `attributes`로만 (7.2) |
| 외부 주체 연결 | 기존 `ExternalPrincipalMapping` 재사용. 새 체계를 만들지 않는다 (7.2) |
| 가장 방지 | API Key의 `on_behalf_of_policy` + provider allowlist + `provider: "pxm"` 금지 (7.2) |
| 한정 이름 접두사 | 그룹 표시명 파생이 아닌 불변 `tool_namespace` (4.2) |
| 오류 표현 | 업무 실패만 `status: "error"` + 200. 나머지는 4xx/5xx (8.4) |
| 업무 결과 판정 | Outbox 조회 금지. 인스턴스의 `outcome`을 1급 상태로 저장 (9.1) |
| 실행 실패 표현 | `code` + `failure_type` + `retryable`. 하네스는 `retryable`로 재시도 판단 (8.4) |


## 18. 구현 태스크 (1단계)

### 실행 결과(outcome) 1급 상태화 — 9.1

이 묶음만 Rust를 건드린다. AI Tool과 독립적으로 먼저 넣어도 된다.

| # | 태스크 | 대상 | 선행 |
|---|---|---|---|
| T-0A | `infra/db/migrations/013_instance_outcome.sql` + Mongo 필드·인덱스 | `infra/db/`, `apps/api/src/db/` | — |
| T-0B | `update_instance`에 `outcome` 전달 경로 + Mongo/PG 어댑터 | `apps/engine/src/v2/ports.rs`, `infrastructure/` | T-0A |
| T-0C | 종료 전이에서 `outcome` · `outcome_reason` 기록 (`COMPLETED` 2곳, `FAILED` 9곳) + `failure_type` 분류 | `apps/engine/src/v2/runtime.rs` | T-0B |
| T-0D | 종료(`TERMINATED`) 경로에서 `CANCELLED` 기록 + 조회 응답에 `outcome` 노출 (`outcome_inferred` 포함) | `apps/api/src/instances/` | T-0A |
| T-0E | Outbox `INSTANCE_COMPLETED` / `INSTANCE_FAILED` 페이로드에 `outcome` 실어 보내기 | `apps/engine/src/v2/runtime.rs` | T-0C |

### 기반

| # | 태스크 | 대상 | 선행 |
|---|---|---|---|
| T-01 | `ToolRegistryRepositoryPort` + Mongo/PG 어댑터 + `db.module` 등록 | `apps/api/src/db/` | — |
| T-02 | `infra/db/migrations/012_ai_tool_registry.sql` | `infra/db/` | T-01 |
| T-03 | `PxmGroup.tool_namespace` 추가 + 기존 그룹 1회 부여 마이그레이션 + unique 인덱스 | `apps/api/src/authz/`, `apps/api/src/db/` | — |
| T-04 | `formSchema` → JSON Schema 변환기 + 단위 테스트 | `apps/api/src/tools/` | — |
| T-05 | 스키마 방언 제한 검사기 (5.3) | `apps/api/src/tools/` | T-04 |
| T-06 | End 노드 `resultSchema` · `outcome` 설정 추가 (디자이너 + DTO) | `apps/web/`, `apps/api/` | — |
| T-07 | `startWorkflow`를 서비스로 분리 + **버전 지정 실행** 경로 | `apps/api/src/templates/` | — |
| T-08 | 실행 경로 입력 검증 (`validateInputPresetValues` 재사용) | `apps/api/src/templates/` | T-07 |
| T-09 | `trace_context` 수용·저장·조회 (`access`, `snapshot`, 인스턴스 필터) | `apps/api/src/instances/`, `templates/` | T-07 |
| T-10 | API Key에 `on_behalf_of_policy` + `allowed_on_behalf_providers` 추가 + 발급 화면 | `apps/api/src/authz/`, `apps/web/` | — |
| T-11 | `on_behalf_of` 해석기 (형식 검증 → 정책 → 매핑 조회 → 권한 교집합) + 단위 테스트 | `apps/api/src/authz/` | T-10 |
| T-12 | scope `tool:read` / `tool:invoke` 추가 + 발급 화면 | `apps/api/src/authz/`, `apps/web/` | — |

### 기능

| # | 태스크 | 대상 | 선행 |
|---|---|---|---|
| T-13 | Tool Registry 관리 API (`/api/tools` CRUD + rebind + test) | `apps/api/src/tools/` | T-01~T-05 |
| T-14 | publish 검증 파이프라인 (10장) + `resource_digest` 계산 | `apps/api/src/tools/` | T-13 |
| T-15 | 공개 API `GET /api/v1/tools` + 이름 충돌 처리 · `naming` (4.3) | `apps/api/src/tools/` | T-13, T-03 |
| T-16 | 공개 API `POST /api/v1/tools/:name/invoke` + 응답·오류 계약 (8.4) | `apps/api/src/tools/` | T-07, T-11, T-15 |
| T-17 | Invoke 응답 변환 — `state` + `outcome` → 4상태 / `failure_type` → HTTP 매핑 | `apps/api/src/tools/` | T-16, T-0A~T-0D |

### 화면

| # | 태스크 | 대상 | 선행 |
|---|---|---|---|
| T-18 | Tool 카탈로그 (목록 / 상세 / 상태 / 의존 자원 경고) | `apps/web/src/` | T-13 |
| T-19 | 디자이너 "Tool로 게시" + 스키마 미리보기 · 경고 | `apps/web/src/flow-designer/` | T-13, T-14 |
| T-20 | rebind 스키마 diff 화면 | `apps/web/src/` | T-13 |
| T-21 | Tool 호출 이력 — **두 신원 분리 표시** + `correlation_id` 묶음 조회 | `apps/web/src/` | T-16 |
| T-22 | 그룹 화면에 `tool_namespace` 읽기 전용 표시 | `apps/web/src/authz/` | T-03 |

### 마감

| # | 태스크 | 대상 | 선행 |
|---|---|---|---|
| T-23 | `openapi.json` 재생성 (`pnpm --filter api build`) | `apps/api/` | T-15, T-16 |
| T-24 | 문서 갱신: `features.md`, `public-api-v1.md`, `README.md` | `docs/` | T-23 |
| T-25 | E2E: publish → 목록 → invoke → 결재 대기 → 승인 → 결과 | `apps/e2e/` | T-16~T-21 |
| T-26 | 보안 테스트: 가장 시도 거부, 권한 확대 불가, 권한 밖 Tool 404 | `apps/api/` | T-11, T-16 |

**T-07~T-09는 AI Tool과 무관하게 이득이 있다** — 공개 API 소비자의 입력 검증, 버전 지정 실행,
상관관계 추적. 선행 작업으로 먼저 넣어도 된다.

**T-26은 생략하지 않는다.** `on_behalf_of`는 외부 입력이고, 검증이 빠지면 호출자가 임의의
사용자를 가장할 수 있다.
