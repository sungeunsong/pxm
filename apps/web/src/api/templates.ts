import type { Node, Edge } from 'reactflow';

export interface WorkflowTemplate {
  id: string;
  name: string;
  description?: string;
  group?: string;
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
  tags?: string[];
  version_note?: string;
  nodes: Node[];
  edges: Edge[];
}

export interface UpdateTemplateRequest {
  name?: string;
  description?: string;
  group?: string;
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
};
