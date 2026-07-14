export type InputPreset = {
  id: string;
  scopeId: string;
  workflow_id: string;
  workflow_name?: string;
  workflow_version?: number;
  workflow_group_name?: string | null;
  alias: string;
  name: string;
  description?: string;
  values: Record<string, any>;
  scope: 'private' | 'group' | 'shared';
  group_id?: string | null;
  owner_group_id?: string | null;
  shared_group_ids: string[];
  created_by?: string | null;
  updated_by?: string | null;
  can_manage: boolean;
  createdAt: string;
  updatedAt: string;
  created_at?: string;
  updated_at?: string;
};

export async function listInputPresets(scopeId: string): Promise<InputPreset[]> {
  const response = await fetch(`/api/templates/${scopeId}/input-presets`);
  if (!response.ok) {
    throw new Error('Failed to load input presets');
  }
  const presets = await response.json();
  return Array.isArray(presets) ? presets.map(mapPreset(scopeId)) : [];
}

export async function listAllInputPresets(): Promise<InputPreset[]> {
  const response = await fetch('/api/templates/input-presets');
  if (!response.ok) throw new Error('Failed to load input presets');
  const presets = await response.json();
  return Array.isArray(presets) ? presets.map((preset) => mapPreset(preset.workflow_id)(preset)) : [];
}

export async function createInputPreset(
  scopeId: string,
  preset: Pick<InputPreset, 'alias' | 'name' | 'description' | 'values' | 'scope' | 'shared_group_ids'>,
): Promise<InputPreset> {
  const response = await fetch(`/api/templates/${scopeId}/input-presets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      alias: preset.alias || slugifyPresetAlias(preset.name),
      name: preset.name.trim(),
      description: preset.description || '',
      values: preset.values,
      scope: preset.scope,
      shared_group_ids: preset.scope === 'shared' ? preset.shared_group_ids : [],
    }),
  });
  if (!response.ok) throw new Error(await readError(response, 'Failed to create input preset'));
  return mapPreset(scopeId)(await response.json());
}

export async function saveInputPreset(
  scopeId: string,
  name: string,
  values: Record<string, any>,
  alias?: string,
  scope: InputPreset['scope'] = 'private',
): Promise<InputPreset> {
  const response = await fetch(`/api/templates/${scopeId}/input-presets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: name.trim(),
      alias: alias || slugifyPresetAlias(name),
      values,
      scope,
    }),
  });
  if (!response.ok) {
    throw new Error('Failed to save input preset');
  }
  return mapPreset(scopeId)(await response.json());
}

export async function updateInputPreset(
  scopeId: string,
  preset: Pick<InputPreset, 'id' | 'alias' | 'name' | 'description' | 'values' | 'scope' | 'shared_group_ids'>,
): Promise<InputPreset> {
  const response = await fetch(`/api/templates/${scopeId}/input-presets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: preset.id,
      alias: preset.alias,
      name: preset.name.trim(),
      description: preset.description || '',
      values: preset.values,
      scope: preset.scope,
      shared_group_ids: preset.scope === 'shared' ? preset.shared_group_ids : [],
    }),
  });
  if (!response.ok) {
    throw new Error(await readError(response, 'Failed to update input preset'));
  }
  return mapPreset(scopeId)(await response.json());
}

export async function deleteInputPreset(scopeId: string, id: string): Promise<void> {
  const response = await fetch(`/api/templates/${scopeId}/input-presets/${id}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new Error('Failed to delete input preset');
  }
}

function mapPreset(scopeId: string) {
  return (preset: any): InputPreset => ({
    id: String(preset.id),
    scopeId,
    workflow_id: preset.workflow_id || scopeId,
    workflow_name: preset.workflow_name,
    workflow_version: preset.workflow_version,
    workflow_group_name: preset.workflow_group_name || null,
    alias: preset.alias || '',
    name: preset.name || preset.alias || 'Unnamed preset',
    description: preset.description || '',
    values: preset.values || {},
    scope: preset.scope === 'public' ? 'group' : preset.scope || 'private',
    group_id: preset.group_id || null,
    owner_group_id: preset.owner_group_id || preset.group_id || null,
    shared_group_ids: Array.isArray(preset.shared_group_ids) ? preset.shared_group_ids : [],
    created_by: preset.created_by || null,
    updated_by: preset.updated_by || null,
    can_manage: preset.can_manage === true,
    createdAt: preset.created_at || preset.createdAt || '',
    updatedAt: preset.updated_at || preset.updatedAt || '',
    created_at: preset.created_at,
    updated_at: preset.updated_at,
  });
}

async function readError(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => null);
  if (Array.isArray(body?.message)) return body.message.join('\n');
  return body?.message || fallback;
}

function slugifyPresetAlias(value: string): string {
  const alias = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return alias || `preset-${Date.now()}`;
}
