import { readApiError } from '../lib/api-error';
import type { Node, Edge } from 'reactflow';

export interface WorkflowTemplate {
  id: string;
  name: string;
  description?: string;
  group?: string;
  group_id?: string | null;
  tags: string[];
  version_note?: string;
  nodes: Node[];
  edges: Edge[];
  version: number;
  is_active: boolean;
  lifecycle_status: 'DRAFT' | 'PUBLISHED' | 'DISABLED';
  active_published_version: number | null;
  has_unpublished_changes: boolean;
  published_at?: string | null;
  published_by?: string | null;
  created_by?: string;
  updated_by?: string;
  created_at: string;
  updated_at: string;
}

export interface CreateTemplateRequest {
  name: string;
  description?: string;
  group?: string;
  group_id?: string | null;
  tags?: string[];
  version_note?: string;
  nodes: Node[];
  edges: Edge[];
}

export interface UpdateTemplateRequest {
  name?: string;
  description?: string;
  group?: string;
  group_id?: string | null;
  tags?: string[];
  version_note?: string;
  nodes?: Node[];
  edges?: Edge[];
  is_active?: boolean;
}

export interface ExecuteTemplateResponse {
  instance_id: string;
  template_id: string;
  template_name: string;
  status: string;
  mode?: 'async' | 'sync';
  result_url?: string;
  trace_url?: string;
  stream_url?: string;
  result?: unknown;
  result_path?: string | null;
  timed_out?: boolean;
  completed_at?: string | null;
}

export interface StartTemplateRequest {
  mode?: 'async' | 'sync';
  sync_timeout_ms?: number;
  input?: Record<string, any>;
  formData?: Record<string, any>;
}

export interface WorkflowExportDocument {
  schema_version: 'pxm.workflow.v1';
  exported_at: string;
  workflow: {
    definition_id?: string;
    version?: number;
    exported_version_note?: string;
    name: string;
    metadata: {
      description?: string;
      group?: string;
      group_id?: string | null;
      tags: string[];
      version_note?: string;
      imported_from?: WorkflowImportSourceMetadata;
    };
    nodes: Node[];
    edges: Edge[];
    plugin_dependencies: Array<{
      plugin_id: string;
      version?: string;
      node_ids: string[];
    }>;
    script_library_dependencies: Array<{
      package_name: string;
      version: string;
      node_ids: string[];
    }>;
  };
  security: {
    secrets_policy: 'redacted';
    redacted_paths: string[];
  };
}

export interface WorkflowImportSourceMetadata {
  schema_version: string;
  definition_id?: string;
  version?: number;
  exported_version_note?: string;
  exported_at?: string;
}

export interface WorkflowTemplateVersion {
  definition_id: string;
  version: number;
  name: string;
  description?: string;
  group?: string;
  group_id?: string | null;
  tags?: string[];
  version_note?: string;
  created_at?: string;
  updated_at?: string;
  node_count: number;
  edge_count: number;
}

export interface WorkflowVersionChange {
  path: string;
  type: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
}

export interface WorkflowVersionDiff {
  definition_id: string;
  from_version: number;
  to_version: number | null;
  from: {
    version: number;
    name: string;
    version_note?: string;
    node_count: number;
    edge_count: number;
    created_at?: string;
    updated_at?: string;
  };
  to: {
    version: number;
    name: string;
    version_note?: string;
    node_count: number;
    edge_count: number;
    created_at?: string;
    updated_at?: string;
  };
  changes: WorkflowVersionChange[];
}

export interface TestDbWatchConnectionRequest {
  database?: string | null;
  collection?: string | null;
  credential_id?: string | null;
  mode?: 'polling' | 'change_stream';
  cursor_field?: string | null;
  filter?: Record<string, any>;
}

export interface TestDbWatchConnectionResponse {
  ok: boolean;
  duration_ms: number;
  details: Record<string, unknown>;
}

