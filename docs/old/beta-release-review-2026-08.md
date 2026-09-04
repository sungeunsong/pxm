# 1차 베타 공개 전 제품 점검 (2026-08-25)

이 문서는 실행 중인 PXM을 실제로 조작하며 수행한 점검 결과다. 판단 근거와 재현 절차를 함께 남겨,
읽는 사람이 결과를 다시 확인하고 바로 수정 작업에 들어갈 수 있도록 한다.

실행 단위 작업과 완료 조건은 `docs/old/beta-release-todo.md`에서 관리한다.

## 제품 전제 (우선순위 판단의 기준)

이 점검의 모든 우선순위는 아래 전제에서 나온다. 전제가 바뀌면 우선순위도 바뀐다.

1. **주력 제공 방식은 서드파티 대상 API다.** 고객사는 자기 시스템에서 PXM API를 호출한다.
2. **웹(`apps/web`)은 세 가지 보조 역할만 한다.**
   - 시연: "이렇게 설계하고, 이렇게 실행되고, 이렇게 결재된다"를 보여준다
   - 보조 사용 경로: API를 쓰지 않는 소규모 고객이 웹만으로 사용
   - **서드파티 개발자의 관리 콘솔**: API Key 발급, 워크플로우 설계, 실행 실패 디버깅
3. 현업 사용자(신청자/승인자)용 화면은 원칙적으로 **고객사가 자기 UI로 만든다**.

3번 때문에 "신청 포털", "내 신청 내역" 같은 현업 화면 신규 구축은 이번 범위에서 제외한다.
대신 **2-3번(개발자 콘솔)이 실질적으로 가장 중요하다**. 서드파티 개발자는 키 발급하러, 워크플로우
그리러, 실패 원인 보러 반드시 이 웹에 들어온다.

단, 이 전제는 출시 전에 제품 책임자가 명시적으로 확정해야 한다. PXM을 "웹에서 바로 쓰는 범용 BPM"으로
판매한다면 신청자 화면, 사용자 홈, 위임, SLA 등이 빠진 현재 범위는 맞지 않는다. 이번 문서는
**API-first/headless workflow 제품으로 소수 고객과 시작하는 초대 기반 비공개 베타**를 기준으로 한다.

## 베타 공개 수준 판단

- **로컬 발표·통제된 데모**: 아래 시연 신뢰도 항목을 정리하면 가능하다.
- **초대 기반 비공개 베타**: API 계약 P0, 공개 API 문서, 운영 체크리스트의 실제 증빙까지 완료한 뒤 가능하다.
- **불특정 다수 공개 베타**: 현재는 `NO-GO`다. 인증서, Secret 저장소, 백업 scheduler, 복구 훈련,
  비상 연락망은 코드가 있다는 사실이 아니라 실제 운영 환경의 증빙이 필요하다.

## 총평

- **엔진과 API의 뼈대는 베타로 공개해도 되는 수준이다.** 노드 커버리지, 배포 수명주기, 결재,
  운영 관측, 보안 통제가 모두 실재하고 동작한다.
- **막는 것은 API 계약의 결함 4건과 API 제품으로서 없는 것 3건이다.** 대부분 수정 비용이 낮지만,
  공개 후에 고치면 그 자체가 breaking change가 되는 항목이 섞여 있다.
- 웹은 기능 부족이 아니라 **성격이 확정되지 않은 것**이 문제다. 만들 것보다 **덜어낼 것**이 많다.
- 따라서 현재 판정은 "바로 공개 베타"가 아니라 **계약과 시연 신뢰도를 보완한 뒤 초대 기반 비공개 베타**다.

## 검증 환경

```bash
pnpm db:mongo && pnpm db:mongo:init
pnpm dev:api:mongo      # http://localhost:3011/api
pnpm dev:engine:mongo
pnpm dev:web            # http://localhost:5174 (5173 사용 중이면 자동 증가)
```

- 로그인: `admin` / `admin1234` (`PXM_BOOTSTRAP_ADMIN_PASSWORD` 미설정 시 개발 기본값)
- 브라우저 조작은 Playwright(`apps/e2e`에 설치된 chromium)로 수행
- API 점검은 서비스 계정 + API Key를 실제 발급해 서드파티와 동일한 경로로 호출

