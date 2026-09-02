import React, { useCallback, useEffect, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, Clock, FileText, RefreshCw, XCircle } from 'lucide-react';
import { errorMessage } from '../lib/error-message';
import './DashboardPage.css';

/**
 * 대시보드는 실제 API 응답만 보여준다.
 * 값을 만들어내거나 추정하지 않으며, 조회에 실패한 영역은 실패했다고 표시한다.
 */

type InstanceState = 'CREATED' | 'RUNNING' | 'WAITING' | 'COMPLETED' | 'FAILED' | 'TERMINATED';

interface InstanceRow {
  id: string;
  template_id?: string;
  template_name?: string;
  state: string;
  created_at?: string;
  updated_at?: string;
}

interface HealthReport {
  ok: boolean;
  status: string;
  checks?: {
    database?: string;
    disk?: { ok: boolean; free_bytes: number; minimum_free_bytes: number };
    queue?: { queued: number; running: number; failed: number; oldest_queued_age_ms: number | null };
  };
}

interface DashboardData {
  templatesCount: number;
  instances: InstanceRow[];
  pendingApprovals: number;
}

type Loadable<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; message: string };

const STATE_LABEL: Record<string, string> = {
  CREATED: '생성됨',
  RUNNING: '실행 중',
  WAITING: '대기 중',
  COMPLETED: '완료',
  FAILED: '실패',
  TERMINATED: '종료됨',
};

const normalizeState = (value: unknown): InstanceState => {
  const state = String(value ?? '').toUpperCase();
  return (STATE_LABEL[state] ? state : 'RUNNING') as InstanceState;
};

const getJson = async <T,>(url: string): Promise<T> => {
  const response = await fetch(url, { credentials: 'include' });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((payload as { message?: string })?.message || `${url} 요청 실패 (${response.status})`);
  }
  return payload as T;
};

