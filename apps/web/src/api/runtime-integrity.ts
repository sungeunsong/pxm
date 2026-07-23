export type RuntimeIntegrityFindingType =
  | 'ORPHAN_JOB'
  | 'ORPHAN_TOKEN'
  | 'ORPHAN_TASK'
  | 'STALLED_INSTANCE'
  | 'WAITING_APPROVAL_WITHOUT_TASK'
  | 'INSTANCE_MISSING_DEFINITION';

export type RuntimeIntegrityFinding = {
  id: string;
  type: RuntimeIntegrityFindingType;
  severity: 'high' | 'medium';
  resource_type: 'job' | 'token' | 'task' | 'instance';
  resource_id: string;
  instance_id: string | null;
  title: string;
  description: string;
  observed_updated_at: string;
  repair: {
    supported: boolean;
    action: string | null;
    label: string;
  };
};

export type RuntimeIntegrityScan = {
  scanned_at: string;
  min_age_seconds: number;
  total: number;
  repairable: number;
  by_type: Record<string, number>;
  findings: RuntimeIntegrityFinding[];
};

export type RuntimeIntegrityRepairResult = {
  outcome: 'repaired' | 'no_longer_present';
  finding_type: RuntimeIntegrityFindingType;
  resource_id: string;
  action: string;
  message: string;
  idempotent_replay: boolean;
};

export const runtimeIntegrityApi = {
  async scan(): Promise<RuntimeIntegrityScan> {
    return read(await fetch('/api/runtime-integrity/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ min_age_seconds: 60, limit: 200 }),
    }));
  },

  async repair(finding: RuntimeIntegrityFinding, reason: string): Promise<RuntimeIntegrityRepairResult> {
    return read(await fetch('/api/runtime-integrity/repair', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
      },
      credentials: 'include',
      body: JSON.stringify({
        finding_type: finding.type,
        resource_id: finding.resource_id,
        observed_updated_at: finding.observed_updated_at,
        reason,
      }),
    }));
  },
};

async function read<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.message || '런타임 점검 요청을 처리하지 못했습니다.');
  return body;
}
