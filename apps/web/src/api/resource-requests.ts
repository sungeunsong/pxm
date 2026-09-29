import { readApiError } from '../lib/api-error';

export type ResourceRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export type ResourceRequest = {
  id: string;
  resource_type: 'script_library' | 'credential';
  resource_ref: { package_name?: string; version?: string; credential_id?: string };
  resource_label: string;
  target_group_id: string;
  target_group_name: string | null;
  approver_role: 'admin' | 'group_manager';
  approver_group_id: string | null;
  approver_group_name: string | null;
  workflow_id: string | null;
  reason: string;
  status: ResourceRequestStatus;
  requested_by: string;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_comment: string | null;
};

export type CreateResourceRequest = {
  resource_type: ResourceRequest['resource_type'];
  resource_ref: ResourceRequest['resource_ref'];
  target_group_id: string;
  workflow_id?: string | null;
  reason?: string;
};

async function send<T>(path: string, init: RequestInit | undefined, fallback: string): Promise<T> {
  const response = await fetch(`/api/resource-requests${path}`, init);
  if (!response.ok) throw await readApiError(response, fallback);
  return response.json();
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const resourceRequestsApi = {
  list: (scope: 'mine' | 'to_me', status?: ResourceRequestStatus) =>
    send<ResourceRequest[]>(`?scope=${scope}${status ? `&status=${status}` : ''}`, undefined, '자원 요청을 불러오지 못했습니다.'),
  create: (request: CreateResourceRequest) => send<ResourceRequest>('', json(request), '요청을 보내지 못했습니다.'),
  approve: (id: string, comment: string) => send<ResourceRequest>(`/${id}/approve`, json({ comment }), '요청을 승인하지 못했습니다.'),
  reject: (id: string, comment: string) => send<ResourceRequest>(`/${id}/reject`, json({ comment }), '요청을 반려하지 못했습니다.'),
  cancel: (id: string) => send<ResourceRequest>(`/${id}/cancel`, json({}), '요청을 취소하지 못했습니다.'),
};
