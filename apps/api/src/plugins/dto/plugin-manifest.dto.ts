export type PluginNodeType = 'service';
export type PluginExecutorType = 'builtin' | 'hosted' | 'external_http' | 'http' | 'mock';

export interface PluginConfigSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

export interface PluginSecretPolicy {
  required?: Record<string, string>;
  optional?: Record<string, string>;
}

export interface PluginRetryPolicy {
  max_attempts?: number;
  backoff_ms?: number;
}

export interface PluginManifestDto {
  plugin_id: string;
  version: string;
  display_name: string;
  description?: string;
  category: string;
  node_type: PluginNodeType;
  icon: string;
  config_schema: PluginConfigSchema;
  executor_type: PluginExecutorType;
  executor_ref: string;
  secrets_policy: PluginSecretPolicy;
  input_schema?: PluginConfigSchema;
  output_schema?: PluginConfigSchema;
  timeout_ms?: number;
  retry_policy?: PluginRetryPolicy;
  tags?: string[];
}
