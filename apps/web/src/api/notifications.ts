export type NotificationDelivery = {
  id: string;
  task_id: string;
  instance_id: string;
  recipient_id: string;
  recipient_hint?: string;
  channel: 'email';
  status: 'PENDING' | 'RUNNING' | 'SENT' | 'FAILED' | 'DEAD_LETTER' | 'CANCELED';
  title: string;
  requester: string | null;
  step_order: number | null;
  step_label: string | null;
  attempt_count: number;
  max_attempts: number;
  last_error: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
  has_source_url: boolean;
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'include', ...init });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message || `알림 API 요청 실패 (${response.status})`);
  return payload as T;
}

export const notificationsApi = {
  list: (status?: string) => request<NotificationDelivery[]>(
    `/api/notifications/deliveries?limit=200${status ? `&status=${encodeURIComponent(status)}` : ''}`,
  ),
  detail: (id: string) => request<NotificationDelivery & { attempts: Array<{
    id: string; attempt_number: number; status: string; error: string | null;
    duration_ms: number; completed_at: string;
  }> }>(`/api/notifications/deliveries/${encodeURIComponent(id)}`),
  retry: (id: string, reason: string) => request<NotificationDelivery>(
    `/api/notifications/deliveries/${encodeURIComponent(id)}/retry`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason }) },
  ),
};
