import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  ChevronRight,
  Clock3,
  FileCheck2,
  PauseCircle,
  RefreshCw,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import type { SessionUser } from '../api/session';
import { Button } from '../components/Button';
import { useFeedback } from '../components/feedback/feedback-context';
import { errorMessage } from '../lib/error-message';
import './MyRequestsPage.css';

type ApprovalStatus =
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'APPROVED'
  | 'REJECTED'
  | 'CANCELED';

type ApprovalSummary = {
  request_id: string;
  status: ApprovalStatus;
  current_step_order: number;
  total_steps: number;
  title?: string | null;
  open_task_count: number;
};

type InstanceOutcome = 'SUCCESS' | 'REJECTED' | 'FAILURE' | 'CANCELLED';

type OutcomeReason = {
  code?: string;
  message?: string | null;
  failure_type?: string | null;
};

type RequestInstance = {
  id: string;
  requester_id?: string | null;
  template_name: string;
  state: string;
  outcome: InstanceOutcome | null;
  outcome_reason: OutcomeReason | null;
  created_at: string;
  updated_at: string;
  approval_summary: ApprovalSummary | null;
};

type RequestInstanceApiRow = Partial<RequestInstance> & {
  outcome?: InstanceOutcome | null;
  outcome_reason?: OutcomeReason | null;
  _id?: string;
  status?: string;
  context?: {
    runtime?: {
      access?: { requester_id?: string | null };
      snapshot?: { workflow?: { name?: string } };
    };
  };
};

type ExecutionDetail = {
  state: string;
  formData: Record<string, unknown>;
  outputs: Record<string, unknown>;
};

type ExecutionDetailApiRow = {
  state?: string;
  status?: string;
  context?: {
    data?: {
      formData?: Record<string, unknown>;
      outputs?: Record<string, unknown>;
    };
  };
};

type HoldInfo = {
  actor_id: string;
  comment: string | null;
  held_at: string;
};

type ApprovalTask = {
  task_id: string;
  instance_id: string;
  node_label?: string | null;
  status: 'OPEN' | 'APPROVED' | 'REJECTED' | 'CANCELED';
  assignee: string;
  action?: 'approve' | 'reject' | null;
  comment?: string | null;
  completed_at?: string | null;
  created_at: string;
  step_order?: number | null;
  step_mode?: 'ALL' | 'ANY' | null;
  current_step_order?: number | null;
  total_steps?: number | null;
  content_snapshot?: Record<string, unknown> | null;
  hold?: HoldInfo | null;
};

