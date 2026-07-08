export type InputPreset = {
  id: string;
  scopeId: string;
  workflow_id: string;
  alias: string;
  name: string;
  description?: string;
  values: Record<string, any>;
  scope?: 'private' | 'group' | 'public';
  group_id?: string | null;
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

export async function saveInputPreset(
  scopeId: string,
  name: string,
  values: Record<string, any>,
  alias?: string,
): Promise<InputPreset> {
  const response = await fetch(`/api/templates/${scopeId}/input-presets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: name.trim(),
      alias: alias || slugifyPresetAlias(name),
      values: sanitizePresetValues(values),
    }),
  });
  if (!response.ok) {
    throw new Error('Failed to save input preset');
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

export function sanitizePresetValues(values: Record<string, any>) {
  return Object.entries(values || {}).reduce<Record<string, any>>((acc, [key, value]) => {
    if (isSensitivePresetKey(key)) {
      return acc;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
      acc[key] = value;
    }
    return acc;
  }, {});
}

function mapPreset(scopeId: string) {
  return (preset: any): InputPreset => ({
    id: String(preset.id),
    scopeId,
    workflow_id: preset.workflow_id || scopeId,
    alias: preset.alias || '',
    name: preset.name || preset.alias || 'Unnamed preset',
    description: preset.description || '',
    values: preset.values || {},
    scope: preset.scope || 'private',
    group_id: preset.group_id || null,
    createdAt: preset.created_at || preset.createdAt || '',
    updatedAt: preset.updated_at || preset.updatedAt || '',
    created_at: preset.created_at,
    updated_at: preset.updated_at,
  });
}

function isSensitivePresetKey(key: string) {
  return /(password|passwd|secret|token|api[_-]?key|credential|private[_-]?key|passphrase)/i.test(key);
}

function slugifyPresetAlias(value: string): string {
  const alias = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return alias || `preset-${Date.now()}`;
}
