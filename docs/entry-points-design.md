# 외부 호출 입구 설계 — 실행 API · AI Tool · 게이트웨이 라우트 (설계)

PXM 워크플로우를 바깥에서 부르는 **입구**를 어떤 구조로 내놓을지 정한다. NIT PXM-68.
**설계 확정, 아직 구현하지 않았다.** 구현하면 `docs/features.md`에 반영한다.

- AI Tool의 세부(스키마 파생, 이름 충돌, 최종 사용자 검증, 호출 추적, LLM Node 이후 단계)는 `docs/ai-tool-publish-design.md`
- 이 문서는 세 입구의 **공통 구조**와 **게이트웨이 라우트**를 정한다
- 관련 이슈: PXM-69~72(AI 연동), PXM-74~77(게이트웨이)

---

## 1. 입구는 세 가지, 실행은 하나

세 입구 모두 **안에서는 같은 실행 기능**(워크플로우 시작 → 엔진 실행 → 결과 대기)을 쓴다.
다른 것은 바깥에서 보이는 이름표와 응답 모양이다.

| | 기존 실행 API | AI Tool | 게이트웨이 라우트 |
|---|---|---|---|
| 부르는 쪽 | PXM을 아는 외부 시스템 | AI 하네스(Promptic 등) | PXM이 있는 줄 모르는 기존 클라이언트 |
| 주소·이름 | `POST /api/v1/templates/{uuid}/execute` | `investigate_access` | `POST /gw/{namespace}/permissions` |
| 요청 | `{ "input": {...} }` | LLM이 채운 인자 | 백엔드가 원래 받던 형식 |
| 응답 | PXM 형식 (`instance_id`, `status`) | Tool 결과 4상태 | **백엔드 응답 그대로** |
| 실행 버전 | 최신 배포본 | **고정 버전** | **고정 버전** |
| 설명서 | `execute` 하나 | LLM에 주는 Tool 목록 | 라우트별 Swagger |
| 등록 | 필요 없음 | 게시 필요 | 게시 필요 |

- 기존 실행 API는 **그대로 유지**한다. 범용 입구다
- AI Tool과 게이트웨이 라우트는 **게시(publish)** 해야 생기는 입구다. 이 둘을 이 문서에서 "진입점"이라 부른다

## 2. 진입점 공통 모델

AI Tool과 게이트웨이 라우트는 등록·버전 고정·입력 계약·권한·승인·이력·설명서가 같다. **저장소 하나에 종류(`kind`)로 구분해 둔다.**
따로 두면 등록·권한·이력·버전 교체를 두 번 만든다.

```
pxm_entry_points
  _id                  진입점 id
  kind                 "tool" | "route"
  group_id             소유 그룹. 권한 판정 기준
  tenant_id            null (예약)
  definition_id        연결 워크플로우
  pinned_version       고정 버전 (필수). 재배포해도 바뀌지 않는다
  input_schema         JSON Schema (벤더 중립)
  output_schema        JSON Schema | null
  side_effect          "read_only" | "mutating" | "requires_approval"
  status               "draft" | "active" | "disabled"
  description          사람이 읽는 설명 (Tool은 LLM이 읽는다)
  resource_digest      의존 자원 스냅샷 (진단용)
  history_policy       이력 본문 기록 정책 (8장)
  tool                 kind=tool일 때만 (3장)
  route                kind=route일 때만 (4장)
  created_by / created_at / updated_by / updated_at
```

| 공통 규칙 | 내용 |
|---|---|
| 버전 고정 | 진입점은 항상 `pinned_version`을 실행한다. 새 버전은 명시적 교체(rebind)로만 바꾸고, 교체할 때 입력·출력 스키마 차이를 보여준다 |
| 입력 계약 | Start 입력 폼에서 `input_schema`를 파생한다. 실행 전에 서버가 검증한다(실행 입력 검증은 구현됨) |
| 게시 검증 | 배포 상태, 입력 폼 유무, 그룹 호환성 점검(구현됨)을 게시 전에 돌린다 |
| 권한 | **진입점 권한 = 연결 워크플로우의 실행 권한.** 진입점 전용 권한 모델을 만들지 않는다. API Key 권한 범위로 입구 종류만 나눈다(`tool:read`·`tool:invoke`, `gateway:invoke`) |
| 실행 연결 | 입구 코드는 얇게 둔다: 이름 해석 → 권한 → 입력 검증 → 기존 실행 서비스 → `InstancesService.waitForResult`(구현됨) → 응답 변환 |

