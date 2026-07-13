export type PxmRole = 'admin' | 'group_manager' | 'user';
export type PrincipalStatus = 'active' | 'disabled' | 'deleted';
export type ApiKeyOwnerType = 'USER' | 'SERVICE_ACCOUNT';
export type ApiKeyScope = 'workflow:read' | 'workflow:execute' | 'task:approve';

export type PxmGroup = {
  id: string;
  name: string;
  description?: string;
  status: 'active' | 'deleted';
  created_at: string;
  updated_at: string;
};

export type PxmUser = {
  id: string;
  display_name: string;
  email?: string | null;
  role: PxmRole;
  group_ids: string[];
  status: PrincipalStatus;
  created_at: string;
  updated_at: string;
};

export type PxmServiceAccount = {
  id: string;
  name: string;
  group_id: string;
  description?: string;
  status: PrincipalStatus;
  created_at: string;
  updated_at: string;
};

export type PxmApiKey = {
  id: string;
  name: string;
  owner_type: ApiKeyOwnerType;
  owner_id: string;
  group_id: string;
  key_prefix: string;
  scopes: ApiKeyScope[];
  allowed_workflow_ids: string[];
  status: string;
  expires_at?: string | null;
  last_used_at?: string | null;
  disabled_at?: string | null;
  created_at: string;
  updated_at: string;
};

export type CreatedApiKey = PxmApiKey & {
  api_key: string;
};

const API_BASE_URL = '/api/authz';

const jsonHeaders = { 'Content-Type': 'application/json' };

export const authzApi = {
  async listGroups(includeDeleted = true): Promise<PxmGroup[]> {
    const response = await fetch(`${API_BASE_URL}/groups?includeDeleted=${includeDeleted ? 'true' : 'false'}`, {
      credentials: 'include',
    });
    return readJson(response, 'group list failed');
  },

  async saveGroup(payload: { id?: string; name: string; description?: string }): Promise<PxmGroup> {
    const response = await fetch(`${API_BASE_URL}/groups`, {
      method: 'POST',
      headers: jsonHeaders, credentials: 'include',
      body: JSON.stringify(payload),
    });
    return readJson(response, 'group save failed');
  },

  async deleteGroup(id: string): Promise<void> {
    const response = await fetch(`${API_BASE_URL}/groups/${encodeURIComponent(id)}?actor=admin`, {
      method: 'DELETE',
      credentials: 'include',
    });
    await readJson(response, 'group delete failed');
  },

  async restoreGroup(id: string): Promise<void> {
    const response = await fetch(`${API_BASE_URL}/groups/${encodeURIComponent(id)}/restore?actor=admin`, {
      method: 'POST',
      credentials: 'include',
    });
    await readJson(response, 'group restore failed');
  },

  async listUsers(groupId?: string): Promise<PxmUser[]> {
    const params = groupId ? `?groupId=${encodeURIComponent(groupId)}` : '';
    const response = await fetch(`${API_BASE_URL}/users${params}`, { credentials: 'include' });
    return readJson(response, 'user list failed');
  },

  async saveUser(payload: {
    id?: string;
    display_name: string;
    email?: string;
    role: PxmRole;
    group_ids: string[];
    password?: string;
  }): Promise<PxmUser> {
    const response = await fetch(`${API_BASE_URL}/users`, {
      method: 'POST',
      headers: jsonHeaders, credentials: 'include',
      body: JSON.stringify(payload),
    });
    return readJson(response, 'user save failed');
  },

  async listServiceAccounts(groupId?: string): Promise<PxmServiceAccount[]> {
    const params = groupId ? `?groupId=${encodeURIComponent(groupId)}` : '';
    const response = await fetch(`${API_BASE_URL}/service-accounts${params}`, { credentials: 'include' });
    return readJson(response, 'service account list failed');
  },

  async saveServiceAccount(payload: {
    id?: string;
    name: string;
    group_id: string;
    description?: string;
  }): Promise<PxmServiceAccount> {
    const response = await fetch(`${API_BASE_URL}/service-accounts`, {
      method: 'POST',
      headers: jsonHeaders, credentials: 'include',
      body: JSON.stringify(payload),
    });
    return readJson(response, 'service account save failed');
  },

  async listApiKeys(groupId?: string): Promise<PxmApiKey[]> {
    const params = groupId ? `?groupId=${encodeURIComponent(groupId)}` : '';
    const response = await fetch(`${API_BASE_URL}/api-keys${params}`, { credentials: 'include' });
    return readJson(response, 'api key list failed');
  },

  async createApiKey(payload: {
    name: string;
    owner_type: ApiKeyOwnerType;
    owner_id: string;
    group_id: string;
    scopes: ApiKeyScope[];
    allowed_workflow_ids: string[];
    expires_at?: string | null;
  }): Promise<CreatedApiKey> {
    const response = await fetch(`${API_BASE_URL}/api-keys`, {
      method: 'POST',
      headers: jsonHeaders, credentials: 'include',
      body: JSON.stringify(payload),
    });
    return readJson(response, 'api key create failed');
  },

  async disableApiKey(id: string): Promise<void> {
    const response = await fetch(`${API_BASE_URL}/api-keys/${encodeURIComponent(id)}/disable?actor=admin`, {
      method: 'PUT',
      credentials: 'include',
    });
    await readJson(response, 'api key disable failed');
  },
};

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body?.message || body?.error || `${fallback}: ${response.status}`;
    throw new Error(Array.isArray(message) ? message.join(', ') : message);
  }
  return body;
}
