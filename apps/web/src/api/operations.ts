export type OperationsOverview = {
  status: 'HEALTHY' | 'WARNING' | 'DANGER';
  generated_at: string;
  queue: {
    queued: number; running: number; failed: number; completed: number;
    oldest_queued_age_ms: number | null;
  };
  runtime: {
    jobs: Array<{ id: string; instance_id: string; type: string; status: string; attempt: number; updated_at: string }>;
    waiting_instances: Array<{
      id: string; updated_at: string; waiting_age_ms: number;
      classification: 'EXPECTED' | 'SUSPICIOUS';
      waiting_reason: 'OPEN_TASK' | 'SCHEDULED_JOB' | 'ACTIVE_CHILD' | 'NO_RESUME_SOURCE';
      open_task_count: number; scheduled_job_count: number; active_child_count: number;
    }>;
    expected_waiting_count: number;
    suspicious_waiting_count: number;
    expired_locks: Array<{ instance_id: string; lock_owner: string; lock_until: string; heartbeat_at: string | null }>;
  };
  outbox: {
    pending: number; running: number; failed: number; dead_letter: number;
    deliveries: Array<{ id: string; endpoint_name: string; event_type: string; status: string; last_error: string | null; updated_at: string }>;
  };
};

const request = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, { credentials: 'include', ...init });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message || `운영 API 요청 실패 (${response.status})`);
  return payload as T;
};

const action = (url: string, reason: string) => request(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ reason }),
});

export const operationsApi = {
  overview: () => request<OperationsOverview>('/api/operations/overview'),
  retryJob: (id: string, reason: string) => action(`/api/operations/jobs/${encodeURIComponent(id)}/retry`, reason),
  reclaimLock: (id: string, reason: string) => action(`/api/operations/instances/${encodeURIComponent(id)}/reclaim-lock`, reason),
  retryOutbox: (id: string, reason: string) => action(`/api/operations/outbox/${encodeURIComponent(id)}/retry`, reason),
};
