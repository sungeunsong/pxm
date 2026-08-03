import React, { useEffect, useState } from 'react';
import { Search, Eye, Filter, CheckCircle2, AlertTriangle, PlayCircle, Clock, RotateCcw, ShieldAlert, StopCircle, PauseCircle } from 'lucide-react';
import './InstanceTracker.css';

interface Instance {
  id: string;
  template_id: string;
  template_name?: string;
  state: string;
  is_paused: boolean;
  created_at: string;
  updated_at: string;
  retry_source_instance_id?: string | null;
  retry_mode?: string | null;
  workflow_call_parent_instance_id?: string | null;
  workflow_call_child_instance_ids?: string[];
  approval_summary?: {
    request_id: string;
    status: string;
    current_step_order: number;
    total_steps: number;
    source_provider?: string | null;
    external_request_id?: string | null;
    external_revision?: number | null;
    title?: string | null;
    open_task_count: number;
  } | null;
}

interface InstanceTrackerProps {
  onSelectInstance?: (instanceId: string) => void;
}

interface RetryPreview {
  instance_id: string;
  template_name: string;
  status: string;
  retry_mode: 'full_instance' | 'failed_node';
  can_retry: boolean;
  reason?: string | null;
  target_node?: {
    id: string;
    label: string;
    type: string;
  } | null;
  failed_event?: {
    type: string;
    node_id?: string | null;
    node_label?: string | null;
    reason?: string | null;
    created_at?: string | null;
  } | null;
  form_data?: Record<string, unknown>;
  context_summary?: {
    data_keys?: string[];
    output_keys?: string[];
    retry_history_count?: number;
  };
  side_effect_warnings?: Array<{
    node_id: string;
    node_label: string;
    node_type: string;
    severity: 'low' | 'high';
    message: string;
  }>;
  requires_confirmation?: boolean;
}