---

# P0 — API 계약 결함 (공개 전 필수)

아래 4건은 모두 **실제 호출로 재현 확인**했다.

## A-1. scope가 없는데 404를 반환한다 (문서와 불일치)

`workflow:read`만 가진 API Key로 동일 리소스를 호출한 결과:

```
GET  /api/templates/{id}        → 200  (읽기 성공)
POST /api/templates/{id}/start  → 404  {"message":"Template not found"}
```

`docs/api-consumer-demo.md`는 다음과 같이 규정한다:

> `workflow:execute`를 제거하면 워크플로우 실행이 `403`이어야 한다.

즉 **문서화된 계약을 코드가 위반한다.** 같은 키가 같은 리소스를 200으로 읽는데 실행만 404이므로,
서드파티 개발자는 권한 문제를 리소스 부재로 오인한다. 디버깅이 사실상 불가능하다.

**기대 동작**: scope 부족 시 `403`과 어떤 scope가 필요한지 알 수 있는 메시지.
**주의**: 그룹 밖 리소스를 숨기기 위한 404는 정당하다. 하지만 **읽기가 허용된 리소스**에 대해서는
403이어야 한다. 이 둘을 구분해서 고칠 것.

## A-2. 잘못된 API Key에 400을 반환한다 (401이어야 함)

```
Authorization: Bearer pxm_live_totallyinvalidkey
→ 400 {"message":"API key is invalid"}
```

표준 HTTP 클라이언트와 자동 생성 SDK는 `401`을 보고 재인증/키 갱신 로직을 트리거한다.
`400`은 "요청 바디가 잘못됨"으로 해석되어 **키 만료 시 클라이언트가 스스로 복구하지 못한다.**

**기대 동작**: 인증 실패는 `401`. 만료/비활성 키도 동일하게 `401`(사유는 메시지로 구분).
`400`은 형식 오류에만 사용한다.

## A-3. 문서대로 호출하면 500이 난다 — deploy 바디 누락

`docs/workflow-api-contract.md:53`은 다음과 같이 기술한다:

> `POST /api/templates/:template_id/deploy`: 현재 저장 버전을 배포한다.

바디 없이 그대로 호출하면 크래시한다:

```bash
curl -X POST http://localhost:3011/api/templates/{id}/deploy   # 바디 없음
→ 500 {"statusCode":500,"message":"Internal server error"}

# API 로그
TypeError: Cannot read properties of undefined (reading 'group_id')
  at TemplatesController.deploy (apps/api/src/templates/templates.controller.ts:228)
```

원인: `apps/api/src/templates/templates.controller.ts:228`이 `body`가 `undefined`인 상태에서
`body.group_id`를 읽는다. `-d '{}'`를 붙이면 `201`로 정상 동작한다.

**수정**: `@Body()` 기본값을 `{}`로 두거나 옵셔널 처리. 같은 패턴이 다른 컨트롤러에도 있는지
함께 확인할 것 (바디가 선택적인 POST 엔드포인트 전수 점검).

## A-4. API Key의 `allowed_workflow_ids`가 발급 시점 스냅샷이다

`apps/api/src/authz/authz.service.ts:450-454`:

```ts
const allowedWorkflowIds = dto.allowed_workflow_ids === undefined
  ? (await this.workflowRepo.listDefinitions())
      .filter((workflow) => (workflow.group_id || workflow.metadata?.group_id) === dto.group_id.trim())
      .map((workflow) => workflow.id)
  : normalizeStringArray(dto.allowed_workflow_ids);
```

`allowed_workflow_ids`를 생략하면 **그 순간** 그룹의 워크플로우 목록이 고정된다.
이후 새로 만든 워크플로우는 기존 키에 영원히 보이지 않는다.

점검 중 실제로 이 문제에 걸렸다. 증상은 또다시 `404 Template not found`여서 원인 파악에 시간이 걸렸다.
서드파티는 "어제 배포한 워크플로우가 API로 안 보인다"는 문의를 반드시 보낸다.

