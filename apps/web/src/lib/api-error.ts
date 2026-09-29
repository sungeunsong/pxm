/**
 * 서버 오류 응답을 버리지 않고 담는 오류 타입.
 *
 * 서버는 콘솔과 공개 API 모두 같은 형식으로 오류를 준다:
 *   code, message, details[], request_id, remediation, remediation_actor, remediation_group_id
 * 예전에는 화면마다 message만 뽑거나 statusText로 바꿔 원인·해결 방법·문의 번호가 사라졌다.
 */
export type RemediationActor = 'self' | 'group_manager' | 'admin';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly details: string[];
  readonly requestId: string | null;
  readonly remediation: string | null;
  readonly remediationActor: RemediationActor | null;
  readonly remediationGroupId: string | null;
  readonly body: Record<string, unknown> | null;

  constructor(status: number, message: string, body: Record<string, unknown> | null, requestId: string | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.code = typeof body?.code === 'string' ? body.code : null;
    this.details = normalizeDetails(body?.details);
    this.requestId = (typeof body?.request_id === 'string' ? body.request_id : null) || requestId;
    this.remediation = typeof body?.remediation === 'string' ? body.remediation : null;
    this.remediationActor = isRemediationActor(body?.remediation_actor) ? body.remediation_actor : null;
    this.remediationGroupId = typeof body?.remediation_group_id === 'string' ? body.remediation_group_id : null;
  }
}

/** 실패한 응답에서 ApiError를 만든다. 본문이 JSON이 아니어도 상태 코드와 요청 번호는 남긴다. */
export async function readApiError(response: Response, fallback: string): Promise<ApiError> {
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  return apiErrorFromBody(response, body, fallback);
}

/** 본문을 이미 읽은 경우에 쓴다. */
export function apiErrorFromBody(response: Response, body: Record<string, unknown> | null, fallback: string): ApiError {
  const raw = body?.message ?? body?.error;
  const message = Array.isArray(raw) ? raw.map(String).join(', ') : typeof raw === 'string' && raw.trim() ? raw : fallback;
  return new ApiError(response.status, message, body, response.headers.get('x-request-id'));
}

function normalizeDetails(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item : (item as { message?: unknown })?.message))
    .filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

function isRemediationActor(value: unknown): value is RemediationActor {
  return value === 'self' || value === 'group_manager' || value === 'admin';
}
