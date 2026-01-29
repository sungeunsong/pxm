# 동적 폼 구성 설계 문서 (Phase 2.5)

## 📋 개요

**목표**: 결재 솔루션의 핵심 기능인 동적 폼을 BPM 워크플로우에 통합

**배경**:

- 초기 목표: 범용 결재/승인 솔루션
- 요구사항: HTML import, DnD 폼 빌더, JSON export/import
- 확장: 결재 솔루션 → 범용 BPM 엔진

**접근법**: JSON Schema 기반 → 단계적 확장 (HTML import는 보안상 제외)

---

## 🎯 Phase 2.5 목표

1. ✅ Start 노드에서 동적 폼 정의
2. ✅ 템플릿 실행 시 폼 렌더링
3. ✅ 폼 데이터를 워크플로우 컨텍스트로 전달
4. ✅ Gateway/Service/Approval 노드에서 폼 데이터 활용

---

## 📐 데이터 구조 설계

### 1. FormField 인터페이스

```typescript
// apps/web/src/flow-designer/types.ts

export type FormFieldType =
  | "text" // 단일 텍스트 입력
  | "textarea" // 여러 줄 텍스트
  | "number" // 숫자
  | "select" // 드롭다운
  | "checkbox" // 체크박스
  | "radio" // 라디오 버튼
  | "date" // 날짜 선택
  | "file"; // 파일 업로드 (Phase 4+)

export interface FormField {
  id: string; // 필드 고유 ID (예: "requester_name")
  type: FormFieldType; // 필드 타입
  label: string; // 필드 레이블 (예: "요청자 이름")
  placeholder?: string; // 플레이스홀더
  required?: boolean; // 필수 여부
  defaultValue?: any; // 기본값

  // 타입별 옵션
  options?: string[]; // select, radio용 옵션 목록
  min?: number; // number, date용 최소값
  max?: number; // number, date용 최대값
  minLength?: number; // text, textarea용 최소 길이
  maxLength?: number; // text, textarea용 최대 길이
  pattern?: string; // 정규식 패턴 (예: 이메일, 전화번호)

  // UI 옵션
  helperText?: string; // 도움말 텍스트
  rows?: number; // textarea용 행 수

  // 고급 기능 (Phase 4+)
  conditional?: {
    // 조건부 표시
    field: string; // 참조 필드 ID
    operator: "==" | "!=" | ">" | "<" | "contains";
    value: any;
  };
}

export interface FormSchema {
  fields: FormField[];
}
```

### 2. Start 노드 데이터 확장

```typescript
// apps/web/src/flow-designer/types.ts

export interface CustomNodeData {
  nodeType: "start" | "service" | "timer" | "gateway" | "approval" | "end";
  label: string;
  description?: string;

  // Start 노드 전용
  formSchema?: FormSchema; // 동적 폼 정의

  // Service 노드 전용
  url?: string;
  method?: string;
  headers?: string;
  timeout?: number;
  retryCount?: number;
  enableRetry?: boolean;

  // Timer 노드 전용
  durationMs?: string;
  timerType?: string;

  // Gateway 노드 전용
  gatewayType?: string;
  condition?: string;

  // Approval 노드 전용
  approver?: string;
  approvalType?: string;
  requireComment?: boolean;
}
```

### 3. 워크플로우 컨텍스트 (ctx)

```typescript
// 엔진에서 사용하는 ctx 구조
interface WorkflowContext {
  cursor: string; // 현재 노드 ID
  nodes: any[]; // 노드 목록
  edges: any[]; // 엣지 목록
  template_id: string; // 템플릿 ID

  // 폼 데이터 (Phase 2.5에서 추가)
  formData?: Record<string, any>; // Start 노드에서 입력받은 데이터

  // Service 노드 응답 (기존)
  service_http?: any;

  // 기타 컨텍스트 데이터
  [key: string]: any;
}
```

---

## 🎨 UI 구현

### 1. Start 노드 속성 패널 (FormSchemaEditor)