export function MyRequestsPage({
  currentUser,
  initialInstanceId,
}: {
  currentUser: SessionUser;
  initialInstanceId?: string | null;
}) {
  const [requests, setRequests] = useState<RequestInstance[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialInstanceId || null);
  const [history, setHistory] = useState<ApprovalTask[]>([]);
  const [executionDetail, setExecutionDetail] = useState<ExecutionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRequests = useCallback(async () => {
    try {
      const response = await fetch('/api/instances');
      if (!response.ok) throw new Error('요청 내역을 불러오지 못했습니다.');
      const rows: unknown = await response.json();
      const normalized = (Array.isArray(rows) ? rows : [])
        .map((row: unknown) => normalizeInstance(row))
        .filter((item) => item.requester_id === currentUser.id);
      setRequests(normalized);
      setSelectedId((current) => {
        if (current && normalized.some((item) => item.id === current)) return current;
        return normalized[0]?.id || null;
      });
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '요청 내역을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [currentUser.id]);

  const loadDetail = useCallback(async (instanceId: string) => {
    setDetailLoading(true);
    try {
      const encodedId = encodeURIComponent(instanceId);
      const [historyResponse, instanceResponse] = await Promise.all([
        fetch(`/api/instances/${encodedId}/tasks?limit=100`),
        fetch(`/api/instances/${encodedId}`),
      ]);
      const [page, detail] = await Promise.all([
        historyResponse.json().catch(() => null),
        instanceResponse.json().catch(() => null),
      ]);
      if (!historyResponse.ok) throw new Error(page?.message || '결재 이력을 불러오지 못했습니다.');
      if (!instanceResponse.ok) throw new Error(detail?.message || '실행 결과를 불러오지 못했습니다.');
      setHistory(Array.isArray(page?.items) ? page.items : []);
      setExecutionDetail(normalizeExecutionDetail(detail));
      setError(null);
    } catch (loadError) {
      setHistory([]);
      setExecutionDetail(null);
      setError(loadError instanceof Error ? loadError.message : '요청 상세를 불러오지 못했습니다.');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRequests();
    const timer = window.setInterval(() => void loadRequests(), 3000);
    return () => window.clearInterval(timer);
  }, [loadRequests]);

  useEffect(() => {
    if (initialInstanceId) setSelectedId(initialInstanceId);
  }, [initialInstanceId]);

  useEffect(() => {
    if (!selectedId) {
      setHistory([]);
      setExecutionDetail(null);
      return;
    }
    void loadDetail(selectedId);
    const timer = window.setInterval(() => void loadDetail(selectedId), 3000);
    return () => window.clearInterval(timer);
  }, [loadDetail, selectedId]);

  const selected = requests.find((item) => item.id === selectedId) || null;
  const metrics = useMemo(() => ({
    waiting: requests.filter((item) => ['PENDING', 'IN_PROGRESS'].includes(requestStatus(item))).length,
    approved: requests.filter((item) => ['APPROVED', 'COMPLETED'].includes(requestStatus(item))).length,
    rejected: requests.filter((item) => requestStatus(item) === 'REJECTED').length,
  }), [requests]);

  const refresh = async () => {
    setLoading(true);
    await loadRequests();
    if (selectedId) await loadDetail(selectedId);
  };

  return (
    <div className="my-requests-page">
      <div className="my-requests-hero">
        <div>
          <p>내가 시작한 요청의 실행 상태, 결재 과정과 처리 결과를 확인합니다.</p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={15} className={loading ? 'spin' : ''} />
          새로고침
        </button>
      </div>

      <div className="my-requests-metrics">
        <Metric icon={<Clock3 size={18} />} label="진행 중" value={metrics.waiting} tone="waiting" />
        <Metric icon={<CheckCircle2 size={18} />} label="완료" value={metrics.approved} tone="approved" />
        <Metric icon={<XCircle size={18} />} label="반려" value={metrics.rejected} tone="rejected" />
      </div>

      {error && <div className="my-requests-error">{error}</div>}

      <div className="my-requests-layout">
        <section className="my-requests-list" aria-label="내 요청 목록">
          <div className="my-requests-section-title">
            <strong>최근 요청</strong>
            <span>{requests.length}건</span>
          </div>
          {loading && requests.length === 0 ? (
            <Empty icon={<RotateCcw size={22} />} title="요청 내역을 불러오는 중입니다" />
          ) : requests.length === 0 ? (
            <Empty icon={<FileCheck2 size={22} />} title="아직 시작한 요청이 없습니다" description="요청하기에서 워크플로우를 실행하면 여기에 진행 상태가 표시됩니다." />
          ) : (
            <div className="my-requests-items">
              {requests.map((item) => {
                const status = requestStatus(item);
                return (
                  <button
                    type="button"
                    key={item.id}
                    data-testid="my-request-row"
                    data-instance-id={item.id}
                    className={selectedId === item.id ? 'selected' : ''}
                    onClick={() => setSelectedId(item.id)}
                  >
                    <span className={`request-status-dot ${status.toLowerCase()}`} />
                    <span className="request-list-copy">
                      <strong>{requestTitle(item)}</strong>
                      <small>{item.template_name} · {formatDateTime(item.created_at)}</small>
                    </span>
                    <StatusBadge status={status} hold={false} />
                    <ChevronRight size={16} />
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <section className="my-request-detail" aria-label="요청 진행 상세">
          {!selected ? (
            <Empty icon={<FileCheck2 size={26} />} title="확인할 요청을 선택하세요" />
          ) : (
            <RequestDetail
              instance={selected}
              history={history}
              execution={executionDetail}
              loading={detailLoading}
              onChanged={() => void refresh()}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function RequestDetail({
  instance,
  history,
  execution,
  loading,
  onChanged,
}: {
  instance: RequestInstance;
  history: ApprovalTask[];
  execution: ExecutionDetail | null;
  loading: boolean;
  onChanged: () => void;
}) {
  const { toast, confirm: confirmDialog } = useFeedback();
  const [cancelling, setCancelling] = useState(false);
  const status = requestStatus(instance);
  const inFlight = !TERMINAL_STATES.includes(instance.state) && !instance.outcome;

  const cancelRequest = async () => {
    const proceed = await confirmDialog({
      title: '이 요청을 취소할까요?',
      description: '진행 중인 결재도 함께 중단됩니다. 취소한 요청은 되돌릴 수 없으며, 필요하면 새로 요청해야 합니다.',
      confirmLabel: '요청 취소',
      tone: 'danger',
    });
    if (!proceed) return;
    setCancelling(true);
    try {
      const response = await fetch(`/api/instances/${encodeURIComponent(instance.id)}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `my-request-cancel:${instance.id}` },
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message || '요청을 취소하지 못했습니다.');
      toast.success('요청을 취소했습니다.');
      onChanged();
    } catch (cancelError) {
      toast.error('요청을 취소하지 못했습니다.', { description: errorMessage(cancelError) });
    } finally {
      setCancelling(false);
    }
  };
  const snapshot = history.find((item) => item.content_snapshot)?.content_snapshot || execution?.formData || null;
  const totalSteps = instance.approval_summary?.total_steps || Math.max(0, ...history.map((item) => item.total_steps || 0));
  const currentStep = instance.approval_summary?.current_step_order || Math.max(0, ...history.map((item) => item.current_step_order || 0));
  const hasApprovalFlow = !!instance.approval_summary || history.length > 0 || totalSteps > 0;
  const executionState = (execution?.state || instance.state).toUpperCase();
  const progress = progressCopy(instance, status, executionState, currentStep, totalSteps, hasApprovalFlow);

  return (
    <>
      <div className="request-detail-header">
        <div>
          <span>{instance.template_name}</span>
          <h3>{requestTitle(instance)}</h3>
          <code>{instance.id}</code>
        </div>
        <div className="request-detail-actions">
          <StatusBadge status={status} hold={history.some((item) => item.status === 'OPEN' && !!item.hold)} />
          {inFlight && (
            <Button variant="danger" size="sm" onClick={() => void cancelRequest()} disabled={cancelling} data-testid="my-request-cancel">
              {cancelling ? '취소하는 중' : '요청 취소'}
            </Button>
          )}
        </div>
      </div>

      <div className="request-progress-card">
        <div>
          <strong>{progress.title}</strong>
          <span>{progress.description}</span>
        </div>
        {hasApprovalFlow && totalSteps > 0 && (
          <div className="request-progress-track" aria-label={`전체 ${totalSteps}단계 중 ${currentStep}단계`}>
            {Array.from({ length: totalSteps }, (_, index) => (
              <span key={index} className={index + 1 <= currentStep ? 'active' : ''} />
            ))}
          </div>
        )}
      </div>

      {snapshot && Object.keys(snapshot).length > 0 && (
        <div className="request-summary-card">
          <h4>요청 내용</h4>
          <div>
            {Object.entries(snapshot).slice(0, 6).map(([key, value]) => (
              <dl key={key}>
                <dt>{humanize(key)}</dt>
                <dd>{displayValue(value)}</dd>
              </dl>
            ))}
          </div>
        </div>
      )}

      {execution && Object.keys(execution.outputs).length > 0 && (
        <div className="request-summary-card">
          <h4>실행 결과</h4>
          <div>
            {Object.entries(execution.outputs).map(([key, value]) => (
              <dl key={key}>
                <dt>{humanize(key)}</dt>
                <dd>{displayValue(value)}</dd>
              </dl>
            ))}
          </div>
        </div>
      )}

      {hasApprovalFlow && <div className="request-history-card" data-testid="request-approval-history">
        <div className="my-requests-section-title">
          <strong>결재 진행 이력</strong>
          {loading && <span>갱신 중</span>}
        </div>
        {history.length === 0 ? (
          <Empty icon={<Clock3 size={20} />} title="아직 생성된 결재 단계가 없습니다" />
        ) : (
          <ol className="request-history-list">
            {[...history]
              .sort((a, b) => (a.step_order || 0) - (b.step_order || 0) || a.created_at.localeCompare(b.created_at))
              .map((task) => <HistoryItem key={task.task_id} task={task} />)}
          </ol>
        )}
      </div>}
    </>
  );
}

function HistoryItem({ task }: { task: ApprovalTask }) {
  const isHeld = task.status === 'OPEN' && !!task.hold;
  const label = isHeld
    ? '보류'
    : task.status === 'OPEN'
      ? '승인 대기'
      : task.status === 'APPROVED'
        ? '승인'
        : task.status === 'REJECTED'
          ? '반려'
          : '종료';
  return (
    <li className={`history-${isHeld ? 'hold' : task.status.toLowerCase()}`}>
      <span className="history-icon">
        {isHeld ? <PauseCircle size={16} /> : task.status === 'APPROVED' ? <CheckCircle2 size={16} /> : task.status === 'REJECTED' ? <XCircle size={16} /> : <Clock3 size={16} />}
      </span>
      <div>
        <div className="history-title">
          <strong>{task.step_order ? `${task.step_order}단계` : '결재 단계'} · {task.node_label || task.assignee}</strong>
          <span>{label}</span>
        </div>
        <p>담당자 {task.assignee}{task.step_mode ? ` · ${task.step_mode}` : ''}</p>
        {(task.comment || task.hold?.comment) && <blockquote>{task.comment || task.hold?.comment}</blockquote>}
        <time>{formatDateTime(task.completed_at || task.hold?.held_at || task.created_at)}</time>
      </div>
    </li>
  );
}

function Metric({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: number; tone: string }) {
  return <div className={`my-request-metric ${tone}`}>{icon}<span>{label}</span><strong>{value}</strong></div>;
}

function Empty({ icon, title, description }: { icon: React.ReactNode; title: string; description?: string }) {
  return <div className="my-requests-empty">{icon}<strong>{title}</strong>{description && <p>{description}</p>}</div>;
}

const STATUS_LABELS: Record<string, string> = {
  IN_PROGRESS: '진행 중',
  PENDING: '진행 중',
  RUNNING: '진행 중',
  CREATED: '진행 중',
  WAITING: '진행 중',
  APPROVED: '승인 완료',
  COMPLETED: '완료',
  REJECTED: '반려',
  FAILED: '처리 실패',
  BUSINESS_FAILED: '처리 불가',
  CANCELLED_BY_REQUESTER: '신청 취소',
  TERMINATED: '강제 종료',
  CANCELED: '취소',
};

function StatusBadge({ status, hold }: { status: string; hold: boolean }) {
  const display = hold ? '보류' : STATUS_LABELS[status] || status;
  return <span className={`my-request-status ${hold ? 'hold' : status.toLowerCase()}`}>{display}</span>;
}

function normalizeExecutionDetail(value: unknown): ExecutionDetail {
  const row = value as ExecutionDetailApiRow;
  return {
    state: String(row.state || row.status || 'RUNNING').toUpperCase(),
    formData: row.context?.data?.formData || {},
    outputs: row.context?.data?.outputs || {},
  };
}

function progressCopy(instance: RequestInstance, status: string, executionState: string, currentStep: number, totalSteps: number, hasApprovalFlow: boolean) {
  // 종료된 요청은 업무 결과(outcome)로 설명한다. 누가 멈췄는지, 다음에 무엇을 하면 되는지까지 말한다.
  if (status === 'CANCELLED_BY_REQUESTER') return { title: '요청을 취소했습니다', description: '취소한 요청은 더 진행되지 않습니다. 필요하면 새로 요청하세요.' };
  if (status === 'TERMINATED') return { title: '운영자가 요청 처리를 중단했습니다', description: '사유는 업무 담당 관리자에게 문의하세요.' };
  if (status === 'BUSINESS_FAILED') {
    return { title: '요청을 처리할 수 없습니다', description: instance.outcome_reason?.message || '처리 조건을 충족하지 않습니다.' };
  }
  if (status === 'FAILED') {
    const reason = instance.outcome_reason?.message;
    return {
      title: '요청 처리 중 문제가 발생했습니다',
      description: `${reason ? `${reason} ` : ''}아래 요청 번호와 함께 업무 담당 관리자에게 문의하세요.`,
    };
  }
  if (hasApprovalFlow) {
    if (status === 'APPROVED') return { title: '모든 결재가 완료되었습니다', description: totalSteps > 0 ? `전체 ${totalSteps}단계` : '결재 완료' };
    if (status === 'REJECTED') return { title: '요청이 반려되었습니다', description: totalSteps > 0 ? `전체 ${totalSteps}단계` : '결재 종료' };
    return { title: `${currentStep || 1}단계 결재 진행 중`, description: totalSteps > 0 ? `전체 ${totalSteps}단계` : '결재 단계 준비 중' };
  }
  if (executionState === 'COMPLETED') return { title: '요청 처리가 완료되었습니다', description: '결재 없이 자동 처리되었습니다' };
  return { title: '요청을 처리하고 있습니다', description: '결재 없이 자동 처리 중입니다' };
}

function normalizeInstance(value: unknown): RequestInstance {
  const row = value as RequestInstanceApiRow;
  return {
    id: String(row.id || row._id),
    requester_id: row.requester_id || row.context?.runtime?.access?.requester_id || null,
    template_name: row.template_name || row.context?.runtime?.snapshot?.workflow?.name || '워크플로우',
    state: String(row.state || row.status || 'RUNNING').toUpperCase(),
    outcome: row.outcome || null,
    outcome_reason: row.outcome_reason || null,
    created_at: row.created_at || new Date().toISOString(),
    updated_at: row.updated_at || row.created_at || new Date().toISOString(),
    approval_summary: row.approval_summary || null,
  };
}

const TERMINAL_STATES = ['COMPLETED', 'FAILED', 'TERMINATED'];

/** 목록·상세에 쓰는 대표 상태. 종료된 요청은 실행 상태가 아니라 업무 결과로 정한다. */
function requestStatus(instance: RequestInstance): string {
  switch (instance.outcome) {
    case 'SUCCESS':
      return instance.approval_summary?.status === 'APPROVED' ? 'APPROVED' : 'COMPLETED';
    case 'REJECTED':
      return 'REJECTED';
    case 'FAILURE':
      return instance.outcome_reason?.failure_type === 'business' ? 'BUSINESS_FAILED' : 'FAILED';
    case 'CANCELLED':
      return instance.outcome_reason?.code === 'REQUESTER_CANCELLED' ? 'CANCELLED_BY_REQUESTER' : 'TERMINATED';
    default:
      break;
  }
  if (instance.state === 'FAILED' || instance.state === 'TERMINATED') return instance.state;
  return instance.approval_summary?.status || instance.state;
}

function requestTitle(instance: RequestInstance): string {
  return instance.approval_summary?.title || instance.template_name;
}

function formatDateTime(value?: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function humanize(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function displayValue(value: unknown): string {
  if (value == null) return '-';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
