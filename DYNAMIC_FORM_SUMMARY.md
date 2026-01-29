# 동적 폼 구성 기능 - 의논 요약

## 📌 배경

**원래 목표**: 결재 솔루션 개발

- HTML import 또는 DnD 방식으로 폼 추가
- JSON export/import 지원
- 범용적으로 사용 가능한 결재 시스템

**현재 상태**: BPM 엔진으로 확장

- 워크플로우 디자이너 완성 (Phase 1)
- 동적 워크플로우 실행 엔진 완성 (Phase 2)
- **다음 단계**: Start 노드에 동적 폼 기능 추가 필요

---

## 🎯 결정 사항

### 1. 접근법 선택: JSON Schema 기반 ✅

**선택한 이유**:

- ✅ 표준 기반 (JSON Schema는 산업 표준)
- ✅ 검증 로직 내장
- ✅ 버전 관리 용이
- ✅ Export/Import 간단
- ✅ 백엔드에서도 같은 스키마로 검증 가능
- ✅ 구현 복잡도 적절 (1-2일)

**제외한 접근법**:

- ❌ HTML Import: 보안 위험 (XSS 공격)
- ⏳ DnD 폼 빌더: Phase 6 (MVP 이후)로 연기

### 2. 단계적 구현 전략

```
Phase 2.5 (지금) → 기본 폼 스키마
  ↓
Phase 4+ → 고급 폼 기능 (조건부 필드, 파일 업로드)
  ↓
Phase 6 → 비주얼 폼 빌더 (DnD)
```

---

## 📋 Phase 2.5 구현 내용

### 1. 지원 필드 타입 (7가지)

```typescript
type FormFieldType =
  | "text" // 단일 텍스트
  | "textarea" // 여러 줄 텍스트
  | "number" // 숫자
  | "select" // 드롭다운
  | "checkbox" // 체크박스
  | "radio" // 라디오 버튼
  | "date"; // 날짜 선택
```

### 2. 데이터 구조

```typescript
interface FormField {
  id: string; // 필드 ID
  type: FormFieldType; // 필드 타입
  label: string; // 레이블
  placeholder?: string; // 플레이스홀더
  required?: boolean; // 필수 여부
  defaultValue?: any; // 기본값
  options?: string[]; // select, radio용
  min?: number; // number, date용
  max?: number;
  minLength?: number; // text, textarea용
  maxLength?: number;
  pattern?: string; // 정규식
  helperText?: string; // 도움말
}

interface FormSchema {
  fields: FormField[];
}
```

### 3. UI 컴포넌트

**FormSchemaEditor** (속성 패널)

- 폼 필드 목록 표시
- 필드 추가/편집/삭제
- 필드 순서 변경

**FieldEditorModal** (필드 편집)

- 필드 타입 선택
- 필드 속성 설정
- 검증 규칙 설정

**FormRenderer** (실행 시)

- JSON Schema → React Form 변환
- 필드 타입별 렌더링
- 클라이언트 검증
- 폼 제출 처리

### 4. 워크플로우 통합

**Start 노드**:

```json
{
  "nodeType": "start",
  "label": "권한 요청 폼",
  "formSchema": {
    "fields": [
      {
        "id": "requester_name",
        "type": "text",
        "label": "요청자 이름",
        "required": true
      },
      {
        "id": "system",
        "type": "select",
        "label": "시스템",
        "options": ["HR", "ERP", "CRM"],
        "required": true
      },
      {
        "id": "permission_level",
        "type": "number",
        "label": "권한 레벨",
        "min": 1,
        "max": 5,
        "required": true
      }
    ]
  }
}
```

**워크플로우 컨텍스트 (ctx)**:

```json
{
  "cursor": "node_1",
  "nodes": [...],
  "edges": [...],
  "template_id": "uuid",
  "formData": {
    "requester_name": "홍길동",
    "system": "HR",
    "permission_level": 4
  }
}
```

**Gateway 노드에서 활용**:

```javascript
// 조건식: permission_level > 3
ctx.formData.permission_level > 3; // true → 보안팀 승인
```

**Service 노드에서 활용**:

```json
// HTTP Body
{
  "instance_id": "uuid",
  "form_data": {
    "requester_name": "홍길동",
    "system": "HR",
    "permission_level": 4
  }
}
```

---

## 🚀 구현 순서

### Step 1: 타입 정의 (30분) ✅ 완료

- [x] `form-types.ts` 생성
- [x] FormField, FormSchema 인터페이스 정의

### Step 2: FormRenderer 컴포넌트 (3-4시간) ✅ 완료