**권장 결정**: 빈 배열에 특별한 의미를 싣지 말고 접근 정책을 명시적으로 분리한다.

```text
workflow_access: "all_in_group" | "allowlist"
allowed_workflow_ids: [...]  # allowlist일 때만 사용
```

- `all_in_group`: 같은 그룹에 이후 추가되는 워크플로우도 동적으로 허용
- `allowlist`: 명시된 워크플로우만 허용하며 빈 배열은 아무것도 허용하지 않음

베타 일정 때문에 스키마 확장이 어렵다면 차선책으로 생략을 금지하고 발급 화면에서 두 정책 중 하나를
반드시 선택하게 한다. `빈 배열 = 전체`처럼 보안 설정의 일반적 기대와 반대되는 암묵 규칙은 피한다.

응답 원칙도 구분한다. **읽을 수 있는 리소스에서 실행 scope만 부족하면 403**, 다른 그룹 또는 존재를
숨겨야 하는 리소스라면 404를 유지한다.

---

# P0 — API 제품으로서 없는 것 (공개 전 필수)

## B-1. OpenAPI/Swagger가 전혀 없다

- `@nestjs/swagger` 미설치, `SwaggerModule`/`DocumentBuilder` 사용처 0건
- 리포지토리 전체에 openapi/swagger 관련 파일 0건

`docs/workflow-api-contract.md`(34KB)가 상세하지만 **사람이 읽는 문서지 기계가 읽는 스펙이 아니다.**
서드파티가 클라이언트를 자동 생성할 수 없다. API를 주력으로 파는 제품에서는 사실상 필수다.

전체 관리 API를 한 번에 문서화하면 베타 일정이 불필요하게 커진다. 먼저 외부 고객에게 약속할 공개 API
표면을 고정한다.

- 워크플로우 조회와 실행
- 인스턴스 상태와 trace
- 결재 조회와 처리
- 결과 Webhook

**작업**: 이 공개 API부터 `@nestjs/swagger`와 DTO 스키마를 적용해 `/api/docs` 및 빌드 산출물
`openapi.json`을 만든다. 그룹·사용자·Plugin Registry 같은 관리자 API 문서화는 베타 이후 확장한다.

## B-2. API 버전이 없다

`apps/api/src/main.ts:16`은 `app.setGlobalPrefix('api')`만 호출한다. `enableVersioning()` 없음.

**한 번 공개하면 breaking change를 낼 방법이 사라진다.** 따라서 외부 공개 API는 처음부터
`/api/v1`으로 제공해야 한다.

다만 비용이 거의 0인 작업은 아니다. 현재 Web, api-playground, E2E, 운영 스크립트와 문서가 `/api`를
사용한다. 단순히 전역 prefix를 바꾸면 내부 콘솔도 함께 깨질 수 있다. 다음 중 하나를 택한다.

- 외부 공개 API만 `/api/v1`, 기존 관리 콘솔 API는 `/api` 유지
- 마이그레이션 기간 동안 `/api`와 `/api/v1`을 함께 제공하고 공개 문서에는 v1만 노출

선택 후 같은 commit에서 Web, api-playground, E2E, health check와 문서를 모두 회귀 검증한다.

## B-3. 전역 exception filter와 correlation id가 없다

- `ExceptionFilter` 구현체 0건
- 500 응답이 `{"statusCode":500,"message":"Internal server error"}`뿐
- API Key 사용 로그는 호출자가 보낸 `x-request-id`를 기록하지만, 서버가 모든 요청에 식별자를 생성해
  응답과 애플리케이션 로그에 연결하는 전역 correlation 체계는 아니다.

서드파티가 장애를 문의할 때 지목할 식별자가 없다. 서버 로그와 고객 리포트를 연결할 수단이 없다.

**작업**: 전역 filter + 요청별 correlation id를 응답 헤더/바디와 로그에 함께 기록.

---

# P0 — 시연 신뢰도 (공개 전 필수)

웹의 주 용도가 시연이므로, **가짜 데이터와 죽은 UI는 기능 부족보다 치명적이다.**

## C-1. 대시보드가 전부 하드코딩되어 있다

