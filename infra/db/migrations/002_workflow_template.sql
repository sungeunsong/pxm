-- Workflow Template 테이블 추가
-- Flow Designer에서 생성한 워크플로우 템플릿을 저장

create table if not exists workflow_template (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  
  -- React Flow 노드/엣지 데이터
  nodes jsonb not null default '[]'::jsonb,
  edges jsonb not null default '[]'::jsonb,
  
  -- 메타데이터
  version int not null default 1,
  is_active boolean not null default true,
  
  -- 생성자/수정자 (향후 사용자 관리 추가 시)
  created_by text,
  updated_by text,
  
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 템플릿 이름으로 검색
create index if not exists idx_workflow_template_name on workflow_template (name);

-- 활성 템플릿만 조회
create index if not exists idx_workflow_template_active on workflow_template (is_active, created_at desc);

-- 버전 관리를 위한 인덱스
create index if not exists idx_workflow_template_version on workflow_template (id, version);