인덱스:

| 인덱스 | 용도 |
|---|---|
| `{ kind: 1, group_id: 1, "tool.name": 1 }` unique (kind=tool) | Tool 이름 그룹 내 유일 |
| `{ kind: 1, "route.method": 1, "route.path": 1 }` unique (kind=route) | 라우트 경로 전역 유일 |
| `{ group_id: 1, status: 1 }` | 목록 |
| `{ definition_id: 1, pinned_version: 1 }` | 워크플로우 재배포 영향 분석 |

### 그룹 namespace

AI Tool 설계의 `tool_namespace`를 **그룹 `namespace`** 로 일반화해 두 입구가 함께 쓴다.

- 그룹 생성 시 부여, 이후 변경 불가, 전역 유일, `^[a-z][a-z0-9_-]{1,31}$`
- AI Tool: 이름이 겹칠 때 `{namespace}__{name}`
- 게이트웨이 라우트: 경로 앞부분 `/gw/{namespace}/...`. 그룹끼리 경로가 부딪히지 않는다

## 3. AI Tool (kind = tool)

세부는 `docs/ai-tool-publish-design.md`를 따른다. 여기서는 공통 모델에 얹는 부분만 적는다.

```
tool
  name              ^[a-z][a-z0-9_]{2,63}$, 그룹 안에서 유일
  display_name
  input_schema_source   "derived" | "manual"
```

- 목록 `GET /api/v1/tools`, 실행 `POST /api/v1/tools/{name}/invoke`
- 응답 4상태: 완료(200), 업무 실패(200, `kind: business`), 승인 대기(202), 진행 중(202)
- 실행 실패는 원인별 HTTP 코드와 `failure_type`·`retryable`(구현됨)

## 4. 게이트웨이 라우트 (kind = route)

외부 요청이 PXM을 거쳐 백엔드로 간다. **특정 백엔드를 전제로 하지 않는다.**
"그냥 전달"도 HTTP 노드 하나짜리 워크플로우다. 워크플로우를 우회하는 경로는 만들지 않는다.

```
route
  method            GET | POST | PUT | PATCH | DELETE
  path              /gw/{namespace} 아래 경로. 경로 변수 허용 (/users/{user_id})
  mode              "passthrough" | "approval"
  response_mode     "backend" | "result_json"
  timeout_ms        동기 대기 한도 (기본 10,000, 최대 30,000)
  forward_headers   백엔드로 넘길 요청 헤더 허용 목록 (기본 없음)
```

### 4.1 요청 → 워크플로우 입력

| 요청 부분 | 워크플로우 입력 (`formData`) |
|---|---|
| 경로 변수 | 같은 이름의 필드 |
| 쿼리 문자열 | 같은 이름의 필드 |
| JSON 본문(객체) | 최상위 필드를 그대로 |
| 허용 목록의 헤더 | `formData._headers.{이름}` |

- 같은 이름이 두 곳에 있으면 **게시할 때 막는다**. 실행 중 조용히 덮어쓰지 않는다
- 합친 값은 `input_schema`로 검증한다. 틀리면 `400`과 항목별 오류

### 4.2 워크플로우 결과 → 응답

| `response_mode` | 응답 |
|---|---|
| `backend` (기본) | End 노드의 결과가 HTTP 노드 결과(`status_code`, `headers`, `body`)이면 **그 상태 코드와 본문을 그대로** 돌려준다. 헤더는 `Content-Type` 등 안전한 것만 |
| `result_json` | 워크플로우 결과를 `200` JSON으로 돌려준다 |

실행이 실패하면 백엔드 응답이 아니라 PXM 오류 계약(`code`, `failure_type`, `retryable`, `request_id`)으로 돌려준다.

### 4.3 두 가지 라우트