`apps/web/src/dashboard/DashboardPage.tsx`:

| 위치 | 내용 |
|---|---|
| `:57` | `'HR Onboarding 워크플로우 완료됨 (인스턴스 #5c3135)', time: '5분 전'` — 고정 문자열 |
| `:172` | `RUNNING (Port: 3000)` — 실제 API 포트는 3011 |
| `:213` | `HR Onboarding` 등 통계 막대 라벨 — 고정 |

상단 KPI(`등록된 템플릿 28`, `기동된 인스턴스 14`)도 고정값이다.

**시연 중 누군가 이걸 알아채면 제품 전체의 신뢰가 무너진다.** 로그인 직후 첫 화면이라 노출 확률이
가장 높다. 실데이터 연결이 이번 범위에서 부담되면 **대시보드를 첫 화면에서 빼는 것이 낫다.**

관련 계획 항목: `docs/old/bpm-platform-implementation-plan.md` "Next Recommended Work" 4번.

## C-2. "내 결재함"이 기본 비활성이다

`apps/web/src/config/features.ts:1`:

```ts
export const approvalSampleUiEnabled =
  import.meta.env.VITE_ENABLE_APPROVAL_SAMPLE_UI === 'true';   // 기본 false
```

`VITE_ENABLE_APPROVAL_SAMPLE_UI=true`로 켜고 확인한 결과 **완성도가 충분하다**:
승인 대기 / 처리 완료 / 반려함 탭, 신청자·요청일·담당 노드 컬럼, 승인·반려·보류와 의견 입력.
`apps/web/src/inbox/InboxPage.tsx` 683줄의 제대로 된 화면인데 플래그 이름이 `approvalSample`이라
샘플 취급을 받고 꺼져 있다.

시연에서 "승인은 이렇게 처리된다"를 보여줄 유일한 화면이다. **플래그를 제거하고 상시 노출할 것.**
변수명도 `sample`을 떼는 것이 좋다.

## C-3. 일반 사용자 화면에 내부 모델링 정보와 동작하지 않는 버튼이 노출된다

`role: 'user'` 계정으로 로그인하면 첫 화면이 "워크플로우 관리"이고, 워크플로우를 선택하면:

```
Template ID  7134fac5-a3c0-40b7-b3e2-6315a8b1eb35
Version v1 · Nodes 3 · Edges 2 · Approval Nodes 1 · Service Nodes 0
수동 실행 — "관리자가 테스트나 운영 조치 목적으로 이 워크플로우를 즉시 시작합니다."
[ 워크플로우 삭제 ]
```

문제:
- `Edges 2`는 내부 모델링 정보다
- 안내문이 "관리자가"라고 말하는데 보고 있는 사람은 관리자가 아니다
- **삭제 버튼이 노출된다**

삭제는 API가 `403`으로 정상 차단한다(직접 확인). **보안 결함이 아니라, 누르면 반드시 실패하는
버튼이 보이는 UI 결함이다.**

**수정 방향**: 웹의 성격을 "개발자·운영자 콘솔"로 확정하고, 일반 사용자 역할에서는 위 요소를
숨긴다. 현업용 화면을 새로 만드는 것이 아니라 **덜어내는 작업**이다.

## C-4. 테스트 데이터와 설계 메모가 화면에 남아 있다

- 그룹 목록: `ㅁㅁㅁㅁ`, `terst`, `sse (DELETED)`
- 워크플로우 목록: `Smoke Approval 2026-07-29T04:40:29.206Z` 형태 다수
- 실행 모니터링 헤더: `"운영자 / 모니터링 담당 상세 화면 구성"` — 설계 메모가 UI에 남음

시연 전 데이터 정리와 문구 수정이 필요하다.

## C-5. 상단에 동작하지 않는 검색·알림·도움말이 노출된다

`apps/web/src/App.tsx:449-460`에는 다음 요소가 항상 표시된다.

- 동작이 연결되지 않은 `메뉴, 업무, 요청명 검색 (Ctrl + K)` 입력창
- 실제 데이터가 아닌 것으로 보이는 고정 알림 배지 `12`
- 클릭 동작이 없는 도움말 버튼