const formatRelativeTime = (value?: string): string => {
  if (!value) return '-';
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return '-';
  const diffMs = Date.now() - timestamp;
  if (diffMs < 60_000) return '방금 전';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
};

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes)) return '-';
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)}GB` : `${Math.round(bytes / 1024 ** 2)}MB`;
};

export const DashboardPage: React.FC = () => {
  const [data, setData] = useState<Loadable<DashboardData>>({ status: 'loading' });
  const [health, setHealth] = useState<Loadable<HealthReport>>({ status: 'loading' });
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    // 두 영역은 독립적으로 실패할 수 있으므로 따로 처리한다.
    const summary = getJson<unknown[]>('/api/templates')
      .then(async (templates) => {
        const [instances, tasks] = await Promise.all([
          getJson<InstanceRow[]>('/api/instances'),
          getJson<unknown[]>('/api/tasks'),
        ]);
        return {
          templatesCount: Array.isArray(templates) ? templates.length : 0,
          instances: (Array.isArray(instances) ? instances : []).map((row) => ({
            ...row,
            state: normalizeState(row.state),
          })),
          pendingApprovals: Array.isArray(tasks) ? tasks.length : 0,
        } satisfies DashboardData;
      })
      .then((value) => setData({ status: 'ready', value }))
      .catch((error) => setData({ status: 'error', message: errorMessage(error) }));

    const readiness = getJson<HealthReport>('/api/health/ready')
      .then((value) => setHealth({ status: 'ready', value }))
      // /health/ready 는 준비되지 않으면 503으로 응답한다. 이것도 유효한 상태다.
      .catch((error) => setHealth({ status: 'error', message: errorMessage(error) }));

    await Promise.all([summary, readiness]);
    setRefreshedAt(new Date());
  }, []);

  useEffect(() => {
    // 마운트 시 1회 조회 + 주기 갱신. 외부 API와의 동기화라 effect가 맞는 자리다.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const instances = data.status === 'ready' ? data.value.instances : [];
  const countByState = (state: InstanceState) => instances.filter((row) => row.state === state).length;
  const recentInstances = [...instances]
    .sort((a, b) => Date.parse(b.updated_at || b.created_at || '') - Date.parse(a.updated_at || a.created_at || ''))
    .slice(0, 8);

  return (
    <div className="dashboard-page">
      <div className="dashboard-toolbar">
        <span className="dashboard-refreshed">
          {refreshedAt ? `${refreshedAt.toLocaleTimeString('ko-KR')} 기준 · 15초마다 갱신` : '불러오는 중…'}
        </span>
        <button className="dashboard-refresh" onClick={() => void load()} aria-label="새로고침">
          <RefreshCw size={14} />
          새로고침
        </button>
      </div>

      {data.status === 'error' && (
        <div className="dashboard-error" role="alert">
          <AlertTriangle size={16} />
          <div>
            <strong>현황을 불러오지 못했습니다.</strong>
            <span>{data.message}</span>
          </div>
        </div>
      )}

      <div className="dashboard-grid">
        <div className="stats-row">
          <StatCard
            icon={<FileText size={18} />}
            label="등록된 워크플로우"
            value={data.status === 'ready' ? data.value.templatesCount : null}
            unit="개"
            state={data.status}
          />
          <StatCard
            icon={<Activity size={18} />}
            label="실행 중"
            value={data.status === 'ready' ? countByState('RUNNING') + countByState('CREATED') : null}
            unit="건"
            state={data.status}
          />
          <StatCard
            icon={<Clock size={18} />}
            label="대기 중"
            value={data.status === 'ready' ? countByState('WAITING') : null}
            unit="건"
            state={data.status}
          />
          <StatCard
            icon={<XCircle size={18} />}
            label="실패"
            value={data.status === 'ready' ? countByState('FAILED') : null}
            unit="건"
            state={data.status}
            tone={data.status === 'ready' && countByState('FAILED') > 0 ? 'danger' : 'default'}
          />
          <StatCard
            icon={<CheckCircle2 size={18} />}
            label="내 결재 대기"
            value={data.status === 'ready' ? data.value.pendingApprovals : null}
            unit="건"
            state={data.status}
            tone={data.status === 'ready' && data.value.pendingApprovals > 0 ? 'accent' : 'default'}
          />
        </div>

        <div className="dashboard-panels">
          <section className="dashboard-panel">
            <div className="panel-header">
              <h3>시스템 상태</h3>
            </div>
            <div className="panel-body">
              <HealthPanel health={health} />
            </div>
          </section>

          <section className="dashboard-panel">
            <div className="panel-header">
              <h3>최근 실행</h3>
            </div>
            <div className="panel-body">
              {data.status === 'loading' && <div className="panel-placeholder">불러오는 중…</div>}
              {data.status === 'error' && <div className="panel-placeholder">실행 목록을 불러오지 못했습니다.</div>}
              {data.status === 'ready' && recentInstances.length === 0 && (
                <div className="panel-placeholder">아직 실행된 워크플로우가 없습니다.</div>
              )}
              {data.status === 'ready' && recentInstances.length > 0 && (
                <ul className="recent-instance-list">
                  {recentInstances.map((instance) => (
                    <li key={instance.id} className={`recent-instance state-${instance.state.toLowerCase()}`}>
                      <span className="recent-instance-state">{STATE_LABEL[instance.state] ?? instance.state}</span>
                      <span className="recent-instance-name">{instance.template_name || '이름 없는 워크플로우'}</span>
                      <span className="recent-instance-id">{instance.id.slice(0, 8)}</span>
                      <span className="recent-instance-time">{formatRelativeTime(instance.updated_at || instance.created_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};

const StatCard: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: number | null;
  unit: string;
  state: Loadable<unknown>['status'];
  tone?: 'default' | 'danger' | 'accent';
}> = ({ icon, label, value, unit, state, tone = 'default' }) => (
  <div className={`stats-card tone-${tone}`}>
    <div className="stats-card-content">
      <div className="icon-wrapper">{icon}</div>
      <div className="stats-info">
        <span className="stats-label">{label}</span>
        <span className="stats-value">
          {state === 'ready' && value !== null ? (
            <>
              {value} <span className="unit">{unit}</span>
            </>
          ) : (
            <span className="stats-unavailable">{state === 'loading' ? '—' : '조회 실패'}</span>
          )}
        </span>
      </div>
    </div>
  </div>
);

const HealthPanel: React.FC<{ health: Loadable<HealthReport> }> = ({ health }) => {
  if (health.status === 'loading') {
    return <div className="panel-placeholder">상태를 확인하는 중…</div>;
  }

  if (health.status === 'error') {
    return (
      <div className="health-item down">
        <span className="health-indicator" />
        <div className="health-details">
          <span className="health-title">API 준비 상태 확인 실패</span>
          <span className="health-status">{health.message}</span>
        </div>
        <AlertTriangle size={16} className="health-icon" />
      </div>
    );
  }

  const checks = health.value.checks;
  const queue = checks?.queue;
  const disk = checks?.disk;

  return (
    <>
      <div className={`health-item ${checks?.database === 'ok' ? 'active' : 'down'}`}>
        <span className="health-indicator" />
        <div className="health-details">
          <span className="health-title">데이터베이스</span>
          <span className="health-status">{checks?.database === 'ok' ? '연결됨' : '상태 미확인'}</span>
        </div>
      </div>

      <div className={`health-item ${disk?.ok ? 'active' : 'down'}`}>
        <span className="health-indicator" />
        <div className="health-details">
          <span className="health-title">디스크 여유 공간</span>
          <span className="health-status">
            {disk ? `${formatBytes(disk.free_bytes)} 남음 (최소 ${formatBytes(disk.minimum_free_bytes)})` : '상태 미확인'}
          </span>
        </div>
      </div>

      <div className={`health-item ${queue && queue.failed === 0 ? 'active' : 'warning'}`}>
        <span className="health-indicator" />
        <div className="health-details">
          <span className="health-title">엔진 작업 큐</span>
          <span className="health-status">
            {queue
              ? `대기 ${queue.queued} · 실행 ${queue.running} · 실패 ${queue.failed}`
              : '상태 미확인'}
          </span>
        </div>
      </div>
    </>
  );
};
