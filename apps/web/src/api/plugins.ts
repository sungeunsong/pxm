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

export const pluginsApi = {
  async list(): Promise<PluginManifest[]> {
    const response = await fetch('/api/plugins');
    if (!response.ok) {
      throw new Error(`plugins api failed: ${response.status}`);
    }
    return response.json();
  },
};
