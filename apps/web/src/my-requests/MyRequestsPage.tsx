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

type RequestInstance = {
  id: string;
  requester_id?: string | null;
  template_name: string;
  state: string;
  created_at: string;
  updated_at: string;
  approval_summary: ApprovalSummary | null;
};

type RequestInstanceApiRow = Partial<RequestInstance> & {
  _id?: string;
  status?: string;
  context?: {
    runtime?: {
      access?: { requester_id?: string | null };
      snapshot?: { workflow?: { name?: string } };
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

  const loadHistory = useCallback(async (instanceId: string) => {
    setDetailLoading(true);
    try {
      const response = await fetch(`/api/instances/${encodeURIComponent(instanceId)}/tasks?limit=100`);
      const page = await response.json().catch(() => null);
      if (!response.ok) throw new Error(page?.message || '결재 이력을 불러오지 못했습니다.');
      setHistory(Array.isArray(page?.items) ? page.items : []);
      setError(null);
    } catch (loadError) {
      setHistory([]);
      setError(loadError instanceof Error ? loadError.message : '결재 이력을 불러오지 못했습니다.');
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
      return;
    }
    void loadHistory(selectedId);
    const timer = window.setInterval(() => void loadHistory(selectedId), 3000);
    return () => window.clearInterval(timer);
  }, [loadHistory, selectedId]);

  const selected = requests.find((item) => item.id === selectedId) || null;
  const metrics = useMemo(() => ({
    waiting: requests.filter((item) => ['PENDING', 'IN_PROGRESS'].includes(requestStatus(item))).length,
    approved: requests.filter((item) => requestStatus(item) === 'APPROVED').length,
    rejected: requests.filter((item) => requestStatus(item) === 'REJECTED').length,
  }), [requests]);

  const refresh = async () => {
    setLoading(true);
    await loadRequests();
    if (selectedId) await loadHistory(selectedId);
  };

  return (
    <div className="my-requests-page">
      <div className="my-requests-hero">
        <div>
          <span className="my-requests-eyebrow">REQUEST STATUS</span>
          <h2>내 요청</h2>
          <p>내가 시작한 요청의 현재 결재 단계와 처리 결과를 확인합니다.</p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={15} className={loading ? 'spin' : ''} />
          새로고침
        </button>
      </div>

      <div className="my-requests-metrics">
        <Metric icon={<Clock3 size={18} />} label="진행 중" value={metrics.waiting} tone="waiting" />
        <Metric icon={<CheckCircle2 size={18} />} label="승인 완료" value={metrics.approved} tone="approved" />
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
            <RequestDetail instance={selected} history={history} loading={detailLoading} />
          )}
        </section>
      </div>
    </div>
  );
}

function RequestDetail({
  instance,
  history,
  loading,
}: {
  instance: RequestInstance;
  history: ApprovalTask[];
  loading: boolean;
}) {
  const status = requestStatus(instance);
  const snapshot = history.find((item) => item.content_snapshot)?.content_snapshot || null;
  const totalSteps = instance.approval_summary?.total_steps || Math.max(0, ...history.map((item) => item.total_steps || 0));
  const currentStep = instance.approval_summary?.current_step_order || Math.max(0, ...history.map((item) => item.current_step_order || 0));

  return (
    <>
      <div className="request-detail-header">
        <div>
          <span>{instance.template_name}</span>
          <h3>{requestTitle(instance)}</h3>
          <code>{instance.id}</code>
        </div>
        <StatusBadge status={status} hold={history.some((item) => item.status === 'OPEN' && !!item.hold)} />
      </div>

      <div className="request-progress-card">
        <div>
          <strong>{status === 'APPROVED' ? '모든 결재가 완료되었습니다' : status === 'REJECTED' ? '요청이 반려되었습니다' : `${currentStep || 1}단계 결재 진행 중`}</strong>
          <span>{totalSteps > 0 ? `전체 ${totalSteps}단계` : '결재 단계 준비 중'}</span>
        </div>
        {totalSteps > 0 && (
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

      <div className="request-history-card" data-testid="request-approval-history">
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
      </div>
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

function StatusBadge({ status, hold }: { status: string; hold: boolean }) {
  const display = hold ? '보류' : status === 'IN_PROGRESS' || status === 'PENDING' ? '진행 중' : status === 'APPROVED' ? '승인 완료' : status === 'REJECTED' ? '반려' : status === 'CANCELED' ? '취소' : status;
  return <span className={`my-request-status ${hold ? 'hold' : status.toLowerCase()}`}>{display}</span>;
}

function normalizeInstance(value: unknown): RequestInstance {
  const row = value as RequestInstanceApiRow;
  return {
    id: String(row.id || row._id),
    requester_id: row.requester_id || row.context?.runtime?.access?.requester_id || null,
    template_name: row.template_name || row.context?.runtime?.snapshot?.workflow?.name || '워크플로우',
    state: String(row.state || row.status || 'RUNNING').toUpperCase(),
    created_at: row.created_at || new Date().toISOString(),
    updated_at: row.updated_at || row.created_at || new Date().toISOString(),
    approval_summary: row.approval_summary || null,
  };
}

function requestStatus(instance: RequestInstance): string {
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