**위치**: `apps/web/src/flow-designer/FormSchemaEditor.tsx`

**기능**:

- 폼 필드 목록 표시
- "필드 추가" 버튼
- 필드 편집/삭제
- 필드 순서 변경 (드래그)

**UI 레이아웃**:

```
┌─────────────────────────────────────┐
│ Start 노드 속성                      │
├─────────────────────────────────────┤
│ 레이블: [권한 요청 폼            ]  │
│ 설명:   [권한 요청을 위한 폼     ]  │
│                                     │
│ 폼 필드 구성:                        │
│ ┌─────────────────────────────────┐ │
│ │ [+ 필드 추가]                    │ │
│ │                                 │ │
│ │ ┌─────────────────────────────┐ │ │
│ │ │ 1. 요청자 이름 (text) *필수  │ │ │
│ │ │    ID: requester_name       │ │ │
│ │ │    [↑][↓] [편집] [삭제]     │ │ │
│ │ └─────────────────────────────┘ │ │
│ │                                 │ │
│ │ ┌─────────────────────────────┐ │ │
│ │ │ 2. 시스템 (select) *필수     │ │ │
│ │ │    ID: system               │ │ │
│ │ │    옵션: HR, ERP, CRM       │ │ │
│ │ │    [↑][↓] [편집] [삭제]     │ │ │
│ │ └─────────────────────────────┘ │ │
│ │                                 │ │
│ │ ┌─────────────────────────────┐ │ │
│ │ │ 3. 권한 레벨 (number)        │ │ │
│ │ │    ID: permission_level     │ │ │
│ │ │    범위: 1-5                │ │ │
│ │ │    [↑][↓] [편집] [삭제]     │ │ │
│ │ └─────────────────────────────┘ │ │
│ │                                 │ │
│ │ ┌─────────────────────────────┐ │ │
│ │ │ 4. 사유 (textarea) *필수     │ │ │
│ │ │    ID: reason               │ │ │
│ │ │    행: 5                    │ │ │
│ │ │    [↑][↓] [편집] [삭제]     │ │ │
│ │ └─────────────────────────────┘ │ │
│ └─────────────────────────────────┘ │
└─────────────────────────────────────┘
```

### 2. 필드 편집 모달 (FieldEditorModal)

**위치**: `apps/web/src/flow-designer/FieldEditorModal.tsx`

**기능**:

- 필드 타입 선택
- 필드 속성 설정
- 검증 규칙 설정

**UI 레이아웃**:

```
┌─────────────────────────────────────┐
│ 필드 편집                    [X]     │
├─────────────────────────────────────┤
│                                     │
│ 필드 ID: [requester_name        ]  │
│          (영문, 숫자, _ 만 가능)    │
│                                     │
│ 필드 타입: [Text Input      ▼]     │
│                                     │
│ 레이블: [요청자 이름            ]   │
│                                     │
│ 플레이스홀더: [홍길동          ]   │
│                                     │
│ ☑ 필수 입력                         │
│                                     │
│ 기본값: [                       ]   │
│                                     │
│ 도움말: [이름을 입력해주세요    ]   │
│                                     │
│ ─── 검증 규칙 ───                   │
│                                     │
│ 최소 길이: [2                   ]   │
│ 최대 길이: [50                  ]   │
│                                     │
│ 정규식 패턴: [                  ]   │
│              (선택사항)             │
│                                     │
│          [취소]  [저장]             │
└─────────────────────────────────────┘
```

### 3. 동적 폼 렌더러 (FormRenderer)

**위치**: `apps/web/src/flow-designer/FormRenderer.tsx`

**기능**:

- FormSchema → React Form 변환
- 필드 타입별 렌더링
- 클라이언트 검증
- 폼 제출 처리

**사용 예시**:

```tsx
// 템플릿 실행 모달에서 사용
<FormRenderer
  schema={startNode.data.formSchema}
  onSubmit={(formData) => {
    // POST /instances with formData
    executeTemplate(templateId, formData);
  }}
/>
```

---