export const InstanceTracker: React.FC<InstanceTrackerProps> = ({ onSelectInstance }) => {
  const [instances, setInstances] = useState<Instance[]>([]);
  const [loading, setLoading] = useState(false);
  const [filterState, setFilterState] = useState<string>('ALL');
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [terminatingId, setTerminatingId] = useState<string | null>(null);
  const [controllingId, setControllingId] = useState<string | null>(null);
  const [previewLoadingId, setPreviewLoadingId] = useState<string | null>(null);
  const [retryPreview, setRetryPreview] = useState<RetryPreview | null>(null);

  const fetchInstances = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/instances');
      if (!response.ok) {
        throw new Error(`instances api failed: ${response.status}`);
      }

      const rows = await response.json();
      setInstances(
        (Array.isArray(rows) ? rows : []).map((row: any) => ({
          id: String(row.id),
          template_id: String(row.template_id || row.definition_id || ''),
          template_name: row.template_name || row.definition_name || 'Untitled Workflow',
          state: String(row.state || row.status || 'RUNNING').toUpperCase(),
          is_paused: row.is_paused === true,
          created_at: row.created_at || new Date().toISOString(),
          updated_at: row.updated_at || row.created_at || new Date().toISOString(),
          retry_source_instance_id:
            row.context?.runtime?.retry?.source_instance_id ||
            row.ctx?.runtime?.retry?.source_instance_id ||
            null,
          retry_mode: row.context?.runtime?.retry?.mode || row.ctx?.runtime?.retry?.mode || null,
          workflow_call_parent_instance_id:
            row.context?.runtime?.parent_instance_id ||
            row.ctx?.runtime?.parent_instance_id ||
            null,
          workflow_call_child_instance_ids: extractWorkflowCallChildInstanceIds(row.context || row.ctx || {}),
          approval_summary: row.approval_summary || null,
        })),
      );
    } catch (error) {
      console.error('Failed to load instances:', error);
      setInstances([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchInstances();
    const interval = setInterval(fetchInstances, 5000);
    return () => clearInterval(interval);
  }, []);

  const getStatusIcon = (state: string) => {
    switch (state.toUpperCase()) {
      case 'COMPLETED': return <CheckCircle2 className="status-icon success" size={16} />;
      case 'FAILED': return <AlertTriangle className="status-icon danger" size={16} />;
      case 'WAITING': return <Clock className="status-icon warning" size={16} />;
      default: return <PlayCircle className="status-icon primary" size={16} />;
    }
  };

  const displayState = (instance: Instance) => instance.is_paused ? 'PAUSED' : instance.state;

  const filteredInstances = instances.filter(inst => {
    if (filterState === 'ALL') return true;
    return displayState(inst) === filterState;
  });
  const retriesBySource = instances.reduce<Record<string, Instance[]>>((acc, inst) => {
    if (inst.retry_source_instance_id) {
      acc[inst.retry_source_instance_id] = [...(acc[inst.retry_source_instance_id] || []), inst];
    }
    return acc;
  }, {});
  const workflowChildrenByParent = instances.reduce<Record<string, Instance[]>>((acc, inst) => {
    if (inst.workflow_call_parent_instance_id) {
      acc[inst.workflow_call_parent_instance_id] = [...(acc[inst.workflow_call_parent_instance_id] || []), inst];
    }
    return acc;
  }, {});

  const openRetryPreview = async (instanceId: string, mode: 'full_instance' | 'failed_node') => {
    setPreviewLoadingId(instanceId);
    try {
      const response = await fetch(`/api/instances/${instanceId}/retry/preview?mode=${mode}`);
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.message || `retry preview api failed: ${response.status}`);
      }
      setRetryPreview(payload);
    } catch (error) {
      alert(error instanceof Error ? error.message : '재시도 미리보기를 불러오지 못했습니다.');
    } finally {
      setPreviewLoadingId(null);
    }
  };

  const confirmRetry = async () => {
    if (!retryPreview) return;
    setRetryingId(retryPreview.instance_id);
    try {
      const response = await fetch(`/api/instances/${retryPreview.instance_id}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: retryPreview.retry_mode }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.message || `retry api failed: ${response.status}`);
      }
      await fetchInstances();
      if (payload?.instance_id) {
        onSelectInstance?.(payload.instance_id);
      }
      setRetryPreview(null);
    } catch (error) {
      alert(error instanceof Error ? error.message : '재시도 요청에 실패했습니다.');
    } finally {
      setRetryingId(null);
    }
  };

  const terminateInstance = async (instanceId: string) => {
    if (!confirm('이 실행과 연결된 대기 중인 자식 실행을 종료하시겠습니까?')) {
      return;
    }
    setTerminatingId(instanceId);
    try {
      const response = await fetch(`/api/instances/${instanceId}/terminate`, {
        method: 'POST',
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.message || `terminate api failed: ${response.status}`);
      }
      await fetchInstances();
    } catch (error) {
      alert(error instanceof Error ? error.message : '실행 종료 요청에 실패했습니다.');
    } finally {
      setTerminatingId(null);
    }
  };

  const setInstancePaused = async (instanceId: string, paused: boolean) => {
    setControllingId(instanceId);
    try {
      const response = await fetch(`/api/instances/${instanceId}/${paused ? 'pause' : 'resume'}`, {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.message || `${paused ? 'pause' : 'resume'} api failed: ${response.status}`);
      }
      await fetchInstances();
    } catch (error) {
      alert(error instanceof Error ? error.message : `실행 ${paused ? '일시중지' : '재개'} 요청에 실패했습니다.`);
    } finally {
      setControllingId(null);
    }
  };

  return (
    <div className="instance-tracker">
      <div className="tracker-header-title">
        <Search size={20} className="header-icon" />
        <h2>워크플로우 실시간 트래커 <span className="neon-badge">TRACKER</span></h2>
      </div>

      {/* FILTER BAR */}
      <div className="tracker-filter-bar">
        <div className="filter-group">
          <Filter size={14} className="filter-icon" />
          <button 
            className={`filter-btn ${filterState === 'ALL' ? 'active' : ''}`}
            onClick={() => setFilterState('ALL')}
          >
            전체 목록 (ALL)
          </button>
          <button 
            className={`filter-btn ${filterState === 'WAITING' ? 'active' : ''}`}
            onClick={() => setFilterState('WAITING')}
          >
            결재대기 (WAITING)
          </button>
          <button
            className={`filter-btn ${filterState === 'PAUSED' ? 'active' : ''}`}
            onClick={() => setFilterState('PAUSED')}
          >
            일시중지 (PAUSED)
          </button>
          <button 
            className={`filter-btn ${filterState === 'COMPLETED' ? 'active' : ''}`}
            onClick={() => setFilterState('COMPLETED')}
          >
            전이완료 (COMPLETED)
          </button>
          <button 
            className={`filter-btn ${filterState === 'FAILED' ? 'active' : ''}`}
            onClick={() => setFilterState('FAILED')}
          >
            실행실패 (FAILED)
          </button>
        </div>
        <button className="btn-refresh" onClick={fetchInstances}>목록 동기화</button>
      </div>

      {/* INSTANCES LIST TABLE */}
      <div className="tracker-table-section">
        {loading && instances.length === 0 ? (
          <div className="loading-state">인스턴스 실행 목록 조회 중...</div>
        ) : filteredInstances.length === 0 ? (
          <div className="empty-state">조건에 부합하는 실행 인스턴스 이력이 없습니다.</div>
        ) : (
          <div className="table-wrapper">
            <table className="premium-table">
              <thead>
                <tr>
                  <th>인스턴스 고유 ID</th>
                  <th>워크플로우 템플릿명</th>
                  <th>실시간 전이상태</th>
                  <th>기동 시간</th>
                  <th>최종 갱신 시간</th>
                  <th>운영 조치</th>
                </tr>
              </thead>
              <tbody>
                {filteredInstances.map(inst => (
                  <tr
                    key={inst.id}
                    className="premium-row"
                    data-testid="tracker-instance-row"
                    data-instance-id={inst.id}
                  >
                    <td className="inst-id-cell" title={inst.id}>
                      <code>{inst.id.slice(0, 18)}...</code>
                    </td>
                    <td className="inst-name-cell">
                      <div className="inst-name-primary">{inst.template_name || 'Untitled Workflow'}</div>
                      {inst.retry_source_instance_id && (
                        <div className="retry-lineage retry-lineage-child">
                          재시도 실행 · 원본 {shortId(inst.retry_source_instance_id)}
                        </div>
                      )}
                      {retriesBySource[inst.id]?.length > 0 && (
                        <div className="retry-lineage retry-lineage-parent">
                          후속 재시도 {retriesBySource[inst.id].length}건 · 최근 {retriesBySource[inst.id][0].state}
                        </div>
                      )}
                      {inst.workflow_call_parent_instance_id && (
                        <div className="retry-lineage retry-lineage-child">
                          자식 실행 · 부모 {shortId(inst.workflow_call_parent_instance_id)}
                        </div>
                      )}
                      {(workflowChildrenByParent[inst.id]?.length > 0 || (inst.workflow_call_child_instance_ids || []).length > 0) && (
                        <div className="retry-lineage retry-lineage-parent">
                          호출 자식 {Math.max(workflowChildrenByParent[inst.id]?.length || 0, inst.workflow_call_child_instance_ids?.length || 0)}건
                        </div>
                      )}
                      {inst.approval_summary && (
                        <div className="retry-lineage approval-progress-line">
                          결재 {inst.approval_summary.current_step_order}/{inst.approval_summary.total_steps}단계
                          {' · '}{inst.approval_summary.status}
                          {' · '}대기 {inst.approval_summary.open_task_count}명
                          {inst.approval_summary.title ? ` · ${inst.approval_summary.title}` : ''}
                        </div>
                      )}
                    </td>
                    <td className="inst-status-cell">
                      <div className={`status-badge-wrapper ${displayState(inst).toLowerCase()}`}>
                        {inst.is_paused ? <PauseCircle className="status-icon paused" size={16} /> : getStatusIcon(inst.state)}
                        <span>{displayState(inst)}</span>
                      </div>
                    </td>
                    <td className="time-cell">{new Date(inst.created_at).toLocaleString()}</td>
                    <td className="time-cell">{new Date(inst.updated_at).toLocaleString()}</td>
                    <td className="action-cell">
                      <button 
                        className="btn-monitor-restore"
                        onClick={() => onSelectInstance?.(inst.id)}
                      >
                        <Eye size={12} /> 실시간 추적
                      </button>
                      {inst.state.toUpperCase() === 'FAILED' && (
                        <button
                          className="btn-retry-instance"
                          onClick={() => openRetryPreview(inst.id, 'full_instance')}
                          disabled={retryingId === inst.id || previewLoadingId === inst.id}
                        >
                          <RotateCcw size={12} />
                          {retryingId === inst.id || previewLoadingId === inst.id ? '확인 중' : '전체 재시도'}
                        </button>
                      )}
                      {['CREATED', 'RUNNING', 'WAITING'].includes(inst.state.toUpperCase()) && (
                        <button
                          data-testid="tracker-pause-toggle"
                          className="btn-pause-instance"
                          onClick={() => setInstancePaused(inst.id, !inst.is_paused)}
                          disabled={controllingId === inst.id}
                        >
                          {inst.is_paused ? <PlayCircle size={12} /> : <PauseCircle size={12} />}
                          {controllingId === inst.id ? '처리 중' : inst.is_paused ? '재개' : '일시중지'}
                        </button>
                      )}
                      {['CREATED', 'RUNNING', 'WAITING'].includes(inst.state.toUpperCase()) && (
                        <button
                          data-testid="tracker-terminate"
                          className="btn-lineage-instance"
                          onClick={() => terminateInstance(inst.id)}
                          disabled={terminatingId === inst.id}
                        >
                          <StopCircle size={12} />
                          {terminatingId === inst.id ? '종료 중' : '종료'}
                        </button>
                      )}
                      {inst.state.toUpperCase() === 'FAILED' && (
                        <button
                          className="btn-retry-node"
                          onClick={() => openRetryPreview(inst.id, 'failed_node')}
                          disabled={retryingId === inst.id || previewLoadingId === inst.id}
                        >
                          <RotateCcw size={12} />
                          실패 노드 재시도
                        </button>
                      )}
                      {inst.retry_source_instance_id && (
                        <button
                          className="btn-lineage-instance"
                          onClick={() => onSelectInstance?.(inst.retry_source_instance_id!)}
                        >
                          원본 추적
                        </button>
                      )}
                      {retriesBySource[inst.id]?.[0] && (
                        <button
                          className="btn-lineage-instance"
                          onClick={() => onSelectInstance?.(retriesBySource[inst.id][0].id)}
                        >
                          최근 재시도
                        </button>
                      )}
                      {inst.workflow_call_parent_instance_id && (
                        <button
                          className="btn-lineage-instance"
                          onClick={() => onSelectInstance?.(inst.workflow_call_parent_instance_id!)}
                        >
                          부모 추적
                        </button>
                      )}
                      {(workflowChildrenByParent[inst.id]?.[0] || inst.workflow_call_child_instance_ids?.[0]) && (
                        <button
                          className="btn-lineage-instance"
                          onClick={() => onSelectInstance?.(workflowChildrenByParent[inst.id]?.[0]?.id || inst.workflow_call_child_instance_ids![0])}
                        >
                          자식 추적
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {retryPreview && (
        <div className="retry-modal-backdrop" role="presentation">
          <div className="retry-modal" role="dialog" aria-modal="true" aria-labelledby="retry-preview-title">
            <div className="retry-modal-header">
              <div>
                <h3 id="retry-preview-title">재시도 확인</h3>
                <p>{retryPreview.retry_mode === 'failed_node' ? '실패 노드부터 다시 실행합니다.' : '처음부터 새 실행을 만듭니다.'}</p>
              </div>
              <button className="retry-modal-close" onClick={() => setRetryPreview(null)}>닫기</button>
            </div>

            <div className="retry-preview-grid">
              <div>
                <span>워크플로우</span>
                <strong>{retryPreview.template_name}</strong>
              </div>
              <div>
                <span>대상 instance</span>
                <strong>{shortId(retryPreview.instance_id)}</strong>
              </div>
              <div>
                <span>재시도 방식</span>
                <strong>{retryPreview.retry_mode === 'failed_node' ? '실패 노드 재시도' : '전체 재시도'}</strong>
              </div>
              <div>
                <span>대상 노드</span>
                <strong>
                  {retryPreview.target_node
                    ? `${retryPreview.target_node.label} (${retryPreview.target_node.type})`
                    : 'n/a'}
                </strong>
              </div>
            </div>

            {retryPreview.failed_event?.reason && (
              <div className="retry-preview-section">
                <span>마지막 실패 사유</span>
                <code>{retryPreview.failed_event.reason}</code>
              </div>
            )}

            <div className="retry-preview-section">
              <span>입력 formData</span>
              <pre>{JSON.stringify(retryPreview.form_data || {}, null, 2)}</pre>
            </div>

            <div className="retry-preview-summary">
              <span>context data keys: {(retryPreview.context_summary?.data_keys || []).join(', ') || 'none'}</span>
              <span>output keys: {(retryPreview.context_summary?.output_keys || []).join(', ') || 'none'}</span>
              <span>retry history: {retryPreview.context_summary?.retry_history_count || 0}</span>
            </div>

            {retryPreview.side_effect_warnings && retryPreview.side_effect_warnings.length > 0 && (
              <div className={`retry-side-effect-warning ${retryPreview.requires_confirmation ? 'high' : 'low'}`}>
                <div className="retry-side-effect-title">
                  <ShieldAlert size={16} />
                  <span>재실행 영향 경고</span>
                </div>
                {retryPreview.side_effect_warnings.map((warning) => (
                  <div key={`${warning.node_id}-${warning.message}`} className="retry-side-effect-item">
                    <strong>{warning.node_label}</strong>
                    <span>{warning.message}</span>
                  </div>
                ))}
              </div>
            )}

            {!retryPreview.can_retry && (
              <div className="retry-preview-warning">{retryPreview.reason || '이 실행은 재시도할 수 없습니다.'}</div>
            )}

            <div className="retry-modal-actions">
              <button className="retry-modal-secondary" onClick={() => setRetryPreview(null)}>취소</button>
              <button
                className="retry-modal-primary"
                onClick={confirmRetry}
                disabled={!retryPreview.can_retry || retryingId === retryPreview.instance_id}
              >
                {retryingId === retryPreview.instance_id ? '재시도 요청 중' : '확인 후 재시도'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

function shortId(id: string) {
  return `${id.slice(0, 8)}...`;
}

function extractWorkflowCallChildInstanceIds(context: any): string[] {
  const outputs = context?.data?.outputs || context?.outputs || {};
  const ids = new Set<string>();

  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    const record = value as Record<string, unknown>;
    const childId = record.child_instance_id;
    if (typeof childId === 'string' && childId.trim()) {
      ids.add(childId);
    }
    Object.values(record).forEach(visit);
  };

  visit(outputs.workflowCalls);
  visit(outputs.workflow_calls);
  return [...ids];
}
