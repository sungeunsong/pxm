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
};