감사 로그 메뉴와 같은 종류의 신뢰도 문제다. 발표 중 호기심으로 눌렀을 때 아무 반응이 없으면 제품 전체가
목업처럼 보인다. 베타에서 실제 구현하지 않을 요소는 숨기고, 알림 수처럼 데이터로 보이는 숫자는
하드코딩하지 않는다.

---

# P1 — 개발자 콘솔 완성도

## D-1. 실행 추적이 편집기 안에서 열린다

실행 모니터링 → `실시간 추적`을 누르면 Flow Designer로 이동한다. 그 결과:

- 좌측 노드 팔레트가 그대로 표시됨 (모니터링 중인데 편집 도구가 보임)
- 상단 `Run / Save / Import / Export`가 활성 상태
- 탭 이름이 **"Untitled Workflow"** (실제로는 특정 인스턴스를 추적 중)
- 캔버스가 fit-to-view 되지 않아 첫 노드만 확대되어 보이고 나머지는 화면 밖

그래프 위에 실행 경로를 겹쳐 보여주는 방향 자체는 옳다(Camunda Cockpit도 동일).
**읽기 전용 모드 진입 + `fitView()` 호출 + 탭 라벨을 인스턴스 식별자로** 바꾸면 해결된다.

서드파티 개발자가 실패 원인을 볼 때 반드시 거치는 화면이므로 우선순위가 낮지 않다.
다만 이것을 최종 사용자 대상 발표의 주된 "와우 포인트"로 보지는 않는다. 실제 신청자나 승인자는
Flow Designer를 보며 업무를 처리하지 않기 때문이다. 이 작업의 목적은 시각 효과가 아니라
**개발자·운영자의 디버깅 정확도와 제품 완성도**다.

## D-2. 감사 로그가 동작하지 않는 메뉴다

`apps/web/src/App.tsx:339`:

```tsx
{user.role !== 'user' && <button className="sidebar-menu-item disabled" title="감사 로그">
```

`onClick`이 없다. 그런데 다른 세 화면이 "감사 로그에 기록됩니다"라고 안내한다
(`App.tsx:425`, `:430`, 제품 설정 화면). **기록된다고 말해놓고 볼 수 없는 상태**라
서드파티 보안 검토에서 바로 지적된다.

**화면을 만들거나 메뉴를 제거할 것. 회색으로 두는 것이 가장 나쁘다.**
백엔드 audit append는 이미 여러 컨트롤러에서 동작 중이므로 조회 API/화면만 붙이면 된다.

## D-3. UI 정렬 문제

- **Access Management**: `저장` 버튼이 탭 줄 위에 겹쳐 표시됨. 선택된 그룹이 카드와 목록에 중복 노출
- **Credential Store**: 1600px 폭에서 헤더 제목이 2줄로 깨지며 우측 사용자 영역까지 밀림

## D-4. api-playground를 시연 자산으로 키울 것

`apps/api-playground`는 세션 쿠키 없이 API Key만으로 붙는 reference client이고,
요청/응답과 재사용 가능한 cURL 예시를 보여주는 API Console을 갖췄다 (`docs/api-consumer-demo.md`).

**API 우선 제품의 시연에서 "서드파티는 이렇게 사용한다"를 보여줄 핵심 무기다.**
B-1(OpenAPI) 작업과 함께 강화할 가치가 있다.

---

# P0 — 베타 전달과 발표 재현성

기능이 동작하는 것과 다른 사람이 처음 받아 성공하는 것은 별개다. 아래 항목이 없으면 발표는 진행자의
개인 환경에 의존하고, 베타 고객은 첫 실행 단계에서 이탈한다.

## E-1. 데모 데이터 seed/reset

발표 직전마다 DB를 수동 정리하지 않도록 대표 그룹, 사용자, API Key 발급 전제, 워크플로우와 필요한
샘플 데이터를 한 명령으로 준비해야 한다. Secret 원문이나 고정 운영 Key를 seed에 넣어서는 안 된다.

