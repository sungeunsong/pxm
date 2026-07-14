export type CredentialType =
  | 'api_key'
  | 'basic_auth'
  | 'bearer_token'
  | 'connection_string'
  | 'custom';

export interface CredentialProfile {
  id: string;
  group_id: string | null;
  shared_group_ids: string[];
  access_level: 'owner' | 'shared';
  name: string;
  type: CredentialType;
  description: string;
  scopes: string[];
  metadata: Record<string, unknown>;
  active: boolean;
  has_secret: boolean;
  created_at: string;
  updated_at: string;
  last_used_at?: string | null;
  created_by?: string | null;
  updated_by?: string | null;
}

export interface CredentialAuditLog {
  id: string;
  credential_id: string;
  group_id?: string | null;
  action: string;
  actor: string;
  node_id?: string | null;
  workflow_id?: string | null;
  details?: Record<string, unknown> | null;
  created_at: string;
}

export interface SaveCredentialRequest {
  group_id: string;
  shared_group_ids?: string[];
  name: string;
  type: CredentialType;
  description?: string;
  scopes?: string[];
  secret_value?: string;
  metadata?: Record<string, unknown>;
  active?: boolean;
}

const API_BASE_URL = '/api';

export const credentialsApi = {
  async list(activeOnly = false, groupId?: string): Promise<CredentialProfile[]> {
    const params = new URLSearchParams();
    params.set('activeOnly', String(activeOnly));
    if (groupId) params.set('groupId', groupId);
    const response = await fetch(`${API_BASE_URL}/credentials?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch credentials: ${response.statusText}`);
    }
    return response.json();
  },

  async create(data: SaveCredentialRequest & { secret_value: string }): Promise<CredentialProfile> {
    const response = await fetch(`${API_BASE_URL}/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      throw new Error(`Failed to create credential: ${response.statusText}`);
    }
    return response.json();
  },

  async update(id: string, data: SaveCredentialRequest): Promise<CredentialProfile> {
    const response = await fetch(`${API_BASE_URL}/credentials/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      throw new Error(`Failed to update credential: ${response.statusText}`);
    }
    return response.json();
  },

  async deactivate(id: string): Promise<void> {
    const response = await fetch(`${API_BASE_URL}/credentials/${id}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      throw new Error(`Failed to deactivate credential: ${response.statusText}`);
    }
  },

  async audit(credentialId?: string): Promise<CredentialAuditLog[]> {
    const url = credentialId
      ? `${API_BASE_URL}/credentials/${credentialId}/audit`
      : `${API_BASE_URL}/credentials/audit`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch credential audit: ${response.statusText}`);
    }
    return response.json();
  },
};