const API_BASE_URL = '/api';

// 서버 오류 본문(원인·세부 항목·해결 방법·문의 번호)을 버리지 않는다. lib/api-error.ts 참고.
const responseError = readApiError;

export type CompatibilityStatus = 'ok' | 'action_required' | 'blocked' | 'warning';

export type CompatibilityItem = {
  kind: 'script_library' | 'credential' | 'approver' | 'plugin' | 'command' | 'workflow_call' | 'group';
  ref: string;
  label: string;
  node_ids: string[];
  status: CompatibilityStatus;
  message: string;
  remediation?: { actor: 'self' | 'group_manager' | 'admin'; action: string; group_id?: string | null };
};

export type CompatibilityReport = {
  workflow_id: string;
  target_group_id: string | null;
  target_group_name: string | null;
  items: CompatibilityItem[];
  summary: Record<CompatibilityStatus, number> & { ready: boolean };
};

export const templatesApi = {
  // 템플릿 생성
  async create(data: CreateTemplateRequest): Promise<WorkflowTemplate> {
    const response = await fetch(`${API_BASE_URL}/templates`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      throw await responseError(response, '워크플로우를 만들지 못했습니다.');
    }

    return response.json();
  },

  // 템플릿 목록 조회
  async list(activeOnly = true): Promise<WorkflowTemplate[]> {
    const params = new URLSearchParams();
    params.set('activeOnly', String(activeOnly));
    
    const response = await fetch(`${API_BASE_URL}/templates?${params.toString()}`);

    if (!response.ok) {
      throw await responseError(response, '워크플로우 목록을 불러오지 못했습니다.');
    }

    return response.json();
  },

  // 템플릿 단건 조회
  async get(id: string): Promise<WorkflowTemplate> {
    const response = await fetch(`${API_BASE_URL}/templates/${id}`);

    if (!response.ok) {
      throw await responseError(response, '워크플로우를 불러오지 못했습니다.');
    }

    return response.json();
  },

  // 템플릿 업데이트
  async update(id: string, data: UpdateTemplateRequest): Promise<WorkflowTemplate> {
    const response = await fetch(`${API_BASE_URL}/templates/${id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      throw await responseError(response, '워크플로우를 저장하지 못했습니다.');
    }

    return response.json();
  },

  // 템플릿 삭제 (soft delete)
  async delete(id: string): Promise<void> {
    const response = await fetch(`${API_BASE_URL}/templates/${id}`, {
      method: 'DELETE',
    });

    if (!response.ok) {
      throw await responseError(response, '워크플로우를 삭제하지 못했습니다.');
    }
  },

  // 템플릿 실행
  async execute(id: string, formData?: Record<string, any>): Promise<ExecuteTemplateResponse> {
    const response = await fetch(`${API_BASE_URL}/templates/${id}/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: formData ? JSON.stringify({ formData }) : undefined,
    });

    if (!response.ok) {
      throw await responseError(response, '워크플로우를 실행하지 못했습니다.');
    }

    return response.json();
  },

  async start(id: string, data: StartTemplateRequest): Promise<ExecuteTemplateResponse> {
    const response = await fetch(`${API_BASE_URL}/templates/${id}/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      throw await responseError(response, '워크플로우를 실행하지 못했습니다.');
    }

    return response.json();
  },

  async export(id: string): Promise<WorkflowExportDocument> {
    const response = await fetch(`${API_BASE_URL}/templates/${id}/export`);

    if (!response.ok) {
      throw await responseError(response, '워크플로우를 내보내지 못했습니다.');
    }

    return response.json();
  },

  async import(data: WorkflowExportDocument): Promise<WorkflowTemplate> {
    const response = await fetch(`${API_BASE_URL}/templates/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      throw await responseError(response, '워크플로우를 가져오지 못했습니다.');
    }

    return response.json();
  },

  async testDbWatchConnection(data: TestDbWatchConnectionRequest): Promise<TestDbWatchConnectionResponse> {
    const response = await fetch(`${API_BASE_URL}/db-watch/test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      throw await responseError(response, 'DB 연결 테스트에 실패했습니다.');
    }

    return response.json();
  },

  async listVersions(id: string): Promise<WorkflowTemplateVersion[]> {
    const response = await fetch(`${API_BASE_URL}/templates/${id}/versions`);

    if (!response.ok) {
      throw await responseError(response, '버전 목록을 불러오지 못했습니다.');
    }

    return response.json();
  },

  async diffVersions(id: string, from: number, to?: number): Promise<WorkflowVersionDiff> {
    const params = new URLSearchParams();
    params.set('from', String(from));
    if (to) {
      params.set('to', String(to));
    }

    const response = await fetch(`${API_BASE_URL}/templates/${id}/versions/diff?${params.toString()}`);

    if (!response.ok) {
      throw await responseError(response, '버전 비교를 불러오지 못했습니다.');
    }

    return response.json();
  },

  async rollbackVersion(id: string, version: number): Promise<WorkflowTemplate> {
    const response = await fetch(`${API_BASE_URL}/templates/${id}/versions/${version}/rollback`, {
      method: 'POST',
    });

    if (!response.ok) {
      throw await responseError(response, '버전을 되돌리지 못했습니다.');
    }

    return response.json();
  },

  /** 저장된 워크플로우를 대상 그룹 기준으로 진단한다. 그룹을 생략하면 현재 소유 그룹 기준이다. */
  async compatibility(id: string, targetGroupId?: string | null): Promise<CompatibilityReport> {
    const query = targetGroupId ? `?target_group_id=${encodeURIComponent(targetGroupId)}` : '';
    const response = await fetch(`${API_BASE_URL}/templates/${id}/compatibility${query}`);
    if (!response.ok) throw await responseError(response, '그룹 호환성을 점검하지 못했습니다.');
    return response.json();
  },

  /** 저장하지 않은 캔버스나 가져올 파일의 노드를 진단한다. */
  async compatibilityForNodes(nodes: unknown[], targetGroupId: string | null): Promise<CompatibilityReport> {
    const response = await fetch(`${API_BASE_URL}/templates/compatibility`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodes, target_group_id: targetGroupId }),
    });
    if (!response.ok) throw await responseError(response, '그룹 호환성을 점검하지 못했습니다.');
    return response.json();
  },

  /**
   * 대상 그룹의 새 초안으로 복제한다. 대상 그룹에서 쓸 수 없는 자원이 있으면 409와 함께
   * ApiError.body.report에 호환성 진단 결과가 온다.
   */
  async clone(id: string, targetGroupId: string, name: string): Promise<{ template: WorkflowTemplate; report: CompatibilityReport }> {
    const response = await fetch(`${API_BASE_URL}/templates/${id}/clone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_group_id: targetGroupId, name }),
    });
    if (!response.ok) throw await responseError(response, '워크플로우를 복제하지 못했습니다.');
    return response.json();
  },

  async publish(id: string): Promise<WorkflowTemplate> {
    const response = await fetch(`${API_BASE_URL}/templates/${id}/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!response.ok) throw await responseError(response, '워크플로우를 배포하지 못했습니다.');
    return (await response.json()).template;
  },

  async disable(id: string): Promise<WorkflowTemplate> {
    const response = await fetch(`${API_BASE_URL}/templates/${id}/disable`, { method: 'POST' });
    if (!response.ok) throw await responseError(response, '배포를 중지하지 못했습니다.');
    return (await response.json()).template;
  },

  async reactivate(id: string): Promise<WorkflowTemplate> {
    const response = await fetch(`${API_BASE_URL}/templates/${id}/reactivate`, { method: 'POST' });
    if (!response.ok) throw await responseError(response, '배포를 다시 켜지 못했습니다.');
    return (await response.json()).template;
  },
};
