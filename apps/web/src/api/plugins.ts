export interface PluginJsonSchemaProperty {
  type?: string;
  title?: string;
  description?: string;
  enum?: string[];
  default?: unknown;
}

export interface PluginConfigSchema {
  type: 'object';
  properties: Record<string, PluginJsonSchemaProperty>;
  required?: string[];
}

export interface PluginManifest {
  plugin_id: string;
  version: string;
  display_name: string;
  description?: string;
  category: string;
  node_type: 'service';
  icon: string;
  config_schema: PluginConfigSchema;
  executor_type: 'builtin' | 'hosted' | 'external_http' | 'http' | 'mock';
  executor_ref: string;
  secrets_policy: Record<string, unknown>;
  input_schema?: PluginConfigSchema;
  output_schema?: PluginConfigSchema;
  timeout_ms?: number;
  retry_policy?: {
    max_attempts?: number;
    backoff_ms?: number;
  };
  enabled?: boolean;
  trusted_source?: string;
  trusted?: boolean;
  available_versions?: string[];
  pinned_version?: string;
  workspace_ids?: string[];
  manifest_source?: 'file' | 'registry';
  editable?: boolean;
  tags?: string[];
}

export interface PluginTestRequest {
  plugin_id: string;
  node_id: string;
  config: Record<string, unknown>;
  input?: Record<string, unknown>;
}

export interface PluginTestResponse {
  ok: boolean;
  plugin_id: string;
  node_id?: string;
  duration_ms: number;
  output?: unknown;
  error?: string;
}

export const pluginsApi = {
  async list(): Promise<PluginManifest[]> {
    const response = await fetch('/api/plugins');
    if (!response.ok) {
      throw new Error(`plugins api failed: ${response.status}`);
    }
    return response.json();
  },

  async test(request: PluginTestRequest): Promise<PluginTestResponse> {
    const response = await fetch('/api/plugins/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = payload?.message || payload?.error || `plugin test failed: ${response.status}`;
      throw new Error(Array.isArray(message) ? message.join(', ') : message);
    }
    return payload;
  },

  async controlList(): Promise<PluginManifest[]> {
    const response = await fetch('/api/plugins/control', {
      headers: adminHeaders(),
    });
    if (!response.ok) {
      throw new Error(`plugin control api failed: ${response.status}`);
    }
    return response.json();
  },

  async updateControl(
    pluginId: string,
    payload: {
      enabled?: boolean;
      pinned_version?: string | null;
      workspace_ids?: string[];
      trusted_source?: string | null;
    },
  ): Promise<PluginManifest> {
    const response = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/control`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...adminHeaders(),
      },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(body?.message || `plugin control update failed: ${response.status}`);
    }
    return body;
  },

  async registryList(): Promise<PluginManifest[]> {
    const response = await fetch('/api/plugins/registry', {
      headers: adminHeaders(),
    });
    if (!response.ok) {
      throw new Error(`plugin registry api failed: ${response.status}`);
    }
    return response.json();
  },

  async saveRegistryManifest(manifest: Record<string, unknown>): Promise<PluginManifest> {
    const response = await fetch('/api/plugins/registry', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...adminHeaders(),
      },
      body: JSON.stringify(manifest),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(body?.message || `plugin registry save failed: ${response.status}`);
    }
    return body;
  },

  async deleteRegistryManifest(pluginId: string, version: string): Promise<void> {
    const response = await fetch(
      `/api/plugins/registry/${encodeURIComponent(pluginId)}/${encodeURIComponent(version)}`,
      {
        method: 'DELETE',
        headers: adminHeaders(),
      },
    );
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(body?.message || `plugin registry delete failed: ${response.status}`);
    }
  },
};

function adminHeaders() {
  return {
    'x-actor-id': 'admin',
    'x-actor-roles': 'admin',
  };
}