## 🔧 API 변경

### 1. POST /templates/:id/execute

**요청**:

```json
{
  "formData": {
    "requester_name": "홍길동",
    "system": "HR",
    "permission_level": 3,
    "reason": "인사 정보 조회 권한이 필요합니다."
  }
}
```

**응답**:

```json
{
  "instance_id": "uuid-here",
  "status": "RUNNING"
}
```

**백엔드 처리** (`apps/api/src/templates/templates.service.ts`):

```typescript
async executeTemplate(templateId: string, formData?: any) {
  const template = await this.findOne(templateId);

  // ctx 구조 생성
  const ctx = {
    cursor: startNodeId,
    nodes: template.workflow_snapshot.nodes,
    edges: template.workflow_snapshot.edges,
    template_id: templateId,
    formData: formData || {},  // 폼 데이터 추가
  };

  // process_instance 생성
  const instance = await this.instancesService.create({
    template_id: templateId,
    ctx: ctx,
    status: 'CREATED',
  });

  // START job 생성
  await this.createStartJob(instance.id);

  return instance;
}
```

---

## ⚙️ 엔진 변경

### 1. Gateway 노드에서 formData 참조

```rust
// apps/engine/src/main.rs

"gateway" => {
    let condition = current_node
        .get("data")
        .and_then(|d| d.get("condition"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    // ctx.formData 읽기
    let form_data = ctx.get("formData").cloned().unwrap_or(json!({}));

    // 조건 평가 (간단한 예시)
    // 실제로는 JS 엔진 또는 표현식 파서 필요
    let result = evaluate_condition(condition, &form_data);

    // 조건에 따라 다음 노드 선택
    if result {
        // true 경로
    } else {
        // false 경로
    }
}
```

### 2. Service 노드에서 formData 사용

```rust
"service" => {
    let form_data = ctx.get("formData").cloned().unwrap_or(json!({}));

    // HTTP Body에 formData 포함
    let body = json!({
        "instance_id": job.instance_id,
        "form_data": form_data,
    });

    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await?;

    // ...
}
```

---

## 📊 사용 시나리오

### 시나리오 1: 권한 요청 워크플로우

**1단계: 템플릿 설계**

```
민수가 Flow Designer에서 워크플로우를 설계합니다:

1. Start 노드 추가
   - 레이블: "권한 요청 폼"
   - 폼 필드:
     * requester_name (text, 필수)
     * system (select: HR/ERP/CRM, 필수)
     * permission_level (number: 1-5, 필수)
     * reason (textarea, 필수)

2. Gateway 노드 추가
   - 조건: permission_level > 3
   - true → 보안팀 승인
   - false → 팀장 승인만

3. Approval 노드 추가
   - 승인자: manager@company.com

4. Service 노드 추가
   - URL: https://api.company.com/permissions/grant
   - Method: POST
   - Body: formData 포함

5. End 노드 추가

템플릿 저장 → "권한 요청 v1"
```

**2단계: 워크플로우 실행**

```
직원이 템플릿을 선택하고 실행합니다:

1. 템플릿 목록에서 "권한 요청 v1" 선택
2. 폼이 표시됨:
   ┌─────────────────────────────────┐
   │ 권한 요청 폼                     │
   ├─────────────────────────────────┤
   │ 요청자 이름 *                    │
   │ [김철수                      ]  │
   │                                 │
   │ 시스템 *                         │
   │ [HR                        ▼]  │
   │                                 │
   │ 권한 레벨 * (1-5)                │
   │ [4                          ]  │
   │                                 │
   │ 사유 *                           │
   │ [인사 정보 조회 및 수정 권한이  │
   │  필요합니다.                    │
   │                                ]│
   │                                 │
   │          [취소]  [제출]         │
   └─────────────────────────────────┘

3. 제출 → POST /templates/:id/execute
   {
     "formData": {
       "requester_name": "김철수",
       "system": "HR",
       "permission_level": 4,
       "reason": "인사 정보 조회 및 수정 권한이 필요합니다."
     }
   }

4. 엔진이 워크플로우 실행:
   - Start 노드: formData를 ctx에 저장
   - Gateway 노드: permission_level > 3 → true
   - 보안팀 승인 노드로 라우팅
   - 승인 대기 상태
```

