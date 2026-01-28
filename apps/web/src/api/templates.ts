import type { Node, Edge } from 'reactflow';

export interface WorkflowTemplate {
  id: string;
  name: string;
  description?: string;
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
  nodes: Node[];
  edges: Edge[];
}

export interface UpdateTemplateRequest {
  name?: string;
  description?: string;
  nodes?: Node[];
  edges?: Edge[];
  is_active?: boolean;
}

const API_BASE_URL = 'http://localhost:3000';

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
    const url = new URL(`${API_BASE_URL}/templates`);
    url.searchParams.set('activeOnly', String(activeOnly));

    const response = await fetch(url.toString());

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
};