- `demo:seed`: 대표 시나리오를 동일한 이름과 상태로 생성
- `demo:reset`: 이전 발표의 실행·결재·Webhook 흔적을 안전하게 초기화하고 다시 seed
- 완료 후 발표에 필요한 리소스 ID와 접속 경로를 요약 출력

## E-2. 5분 Quick Start와 알려진 제한

외부 개발자가 API Key 발급부터 첫 실행 결과 확인까지 5분 안에 따라 할 수 있는 문서가 필요하다.
OpenAPI 링크, 실제 cURL, 오류 응답, Idempotency-Key 예제와 함께 다음 제한을 명시한다.

- BPMN 2.0 XML 미지원
- 베타에서 지원하는 노드와 제외한 노드
- 초대 기반 베타의 지원 범위와 데이터 보존 정책

## E-3. 베타 지원·피드백 경로

오류 화면과 문서에 문의 경로를 제공하고, 고객이 correlation id, 발생 시각, workflow/instance id를
민감정보 없이 전달할 수 있게 한다. 담당자, 응답 기준, 장애 공지 경로가 정해지지 않으면 기술적으로
동작해도 외부 베타를 운영할 수 없다.

## 발표 기능 선정 원칙

발표용 "와우 포인트"는 별도 제품 정의를 통해 정한다. 다음 원칙은 고정한다.

- 실제 신청자·승인자 또는 연동 개발자가 일상적으로 겪는 핵심 문제를 해결해야 한다.
- 관리자용 그래프 애니메이션처럼 사용 맥락과 떨어진 시각 연출만으로 핵심 기능이라 부르지 않는다.
- 발표 전용 가짜 데이터나 별도 동작을 만들지 않고, 실제 베타 기능과 동일한 경로를 사용한다.
- 한 문장으로 고객 가치가 설명되지 않는 기능은 발표의 중심에 두지 않는다.

---

# 이번 범위에서 제외 (작업하지 말 것)

아래는 상용 BPM에는 있지만 **API 우선 전제에서는 고객사 몫**이거나 베타 이후 항목이다.
착수하면 낭비이므로 명시해둔다.

- 신청 포털 / 업무 카드 카탈로그 / 신청서 작성 화면
- "내 신청 내역" 화면
- 현업 사용자 전용 홈
- BPMN 2.0 표준 XML 입출력 (현재 독자 JSON 포맷)
- Boundary event, Message/Signal event
- Human Task claim/unclaim, 위임, SLA 에스컬레이션
- Multi-instance(반복 실행), DMN 룰 엔진

다만 **BPMN 2.0 표준 지원 여부는 서드파티가 반드시 묻는 질문**이므로,
"현재 미지원, 로드맵에 있음"을 답할 수 있도록 대외 문서에 명시해둘 것.

---

# 건드리지 말 것 (이미 잘 되어 있음)

수정 작업 중 회귀시키지 않도록 확인된 강점을 남긴다.

| 영역 | 확인 내용 |
|---|---|
| sync 실행 | `POST /start` `mode:"sync"`가 결과를 인라인 반환. 서드파티가 원하는 형태 |
| 멱등성 | 동일 `Idempotency-Key` 재전송 시 같은 `instance_id` 반환 (확인함) |
| 노드 커버리지 | start / script / service / command / gateway(exclusive·parallel·inclusive) / approval / timer / workflow_call / end |
| 배포 수명주기 | DRAFT → PUBLISHED → disable → version rollback, 실행은 published 버전 고정 |
| 결재 | 순차 다단계, 단계별 복수 승인자, ALL/ANY, 외부 승인자(이메일/OTP), 반려·취소·보류 |
| API Key 통제 | scope, allowed_workflow_ids, IP allowlist, rate limit, 만료, rotate, prefix만 조회 |
| 운영 관측 | Job 적체 / 장기 WAITING / 만료 잠금 / Outbox DLQ를 한 화면에서 진단·복구 |
| 보안 | opaque session + CSRF, credential AES-256-GCM, 세션 정책 UI, JS 샌드박스 |
| 확장 | Plugin Registry hot reload, Command allowlist registry, 결과 Webhook 재전송 |

---

# 작업 순서 제안

