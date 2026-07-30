export type WebhookEndpoint = {
  id: string;
  name: string;
  source_provider: string;
  url: string;
  active: boolean;
  timeout_ms: number;
  max_attempts: number;
  has_secret: boolean;
  secret_hint: string;
  created_at: string;
  updated_at: string;
};

export type WebhookDeliveryStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'SENT'
  | 'FAILED'
  | 'DEAD_LETTER'
  | 'CANCELED';

export type WebhookDelivery = {
  id: string;
  event_key: string;
  endpoint_id: string;
  endpoint_name: string;
  instance_id: string;
  event_type: string;
  status: WebhookDeliveryStatus;
  attempt_count: number;
  total_attempt_count: number;
  manual_retry_count: number;
  response_status: number | null;
  last_error: string | null;
  delivered_at: string | null;
  occurred_at: string;
  created_at: string;
  event_payload: Record<string, unknown>;
};

export type WebhookAttempt = {
  id: string;
  attempt_number: number;
  status: WebhookDeliveryStatus;
  response_status: number | null;
  error: string | null;
  duplicate: boolean;
  duration_ms: number;
  started_at: string;
  completed_at: string;
};

export const webhooksApi = {
  endpoints: () => request<WebhookEndpoint[]>('/api/webhooks/endpoints'),
  createEndpoint: (input: {
    name: string;
    source_provider: string;
    url: string;
    secret: string;
    timeout_ms: number;
    max_attempts: number;
  }) =>
    request<WebhookEndpoint>('/api/webhooks/endpoints', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  updateEndpoint: (
    id: string,
    input: Partial<{
      active: boolean;
      name: string;
      source_provider: string;
      url: string;
      secret: string;
      timeout_ms: number;
      max_attempts: number;
    }>,
  ) =>
    request<WebhookEndpoint>(
      `/api/webhooks/endpoints/${encodeURIComponent(id)}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      },
    ),
  deliveries: (input: {
    status?: string;
    endpoint_id?: string;
    limit?: number;
  }) => {
    const params = new URLSearchParams();
    if (input.status) params.set('status', input.status);
    if (input.endpoint_id) params.set('endpoint_id', input.endpoint_id);
    params.set('limit', String(input.limit || 100));
    return request<WebhookDelivery[]>(
      `/api/webhooks/deliveries?${params.toString()}`,
    );
  },
  delivery: (id: string) =>
    request<WebhookDelivery & { attempts: WebhookAttempt[] }>(
      `/api/webhooks/deliveries/${encodeURIComponent(id)}`,
    ),
  retry: (id: string) =>
    request<WebhookDelivery>(
      `/api/webhooks/deliveries/${encodeURIComponent(id)}/retry`,
      { method: 'POST' },
    ),
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'include', ...init });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      payload?.message || `Webhook API 요청 실패 (${response.status})`,
    );
  }
  return payload as T;
}
