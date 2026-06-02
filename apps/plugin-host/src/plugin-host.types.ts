export interface PluginInvokeRequest {
  plugin_id: string;
  instance: {
    id: string;
    definition_id?: string;
    metadata?: Record<string, unknown>;
  };
  node: {
    id: string;
    token_id?: string;
    metadata?: Record<string, unknown>;
  };
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  attempt: number;
  retry?: {
    max_attempts?: number;
    backoff_ms?: number;
  };
}

export interface PluginInvokeResponse {
  success: boolean;
  output?: Record<string, unknown>;
  retryable?: boolean;
  error?: {
    code: string;
    message: string;
  };
}

export type HostedPluginExecutor = (
  request: PluginInvokeRequest,
) => Promise<PluginInvokeResponse> | PluginInvokeResponse;