**0단계 — 제품 경계 확정**
1. PXM을 API-first/headless 제품으로 내보낸다는 전제를 제품 책임자가 확정
2. 외부 공개 API와 내부 관리 API의 목록을 분리
3. 첫 베타를 통제된 데모, 초대 기반 비공개 베타, 공개 베타 중 어디까지 열지 확정

**1단계 — 외부 공개 전에 계약 고정**
4. A-2 인증 실패 `401` 정정
5. A-1 scope 부족 `403` 정정 (그룹 밖 404는 유지)
6. A-3 deploy 바디 누락 500 수정 + 유사 패턴 전수 점검
7. A-4 `workflow_access` 정책 결정과 구현
8. B-2 외부 `/api/v1` 라우팅 전략 구현 및 기존 `/api` 소비자 회귀 검증
9. B-3 표준 오류 응답 + correlation id

**2단계 — 발표 신뢰도와 재현성**
10. C-2 결재함 플래그 제거
11. C-3 역할별 내부 정보·실패하는 버튼 제거
12. C-4 테스트 데이터와 설계 메모 제거
13. C-5 동작하지 않는 검색·알림·도움말 숨김 또는 실제 연결
14. C-1 하드코딩 대시보드를 첫 화면에서 제외. 실데이터 연결은 베타 이후로 미뤄도 됨
15. E-1 `demo:seed` / `demo:reset`과 발표 전용 회귀 테스트 추가

**3단계 — 외부 개발자가 스스로 성공하게 만들기**
16. B-1 공개 API 범위의 OpenAPI spec + `/api/docs`
17. E-2 5분 Quick Start와 알려진 제한 공개
18. D-4 api-playground의 예제와 오류 표시 정리
19. E-3 지원·피드백·장애 문의 경로 확정

**4단계 — 콘솔 완성도**
20. D-1 실행 추적 읽기 전용 + fitView
21. D-2 감사 로그 화면 연결 또는 메뉴 제거
22. D-3 UI 정렬

**5단계 — 운영 오픈 판정**
23. `pnpm gate:release`를 같은 commit에서 통과
24. 인증서, Secret 저장소, 백업 scheduler, 복원 검증, 비상 연락망의 실제 증빙 기록

A-1~A-3과 단순 UI 제거 작업은 작지만, API 버전 전략·접근 정책 변경·OpenAPI·회귀 검증까지 묶어
"하루 안쪽"으로 약속하는 것은 위험하다. 작은 결함 수정과 외부 계약 고정을 별도 작업으로 추정한다.

---

# 부록 — JS Node module import 현황

`docs/old/bpm-platform-implementation-plan.md`의 미완 항목(`:493`, `:563`, `:578`)에 대한 실측 결과다.
설계 문서는 아직 없지만 **"기본 차단"은 이미 구현되어 있다.**

`apps/engine/src/v2/runtime.rs:218-270`은 `node` 자식 프로세스에서 `node:vm` 컨텍스트를 만들고
`input` / `context` / `console`만 주입한다. `codeGeneration: { strings: false, wasm: false }`.

probe 워크플로우를 실제 실행한 결과:

```json
{ "require": "undefined",
  "fs":      "BLOCKED: require is not defined",
  "eval":    "BLOCKED: Code generation from strings disallowed for this context",
  "fn":      "BLOCKED: Code generation from strings disallowed for this context",
  "process": "undefined",
  "globals": ["input", "context", "console"] }
```

**남은 작업**: 허용 정책을 열 때의 설계(허용 내장 모듈 목록, allowlist 패키지의 version pin과 검증,
그룹별 정책)와 **memory limit / output size limit** 구현. 현재는 timeout(기본 1000ms, 50~5000ms clamp)과
console 캡(200줄 / 64KB)만 있다.

베타 공개 자체를 막는 항목은 아니다.

---

# 점검 중 생성한 데이터

정리가 필요하면 삭제할 것.

- 사용자 `uxtest` (role=user, Executive Demo 그룹)
- 서비스 계정 `api-review-sa`
- API Key `api-review-key`, `api-review-key2`, `api-review-key3`, `k3b`
- 템플릿 `[API] 주문 금액 계산` (PUBLISHED) 및 해당 인스턴스 3건
