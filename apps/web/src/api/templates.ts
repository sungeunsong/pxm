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
      throw new Error(`Failed to create template: ${response.statusText}`);
    }

    return response.json();
  },

  // 템플릿 목록 조회
  async list(activeOnly = true): Promise<WorkflowTemplate[]> {
    const params = new URLSearchParams();
    params.set('activeOnly', String(activeOnly));
    
    const response = await fetch(`${API_BASE_URL}/templates?${params.toString()}`);

    if (!response.ok) {
      throw new Error(`Failed to fetch templates: ${response.statusText}`);
    }

    return response.json();
  },

  // 템플릿 단건 조회
  async get(id: string): Promise<WorkflowTemplate> {
    const response = await fetch(`${API_BASE_URL}/templates/${id}`);

    if (!response.ok) {
      throw new Error(`Failed to fetch template: ${response.statusText}`);
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
      throw new Error(`Failed to update template: ${response.statusText}`);
    }

    return response.json();
  },

  // 템플릿 삭제 (soft delete)
  async delete(id: string): Promise<void> {
    const response = await fetch(`${API_BASE_URL}/templates/${id}`, {
      method: 'DELETE',
    });

    if (!response.ok) {
      throw new Error(`Failed to delete template: ${response.statusText}`);
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
      throw new Error(`Failed to execute template: ${response.statusText}`);
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
      throw new Error(`Failed to start template: ${response.statusText}`);
    }

    return response.json();
  },

  async export(id: string): Promise<WorkflowExportDocument> {
    const response = await fetch(`${API_BASE_URL}/templates/${id}/export`);

    if (!response.ok) {
      throw new Error(`Failed to export template: ${response.statusText}`);
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
      throw new Error(`Failed to import template: ${response.statusText}`);
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
      const message = await response.text().catch(() => response.statusText);
      throw new Error(message || `Failed to test DB watch connection: ${response.statusText}`);
    }

    return response.json();
  },

  async listVersions(id: string): Promise<WorkflowTemplateVersion[]> {
    const response = await fetch(`${API_BASE_URL}/templates/${id}/versions`);

    if (!response.ok) {
      throw new Error(`Failed to fetch template versions: ${response.statusText}`);
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
      throw new Error(`Failed to diff template versions: ${response.statusText}`);
    }

    return response.json();
  },

  async rollbackVersion(id: string, version: number): Promise<WorkflowTemplate> {
    const response = await fetch(`${API_BASE_URL}/templates/${id}/versions/${version}/rollback`, {
      method: 'POST',
    });

    if (!response.ok) {
      throw new Error(`Failed to rollback template version: ${response.statusText}`);
    }

    return response.json();
  },
};
