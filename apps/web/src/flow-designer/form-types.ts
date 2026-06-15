// 동적 폼 구성 타입 정의
// apps/web/src/flow-designer/form-types.ts

export type FormFieldType = 
  | 'text'       // 단일 텍스트 입력
  | 'textarea'   // 여러 줄 텍스트
  | 'number'     // 숫자
  | 'select'     // 드롭다운
  | 'checkbox'   // 체크박스
  | 'radio'      // 라디오 버튼
  | 'date'       // 날짜 선택
  | 'file';      // 파일 업로드 (Phase 4+)

  // 조건부 표시 로직을 위한 타입
  export interface FieldCondition {
    field: string;               // 참조할 필드 ID (예: "job")
    operator: 'eq' | 'neq';      // 비교 연산자 (eq: 같음, neq: 다름)
    value: string | number | boolean; // 비교할 값
  }
  
  export interface FormField {
    id: string;                    // 필드 고유 ID (예: "requester_name")
    type: FormFieldType;           // 필드 타입
    label: string;                 // 필드 레이블 (예: "요청자 이름")
    placeholder?: string;          // 플레이스홀더
    required?: boolean;            // 필수 여부
    defaultValue?: any;            // 기본값
    
    // 타입별 옵션
    options?: string[];            // select, radio용 옵션 목록
    min?: number;                  // number, date용 최소값
    max?: number;                  // number, date용 최대값
    minLength?: number;            // text, textarea용 최소 길이
    maxLength?: number;            // text, textarea용 최대 길이
    pattern?: string;              // 정규식 패턴 (예: 이메일, 전화번호)
    
    // UI 옵션
    helperText?: string;           // 도움말 텍스트
    rows?: number;                 // textarea용 행 수
    
    // 조건부 표시 (이 필드가 언제 보일지)
    condition?: FieldCondition;
  }

export interface FormSchema {
  fields: FormField[];
}

// CustomNodeData 확장
export interface CustomNodeData {
  nodeType: 'start' | 'service' | 'script' | 'timer' | 'gateway' | 'approval' | 'end';
  label: string;
  description?: string;
  icon?: string;
  category?: string;
  
  // 실행 상태 (실시간 추적용)
  executionStatus?: 'pending' | 'running' | 'completed' | 'failed';
  
  // Start 노드 전용
  formSchema?: FormSchema;       // 동적 폼 정의
  
  // Service 노드 전용
  url?: string;
  method?: string;
  headers?: string;
  body?: any;
  plugin_id?: string;
  plugin_version?: string;
  timeout?: number;
  retryCount?: number;
  enableRetry?: boolean;

  // JS Script 노드 전용
  scriptType?: 'javascript';
  code?: string;
  outputPath?: string;
  scriptTimeoutMs?: number;
  
  // Timer 노드 전용
  durationMs?: string;
  timerType?: string;
  
  // Gateway 노드 전용
  gatewayType?: string;
  condition?: string;
  
  // Approval 노드 전용
  assignee?: string;
  approvalType?: string;
  requireComment?: boolean;
}

// 폼 검증 결과
export interface ValidationResult {
  valid: boolean;
  errors: Record<string, string>;  // fieldId -> error message
}

// 폼 데이터 (브라우저 내장 FormData와 충돌 방지를 위해 FormValues로 명명)
export type FormValues = Record<string, any>;