| | 바로 전달 (`passthrough`) | 승인 필요 (`approval`) |
|---|---|---|
| 워크플로우 | 결재·타이머 없음 | 결재 노드 포함 |
| 응답 시점 | 실행이 끝날 때 (`timeout_ms` 안) | **즉시 `202`** |
| 응답 | 백엔드 응답 | `{ request_id, status: "pending_approval", status_url }` |
| 한도 초과 | `504` + `request_id`. 실행은 계속되고 결과는 조회로 확인 | — |
| 결과 받기 | 응답 본문 | 결과 조회 API, Webhook |
| 게시 검증 | 결재·타이머·비동기 하위 호출이 있으면 막는다 | 결재 노드가 없으면 경고 |

승인 필요 라우트의 결과 Webhook: 지금 결과 Webhook은 **동적 결재의 최종 결과만** 보낸다(`docs/webhook-delivery.md`).
게이트웨이 라우트용으로 "진입점 실행 완료" 이벤트까지 넓혀야 한다(PXM-75).

### 4.4 Swagger

`/gw/docs`에서 게시된 라우트로 OpenAPI 문서를 만든다. 경로·메서드·`input_schema`·`output_schema`·오류 계약이 들어간다.
기존 `/api/docs`(PXM 공개 API)와는 따로 둔다.

## 5. 인증과 신원

```
호출자 ──(API Key)──▶ PXM ──(PXM 자격증명)──▶ 백엔드
          최종 사용자 주장                 최종 사용자 헤더 전달
```

| 구간 | 방식 |
|---|---|
| 호출자 → PXM | API Key. Tool은 `tool:*`, 라우트는 `gateway:invoke` 권한 범위 |
| 최종 사용자 | Tool은 `on_behalf_of` 본문, 라우트는 `X-PXM-On-Behalf-Of-Provider`·`X-PXM-On-Behalf-Of-Subject` 헤더. 둘 다 API Key의 정책과 외부 주체 매핑으로 검증하고, 권한은 좁히기만 한다 |
| PXM → 백엔드 | **PXM 자격증명(Credential Store)** 을 HTTP 노드에 주입한다. 호출자의 백엔드 세션은 넘기지 않는다(승인 대기 중 만료된다) |
| 최종 사용자 → 백엔드 | 검증된 최종 사용자를 인스턴스 `runtime.access.on_behalf_of`에 저장한다. HTTP 노드 헤더에서 `{{runtime.access.on_behalf_of.subject}}`로 참조한다. **엔진 수정 없이 된다**(참조는 인스턴스의 어느 경로든 읽는다) |
| 백엔드의 PXM 신뢰 | mTLS 또는 IP 제한. 백엔드 쪽 설정 |

## 6. 데이터 보호

중간 탈취를 막는다. PXM은 받은 요청을 풀어 확인하고 다시 암호화해 백엔드로 보낸다.

| 구간 | 기본값 |
|---|---|
| 호출자 → PXM | HTTPS (운영 구성의 Nginx 443) |
| PXM → 백엔드 | **HTTPS 강제.** 라우트에 연결된 워크플로우의 HTTP 노드가 `http://`면 게시를 막는다. 내부망 예외는 호스트 허용 목록으로만 |
| PXM 내부 저장 | 이력은 메타데이터가 기본(8장). 입력 스키마에서 `sensitive`로 표시한 필드는 인스턴스에 암호화해 저장한다 |
| 종단 간 암호화 | 넣지 않는다 |

> **엔진 수정 필요(PXM-76):** 승인 대기 중인 원문을 암호화해 저장하면, 승인 뒤 엔진이 백엔드를 부를 때 풀어야 한다.
> 엔진의 `{{ }}` 참조 처리에서 암호화된 값을 풀도록 바꾼다. 자격증명 저장소의 AES-256-GCM 방식과 키를 재사용한다.
> 화면과 조회 API에는 가린 값만 보인다.

## 7. 승인이 낄 때

| 입구 | 승인 대기 응답 | 이후 |
|---|---|---|
| 기존 실행 API | `202` + 인스턴스 id (지금과 같음) | 결과 조회·SSE |
| AI Tool | `202` + `status: pending_approval` + 결재자 | 하네스가 사용자에게 안내, 결과 조회 |
| 게이트웨이 라우트 | `202` + `request_id` + `status_url` | 결과 조회, Webhook |

