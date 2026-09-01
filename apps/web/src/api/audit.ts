export type ManagementAuditEvent = {
  _id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  group_id?: string | null;
  actor_id?: string | null;
  api_key_id?: string | null;
  details: Record<string, unknown>;
  created_at: string;
};

export type ManagementAuditFilters = {
  groupId?: string;
  action?: string;
  from?: string;
  to?: string;
  limit?: number;
};

export const auditApi = {
  async list(filters: ManagementAuditFilters = {}): Promise<ManagementAuditEvent[]> {
    const params = new URLSearchParams();
    if (filters.groupId) params.set('groupId', filters.groupId);
    if (filters.action) params.set('action', filters.action);
    if (filters.from) params.set('from', localDateBoundary(filters.from, false));
    if (filters.to) params.set('to', localDateBoundary(filters.to, true));
    params.set('limit', String(filters.limit || 200));
    const response = await fetch(`/api/audit/management?${params}`, { credentials: 'include' });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.message || `감사 로그 조회 실패 (${response.status})`);
    return Array.isArray(payload) ? payload : [];
  },
};

function localDateBoundary(value: string, endOfDay: boolean) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`);
  return date.toISOString();
}