**3단계: 실시간 추적**

```
직원이 ExecutionModal에서 실시간으로 진행 상황을 확인:

┌─────────────────────────────────────┐
│ 워크플로우 실행 상태                 │
├─────────────────────────────────────┤
│ [Start] ✓ 완료                      │
│    ↓                                │
│ [Gateway] ✓ 완료                    │
│    ↓ (permission_level > 3: true)  │
│ [보안팀 승인] ⏳ 대기 중             │
│                                     │
│ 요청 정보:                           │
│ - 요청자: 김철수                     │
│ - 시스템: HR                         │
│ - 권한 레벨: 4                       │
│ - 사유: 인사 정보 조회 및...         │
└─────────────────────────────────────┘
```

---

## 🚀 구현 순서

### Step 1: 타입 정의 (30분)

- [ ] `FormField`, `FormSchema` 인터페이스 정의
- [ ] `CustomNodeData` 확장

### Step 2: FormSchemaEditor 컴포넌트 (3-4시간)

- [ ] 필드 목록 UI
- [ ] 필드 추가/삭제 기능
- [ ] 필드 순서 변경 (react-beautiful-dnd)

### Step 3: FieldEditorModal 컴포넌트 (2-3시간)

- [ ] 필드 타입별 설정 UI
- [ ] 검증 규칙 설정

### Step 4: NodePropertiesForm 통합 (1시간)

- [ ] Start 노드 선택 시 FormSchemaEditor 표시

### Step 5: FormRenderer 컴포넌트 (3-4시간)

- [ ] JSON Schema → React Form 변환
- [ ] 필드 타입별 렌더링
- [ ] 클라이언트 검증

### Step 6: 템플릿 실행 UI (2시간)

- [ ] ExecuteTemplateModal 생성
- [ ] FormRenderer 통합
- [ ] API 호출

### Step 7: 백엔드 API 수정 (1-2시간)

- [ ] POST /templates/:id/execute에 formData 파라미터 추가
- [ ] ctx에 formData 포함

### Step 8: 엔진 수정 (1-2시간)

- [ ] Gateway 노드에서 ctx.formData 참조
- [ ] Service 노드에서 ctx.formData 사용

### Step 9: 테스트 (2-3시간)

- [ ] 권한 요청 워크플로우 E2E 테스트
- [ ] 폼 검증 테스트
- [ ] Gateway 조건 분기 테스트

**총 예상 시간**: 1.5-2일

---

## 📚 참고 자료

### JSON Schema

- 공식 문서: https://json-schema.org/
- 검증 라이브러리: https://ajv.js.org/

### React Form 라이브러리

- react-jsonschema-form: https://github.com/rjsf-team/react-jsonschema-form
- react-hook-form: https://react-hook-form.com/
- Formik: https://formik.org/

### 폼 빌더 참고

- Form.io: https://form.io/
- Formily (Alibaba): https://formilyjs.org/
- SurveyJS: https://surveyjs.io/

### BPM 폼 사례

- Camunda Forms: https://docs.camunda.io/docs/components/modeler/forms/
- Flowable Forms: https://www.flowable.com/open-source/docs/form/ch02-Configuration

---

## 🎯 성공 기준

Phase 2.5 완료 시:

✅ Start 노드에서 5가지 이상의 필드 타입 지원
✅ 폼 필드 추가/편집/삭제 가능
✅ 템플릿 실행 시 동적 폼 렌더링
✅ 폼 데이터가 ctx에 저장되어 Gateway/Service 노드에서 사용 가능
✅ 권한 요청 워크플로우 E2E 동작
✅ JSON export/import 지원

---

**작성일**: 2026-01-29  
**작성자**: Antigravity AI  
**상태**: 설계 완료, 구현 대기