- [x] `FormRenderer.tsx` 생성
- [x] 필드 타입별 렌더링
- [x] 검증 로직
- [x] 스타일시트

### Step 3: FormSchemaEditor 컴포넌트 (3-4시간)

- [ ] 필드 목록 UI
- [ ] 필드 추가/삭제 기능
- [ ] 필드 순서 변경

### Step 4: FieldEditorModal 컴포넌트 (2-3시간)

- [ ] 필드 타입별 설정 UI
- [ ] 검증 규칙 설정

### Step 5: NodePropertiesForm 통합 (1시간)

- [ ] Start 노드 선택 시 FormSchemaEditor 표시

### Step 6: 템플릿 실행 UI (2시간)

- [ ] ExecuteTemplateModal 생성
- [ ] FormRenderer 통합

### Step 7: 백엔드 API (1-2시간)

- [ ] POST /templates/:id/execute에 formData 추가
- [ ] ctx에 formData 포함

### Step 8: 엔진 수정 (1-2시간)

- [ ] Gateway 노드에서 ctx.formData 참조
- [ ] Service 노드에서 ctx.formData 사용

### Step 9: 테스트 (2-3시간)

- [ ] E2E 테스트

**총 예상 시간**: 1.5-2일

---

## 📊 사용 시나리오 예시

### 권한 요청 워크플로우

**1. 템플릿 설계**

```
민수가 Flow Designer에서:

Start (권한 요청 폼)
  - requester_name (text, 필수)
  - system (select: HR/ERP/CRM, 필수)
  - permission_level (number: 1-5, 필수)
  - reason (textarea, 필수)
  ↓
Gateway (permission_level > 3)
  ├─ true → 보안팀 승인
  └─ false → 팀장 승인만
  ↓
Service (권한 부여 API)
  ↓
End
```

**2. 워크플로우 실행**

```
직원이 템플릿 선택 → 폼 입력:
- 요청자: 김철수
- 시스템: HR
- 권한 레벨: 4
- 사유: 인사 정보 조회 권한 필요

제출 → 엔진 실행:
- Start: formData를 ctx에 저장
- Gateway: permission_level > 3 → true
- 보안팀 승인 노드로 라우팅
```

**3. 실시간 추적**

```
ExecutionModal에서 확인:
[Start] ✓ 완료
  ↓
[Gateway] ✓ 완료 (permission_level > 3: true)
  ↓
[보안팀 승인] ⏳ 대기 중

요청 정보:
- 요청자: 김철수
- 시스템: HR
- 권한 레벨: 4
```

---

## 📁 생성된 파일

1. ✅ `/opt/workspace/pxm/DYNAMIC_FORM_DESIGN.md`
   - 상세 설계 문서 (데이터 구조, UI, API, 엔진)

2. ✅ `/opt/workspace/pxm/apps/web/src/flow-designer/form-types.ts`
   - TypeScript 타입 정의

3. ✅ `/opt/workspace/pxm/apps/web/src/flow-designer/FormRenderer.tsx`
   - 동적 폼 렌더러 컴포넌트

4. ✅ `/opt/workspace/pxm/apps/web/src/flow-designer/FormRenderer.css`
   - 폼 렌더러 스타일

5. ✅ `/opt/workspace/pxm/TODO.md` (업데이트)
   - Phase 2.5 추가

---

## 🎯 다음 단계

### 즉시 시작 가능 (Phase 2.5)

1. FormSchemaEditor 컴포넌트 구현
2. FieldEditorModal 컴포넌트 구현
3. NodePropertiesForm에 통합
4. 템플릿 실행 UI 구현
5. 백엔드 API 수정
6. 엔진 수정
7. E2E 테스트

### 향후 확장 (Phase 4+)

- 조건부 필드
- 파일 업로드
- 필드 간 의존성
- 커스텀 검증

### 장기 계획 (Phase 6)

- 비주얼 폼 빌더 (DnD)
- 템플릿 갤러리
- 레이아웃 설정

---

## 💡 핵심 포인트

1. **표준 기반**: JSON Schema 사용으로 호환성 확보
2. **단계적 확장**: 기본 → 고급 → 비주얼 빌더
3. **워크플로우 통합**: formData가 Gateway/Service/Approval에서 활용
4. **보안 우선**: HTML import 제외
5. **빠른 구현**: 1-2일이면 기본 기능 완성

---

**작성일**: 2026-01-29  
**작성자**: Antigravity AI  
**상태**: 의논 완료, 구현 대기