승인 대기는 **오류가 아니다.** 반려는 `200` + 업무 실패(`outcome: REJECTED`, 구현됨)다.

## 8. 호출 이력

두 진입점이 같은 이력 저장소를 쓴다.

```
pxm_entry_point_calls
  entry_point_id, kind, group_id
  caller          { api_key_id, owner_type, owner_id }
  on_behalf_of    { provider, subject, resolved_pxm_user_id } | null
  trace_context   | null        (AI Tool)
  instance_id
  request         { method, path, received_at, bytes }
  response        { status_code, outcome, failure_type, duration_ms }
  body            null | { request, response }   ← history_policy가 켤 때만
```

| `history_policy.body` | 내용 |
|---|---|
| `none` (기본) | 본문을 남기지 않는다 |
| `masked` | 민감 키(기존 탐지 로직)와 `sensitive` 필드를 가려서 남긴다 |

관리 화면: 진입점별 호출 이력, 호출 시스템과 최종 사용자를 나눠 표시(PXM-72, PXM-76).

## 9. Rust 이전을 고려한 모양

진입점은 나중에 Rust 데몬으로 옮길 자리다(PXM-78).

- 입구 코드(이름 해석, 권한, 입력 변환, 응답 변환)는 **실행 로직과 분리**한다. 실행은 기존 서비스를 부른다
- 저장소는 포트(인터페이스)로만 쓴다. MongoDB 구현을 먼저 만들고 PostgreSQL 구현 자리를 남긴다
- 새 저장 구조(`pxm_entry_points`, `pxm_entry_point_calls`)는 두 DB 모두 가능한 모양으로 정하고 PostgreSQL 마이그레이션을 함께 남긴다

## 10. 이슈 범위

| 이슈 | 이 문서 기준 범위 |
|---|---|
| PXM-69 Tool 등록과 게시 | `pxm_entry_points` 저장소(두 종류 공통), 그룹 `namespace`, Tool 게시·관리 API, 스키마 파생·검사, End 노드 설정 화면 |
| PXM-70 Tool 공개 API | 목록·실행, 버전 지정 실행, `tool:*` 권한 범위 |
| PXM-71 호출자 신원과 추적 | `on_behalf_of` 검증(두 종류 공통), `trace_context`, `pxm_entry_point_calls` |
| PXM-72 관리 화면·연동 가이드 | 진입점 목록·상세·호출 이력 화면(두 종류 공통 틀), Promptic 연동 가이드 |
| PXM-74 라우트 등록과 요청 처리 | `kind=route` 게시, `/gw/*` 수신, 요청→입력·결과→응답 변환, `gateway:invoke`, 백엔드 HTTPS 강제, `/gw/docs`, 모의 백엔드 E2E |
| PXM-75 승인 필요 라우트 | `202` 응답, 결과 조회, **결과 Webhook을 진입점 실행 완료까지 확장** |
| PXM-76 이력과 데이터 보호 | 본문 기록 정책, `sensitive` 필드 암호화 저장과 **엔진 복호화** |
| PXM-77 빠른 실행 (조건부) | `passthrough` 라우트를 DB 큐 없이 실행 |

AI 연동(PXM-69~72)에서 만든 공통 부분(저장소, 권한, 신원, 이력, 관리 화면 틀)을 게이트웨이(PXM-74~76)가 그대로 쓴다.

## 11. 확정한 결정 (2026-09-30)

| 질문 | 결정 |
|---|---|
| 라우트 경로 앞부분 | `/gw/{namespace}/...`. 그룹 간 충돌이 없고, 클라이언트는 기준 주소만 바꾸면 된다 |
| API Key 없는 라우트 호출 | 허용하지 않는다. 모든 라우트는 API Key 필수 |
| `namespace` 문자 규칙 | `^[a-z][a-z0-9_-]{1,31}$`. 경로에 자주 쓰여 Tool 이름과 달리 `-`를 허용한다 |
| 승인 대기 원문 암호화 범위 | 입력 스키마의 `sensitive` 필드만. 전체 암호화는 분기와 화면 표시를 막는다 |
