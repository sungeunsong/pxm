import { BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';

export type ExternalApprovalKey = {
  provider: string;
  requestId: string;
  revision: number;
};

export function dynamicApprovalRequestPath(nodes: any[]): string {
  const paths = new Set<string>(
    (nodes || [])
      .filter((node) => {
        const data = node?.data || node?.config || node || {};
        return (
          (data.nodeType || node?.node_type || node?.type) === 'approval' &&
          (data.approvalLineSource === 'dynamic' || data.approvalType === 'dynamic')
        );
      })
      .map((node) => {
        const data = node?.data || node?.config || node || {};
        return typeof data.approvalRequestPath === 'string' && data.approvalRequestPath.trim()
          ? data.approvalRequestPath.trim()
          : 'approval_request';
      }),
  );
  if (paths.size > 1) {
    throw new BadRequestException(
      'External approval idempotency requires dynamic approval nodes to use the same approval request path',
    );
  }
  return paths.values().next().value || 'approval_request';
}

export function normalizeExternalApprovalRequest(
  formData: Record<string, any>,
  requestPath = 'approval_request',
): ExternalApprovalKey | null {
  const parts = requestPath.split('.').filter(Boolean);
  let container: Record<string, any> = formData;
  for (const part of parts.slice(0, -1)) {
    const next = container[part];
    if (next === undefined) return null;
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      throw new BadRequestException(`approval request path '${requestPath}' must resolve to an object`);
    }
    container = next;
  }
  const requestKey = parts.at(-1) || 'approval_request';
  const request = container[requestKey];
  if (request === undefined) return null;
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new BadRequestException('approval_request must be an object');
  }

  const rawSource = request.source;
  const provider = (
    typeof rawSource === 'string'
      ? rawSource
      : rawSource && typeof rawSource === 'object' && !Array.isArray(rawSource)
        ? rawSource.provider
        : undefined
  )?.trim();
  if (!provider || provider.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(provider)) {
    throw new BadRequestException('approval_request.source.provider must be a valid provider identifier');
  }

  const requestId = typeof request.request_id === 'string' ? request.request_id.trim() : '';
  if (!requestId || requestId.length > 200 || /[\u0000-\u001f\u007f]/.test(requestId)) {
    throw new BadRequestException('approval_request.request_id must contain 1 to 200 printable characters');
  }

  const revision = request.revision === undefined ? 1 : Number(request.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new BadRequestException('approval_request.revision must be a positive integer');
  }

  container[requestKey] = {
    ...request,
    source: { ...(typeof rawSource === 'object' && !Array.isArray(rawSource) ? rawSource : {}), provider },
    request_id: requestId,
    revision,
  };
  return { provider, requestId, revision };
}

export function externalApprovalIdempotencyTtlMs(): number {
  const days = Number(process.env.EXTERNAL_APPROVAL_IDEMPOTENCY_TTL_DAYS ?? 3650);
  const normalizedDays = Number.isFinite(days) && days > 0 ? days : 3650;
  return normalizedDays * 24 * 60 * 60 * 1000;
}

export function externalApprovalKeyHash(key: ExternalApprovalKey): string {
  return createHash('sha256')
    .update(`external-approval-start:v1:${key.provider}:${key.requestId}:${key.revision}`)
    .digest('hex');
}

export function externalApprovalRequestHash(
  workflowId: string,
  formData: Record<string, any>,
  requestPath = 'approval_request',
): string {
  const approvalRequest = requestPath
    .split('.')
    .filter(Boolean)
    .reduce<any>((value, part) => value?.[part], formData);
  return createHash('sha256')
    .update(stableStringify({ workflow_id: workflowId, approval_request: approvalRequest }))
    .digest('hex');
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
