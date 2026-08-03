import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Check,
  FileText,
  Filter,
  Pause,
  RotateCcw,
  Search as SearchIcon,
  X,
} from 'lucide-react';
import { Button } from '../components/Button';
import './InboxPage.css';

interface Task {
  id: string;
  instance_id: string;
  process_definition_id?: string | null;
  template_name?: string | null;
  instance_status?: string | null;
  node_id: string;
  status: string;
  assignee?: string;
  payload?: Record<string, any>;
  approver_channel?: 'pxm_user' | 'external_email';
  approval_channels?: Array<'pxm_user' | 'external_email'>;
  completed_via?: 'pxm_user' | 'external_email' | null;
  authentication_method?: string | null;
  form_data?: Record<string, any>;
  approval_request_id?: string | null;
  approval_step_id?: string | null;
  request_status?: string | null;
  current_step_order?: number | null;
  total_steps?: number | null;
  step_order?: number | null;
  step_mode?: 'ALL' | 'ANY' | null;
  step_status?: string | null;
  source_provider?: string | null;
  external_request_id?: string | null;
  external_revision?: number | null;
  content_snapshot?: Record<string, any> | null;
  approval_line_snapshot?: {
    steps?: Array<{
      order: number;
      label?: string | null;
      mode?: string;
      approvers?: Array<{
        assignee?: string;
        display_snapshot?: { name?: string | null };
      }>;
    }>;
  } | null;
  comment?: string | null;
  completed_at?: string | null;
  created_at: string;
}

function normalizeHistoryTask(item: any): Task {
  return {
    ...item,
    id: item.task_id,
    process_definition_id: item.workflow_id,
    template_name: item.workflow_name,
    form_data: item.content_snapshot || {},
  };
}

export interface InboxPageProps {
  onSwitchToDesigner?: () => void;
}

export const InboxPage: React.FC<InboxPageProps> = ({ onSwitchToDesigner }) => {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeSubTab, setActiveSubTab] = useState<'pending' | 'completed' | 'rejected'>('pending');
  const [searchTerm, setSearchTerm] = useState('');
  const [screen, setScreen] = useState<'list' | 'detail'>('list');
  const [decision, setDecision] = useState<'approve' | 'reject' | 'hold'>('approve');
  const [comment, setComment] = useState('요청 내용을 확인하였습니다. 승인합니다.');
  const [rejectReasonChecked, setRejectReasonChecked] = useState(false);
  const [instanceHistory, setInstanceHistory] = useState<Task[]>([]);

  const formatDate = (value?: string) => {
    if (!value) return '-';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
  };

  const formatDateTime = (value?: string) => {
    if (!value) return '-';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  };

  const readField = (task: Task | null, keys: string[], fallback = '-') => {
    if (!task) return fallback;
    for (const key of keys) {
      const value = task.form_data?.[key];
      if (value !== undefined && value !== null && String(value).trim() !== '') {
        return String(value);
      }
    }
    return fallback;
  };

  const getTaskTitle = (task: Task | null) => {
    if (!task) return '승인 요청';
    const approvalContent =
      task.content_snapshot || task.form_data?.approval_request?.content || {};
    return (
      approvalContent.title ||
      task.template_name ||
      readField(task, ['요청 프로세스', 'processName', 'title', 'requestTitle'], '') ||
      task.node_id ||
      '승인 요청'
    );
  };

  const getRequester = (task: Task | null) =>
    String(
      task?.content_snapshot?.requester ||
        task?.form_data?.approval_request?.content?.requester ||
        readField(task, ['신청자', 'requester', 'requesterName', 'applicant'], task?.assignee || '-'),
    );

  const getApprovalChannels = (task: Task | null) => {
    const channels: Array<'pxm_user' | 'external_email'> =
      task?.approval_channels ||
      task?.payload?.approval_channels ||
      [task?.approver_channel || task?.payload?.approver_channel || 'pxm_user'];
    return channels
      .map((channel) =>
        channel === 'external_email' ? '이메일 링크' : 'PXM 웹',
      )
      .join(' + ');
  };

  const getProcessLabel = (task: Task | null) =>
    task?.template_name || readField(task, ['요청 프로세스', 'processName'], task?.process_definition_id || '-');

  const fetchTasks = async () => {
    setLoading(true);
    try {
      const [openResponse, completedResponse, rejectedResponse] = await Promise.all([
        fetch('/api/tasks'),
        fetch('/api/tasks/history?status=APPROVED,CANCELED&limit=100'),
        fetch('/api/tasks/history?status=REJECTED&limit=100'),
      ]);
      if (!openResponse.ok || !completedResponse.ok || !rejectedResponse.ok) {
        throw new Error('Failed to fetch tasks');
      }
      const [openRows, completedPage, rejectedPage] = await Promise.all([
        openResponse.json(),
        completedResponse.json(),
        rejectedResponse.json(),
      ]);
      setTasks([
        ...(Array.isArray(openRows) ? openRows : []),
        ...((completedPage?.items || []).map(normalizeHistoryTask)),
        ...((rejectedPage?.items || []).map(normalizeHistoryTask)),
      ]);
    } catch (error) {
      console.error('Failed to fetch tasks:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTasks();
    const interval = setInterval(fetchTasks, 3000);
    return () => clearInterval(interval);
  }, []);

  const visibleTasks = useMemo(() => {
    const byTab = tasks.filter((task) => {
      if (activeSubTab === 'pending') return task.status === 'OPEN';
      if (activeSubTab === 'rejected') return task.status === 'REJECTED';
      return task.status === 'APPROVED' || task.status === 'CANCELED';
    });
    const q = searchTerm.trim().toLowerCase();
    if (!q) return byTab;
    return byTab.filter((task) =>
      [getTaskTitle(task), getRequester(task), task.instance_id, task.node_id]
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [activeSubTab, searchTerm, tasks]);
  const taskCounts = useMemo(
    () => ({
      pending: tasks.filter((task) => task.status === 'OPEN').length,
      completed: tasks.filter((task) => task.status === 'APPROVED' || task.status === 'CANCELED').length,
      rejected: tasks.filter((task) => task.status === 'REJECTED').length,
    }),
    [tasks],
  );

  useEffect(() => {
    if (!selectedTask) return;
    const refreshedTask = tasks.find((task) => task.id === selectedTask.id);
    if (refreshedTask) {
      setSelectedTask(refreshedTask);
      return;
    }
    setSelectedTask(null);
    setScreen('list');
  }, [tasks]);

  const openTask = async (task: Task) => {
    setSelectedTask(task);
    setDecision('approve');
    setComment('요청 내용을 확인하였습니다. 승인합니다.');
    setRejectReasonChecked(false);
    setScreen('detail');
    try {
      const response = await fetch(`/api/instances/${task.instance_id}/tasks?limit=100`);
      const page = await response.json().catch(() => null);
      setInstanceHistory(
        response.ok ? (page?.items || []).map(normalizeHistoryTask) : [],
      );
    } catch {
      setInstanceHistory([]);
    }
  };

  const handleProcessDecision = async () => {
    if (!selectedTask) return;

    const action = decision === 'reject' ? 'reject' : 'approve';
    const displayActionText = decision === 'approve' ? '승인' : decision === 'reject' ? '반려' : '보류';

    if (!confirm(`선택한 문서를 [${displayActionText}] 처리하시겠습니까?\n의견: ${comment}`)) return;

    try {
      const res = await fetch(`/api/tasks/${selectedTask.id}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `inbox:${selectedTask.id}:${action}` },
        body: JSON.stringify({ action, comment }),
      });

      if (!res.ok) throw new Error('Failed to complete task');

      alert(`성공적으로 [${displayActionText}] 처리되었습니다.`);
      setSelectedTask(null);
      setScreen('list');
      fetchTasks();
    } catch (error) {
      console.error('Failed to process task:', error);
      alert('처리 중 오류가 발생했습니다.');
    }
  };

  const renderList = () => (
    <div className="inbox-list-page">
      <div className="inbox-list-header">
        <div>
          <h2>내 결재함</h2>
          <p>승인 대기 중인 작업을 확인하고 상세 화면에서 처리합니다.</p>
        </div>
        <button className="icon-action-btn" onClick={fetchTasks} title="새로고침">
          <RotateCcw size={14} />
        </button>
      </div>

      <div className="sub-tabs">
        <button
          className={`sub-tab-btn ${activeSubTab === 'pending' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('pending')}
        >
          승인 대기 <span className="tab-count badge-pending">{taskCounts.pending}</span>
        </button>
        <button
          className={`sub-tab-btn ${activeSubTab === 'completed' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('completed')}
        >
          처리 완료 <span className="tab-count badge-completed">{taskCounts.completed}</span>
        </button>
        <button
          className={`sub-tab-btn ${activeSubTab === 'rejected' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('rejected')}
        >
          반려함 <span className="tab-count badge-rejected">{taskCounts.rejected}</span>
        </button>
      </div>

      <div className="search-filter-bar">
        <div className="select-wrapper">
          <select className="form-select-sm">
            <option>전체 프로세스</option>
          </select>
        </div>
        <div className="search-input-wrap">
          <SearchIcon size={13} className="search-icon-inside" />
          <input
            type="text"
            placeholder="요청명, 신청자 검색"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        <button className="icon-action-btn" title="필터">
          <Filter size={13} />
        </button>
        {loading && <span className="loading-text">loading...</span>}
      </div>

      <div className="table-container">
        <table className="inbox-table">
          <thead>
            <tr>
              <th>요청명</th>
              <th>신청자</th>
              <th>요청일</th>
              <th>담당 노드</th>
              <th>상태</th>
            </tr>
          </thead>
          <tbody>
            {visibleTasks.map((task) => (
              <tr
                key={task.id}
                className="task-row-item"
                data-testid="inbox-task-row"
                data-task-id={task.id}
                data-instance-id={task.instance_id}
                onClick={() => openTask(task)}
              >
                <td>
                  <div className="req-name-cell">
                    <span className="req-tag">{task.node_id}</span>
                    {getTaskTitle(task)}
                  </div>
                </td>
                <td>{getRequester(task)}</td>
                <td>{formatDate(task.created_at)}</td>
                <td>{task.node_id}</td>
                <td>
                  <span className={`status-badge-outline ${task.status.toLowerCase()}`}>
                    {task.status === 'OPEN'
                      ? '승인 대기'
                      : task.status === 'APPROVED'
                        ? '승인 완료'
                        : task.status === 'REJECTED'
                          ? '반려'
                          : '취소'}
                  </span>
                </td>
              </tr>
            ))}

            {visibleTasks.length === 0 && (
              <tr>
                <td colSpan={5} className="table-empty-cell">
                  {activeSubTab === 'pending'
                    ? '승인 대기 작업이 없습니다.'
                    : '처리 이력이 없습니다.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="pagination-bar">
        <span>전체 {visibleTasks.length}건</span>
        <div className="pagination-arrows">
          <button disabled>&lt;</button>
          <button className="active">1</button>
          <button disabled>&gt;</button>
        </div>
      </div>
    </div>
  );

  const renderDetail = () => {
    if (!selectedTask) {
      return (
        <div className="no-task-selected-wrap">
          <div className="no-task-selected-card">
            <FileText size={44} className="empty-icon" />
            <h4>선택된 결재 문서가 없습니다</h4>
            <p>목록에서 결재할 대기 문서를 선택해 주세요.</p>
          </div>
        </div>
      );
    }

    return (
      <div className="inbox-detail-page">
        <div className="inbox-detail-header">
          <button className="back-to-list-btn" onClick={() => setScreen('list')}>
            <ArrowLeft size={15} />
            목록으로
          </button>
          <div>
            <h2>{getTaskTitle(selectedTask)}</h2>
            <p>{selectedTask.instance_id}</p>
          </div>
          <span className={`status-badge-full ${selectedTask.status === 'OPEN' ? 'orange' : ''}`}>
            {selectedTask.status}
          </span>
        </div>

        <div className="detail-action-card">
          <div className="inbox-section-compact detail-info-section">
            <div className="section-title-wrap">
              <h3>결재 상세</h3>
              <span className="subtitle-desc">요청 내용을 검토합니다.</span>
            </div>

            <div className="details-card-body">
              {onSwitchToDesigner && (
                <button onClick={onSwitchToDesigner} className="view-designer-link">
                  Flow Designer에서 템플릿 보기 &gt;
                </button>
              )}

              <div className="info-block">
                <h5>신청 정보</h5>
                <div className="grid-info-2col">
                  <div className="info-cell">
                    <span className="info-label">신청자</span>
                    <span className="info-val">{getRequester(selectedTask)}</span>
                  </div>
                  <div className="info-cell">
                    <span className="info-label">신청일시</span>
                    <span className="info-val">
                      {readField(selectedTask, ['신청일시', 'requestedAt'], formatDateTime(selectedTask.created_at))}
                    </span>
                  </div>
                  <div className="info-cell">
                    <span className="info-label">프로세스</span>
                    <span className="info-val">{getProcessLabel(selectedTask)}</span>
                  </div>
                  <div className="info-cell">
                    <span className="info-label">요청 ID</span>
                    <span className="info-val font-mono-style">{selectedTask.instance_id}</span>
                  </div>
                </div>
              </div>

              <div className="info-block">
                <h5>요청 내용</h5>
                <div className="vertical-info-list">
                  <div className="info-cell">
                    <span className="info-label">외부 요청 키</span>
                    <span className="info-val font-mono-style">
                      {selectedTask.source_provider && selectedTask.external_request_id
                        ? `${selectedTask.source_provider}:${selectedTask.external_request_id}:r${selectedTask.external_revision || 1}`
                        : '-'}
                    </span>
                  </div>
                  <div className="info-cell">
                    <span className="info-label">현재 결재 단계</span>
                    <span className="info-val highlighting-blue">
                      {selectedTask.current_step_order && selectedTask.total_steps
                        ? `${selectedTask.current_step_order} / ${selectedTask.total_steps}단계 · ${selectedTask.step_mode || 'ALL'}`
                        : '-'}
                    </span>
                  </div>
                  <div className="info-cell">
                    <span className="info-label">허용 결재 채널</span>
                    <span className="info-val">
                      {getApprovalChannels(selectedTask)}
                    </span>
                  </div>
                  {selectedTask.completed_via && (
                    <div className="info-cell">
                      <span className="info-label">실제 처리 채널</span>
                      <span className="info-val">
                        {selectedTask.completed_via === 'external_email'
                          ? '이메일 링크'
                          : 'PXM 웹'}
                        {selectedTask.authentication_method
                          ? ` · ${selectedTask.authentication_method}`
                          : ''}
                      </span>
                    </div>
                  )}
                  <div className="info-cell">
                    <span className="info-label">결재 내용</span>
                    <span className="info-val text-box-reason">
                      {String(
                        selectedTask.content_snapshot?.summary ||
                          selectedTask.form_data?.approval_request?.content?.summary ||
                          readField(selectedTask, ['요청 사유', 'purpose', 'reason', 'message']),
                      )}
                    </span>
                  </div>
                </div>
              </div>

              <div className="info-block">
                <h5>전체 결재라인</h5>
                <div className="vertical-info-list">
                  {(selectedTask.approval_line_snapshot?.steps || []).map((step) => (
                    <div className="info-cell" key={step.order}>
                      <span className="info-label">
                        {step.order}단계 · {step.label || '결재'} · {step.mode || 'ALL'}
                      </span>
                      <span className="info-val">
                        {(step.approvers || [])
                          .map((approver) => approver.display_snapshot?.name || approver.assignee || '-')
                          .join(', ')}
                      </span>
                    </div>
                  ))}
                  {!selectedTask.approval_line_snapshot?.steps?.length && (
                    <div className="info-cell">
                      <span className="info-val">저장된 동적 결재라인이 없습니다.</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="info-block">
                <h5>첨부 파일</h5>
                <div className="file-attachment-list">
                  <div className="file-item empty-file-item">
                    <FileText size={14} className="file-icon" />
                    <span className="file-name">첨부 파일이 없습니다.</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {selectedTask.status === 'OPEN' && (
          <div className="inbox-section-compact detail-action-section">
            <div className="section-title-wrap">
              <h3>승인 의사결정</h3>
              <span className="subtitle-desc">검토 결과를 선택하고 처리합니다.</span>
            </div>

            <div className="action-card-body">
              <div className="decision-btn-group">
                <button
                  data-testid="decision-approve"
                  className={`decision-btn btn-approve ${decision === 'approve' ? 'selected' : ''}`}
                  onClick={() => {
                    setDecision('approve');
                    setComment('요청 내용을 확인하였습니다. 승인합니다.');
                  }}
                >
                  <div className="circle-icon green"><Check size={18} /></div>
                  <span>승인</span>
                </button>
                <button
                  data-testid="decision-reject"
                  className={`decision-btn btn-reject ${decision === 'reject' ? 'selected' : ''}`}
                  onClick={() => {
                    setDecision('reject');
                    setComment('검토 결과 반려합니다.');
                  }}
                >
                  <div className="circle-icon red"><X size={18} /></div>
                  <span>반려</span>
                </button>
                <button
                  className={`decision-btn btn-hold ${decision === 'hold' ? 'selected' : ''}`}
                  onClick={() => {
                    setDecision('hold');
                    setComment('추가 확인이 필요하여 보류합니다.');
                  }}
                >
                  <div className="circle-icon grey"><Pause size={18} /></div>
                  <span>보류</span>
                </button>
              </div>

              <div className="comment-area-wrap">
                <textarea
                  className="form-textarea-comment"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="처리 의견을 작성해주세요."
                  maxLength={500}
                />
                <span className="char-counter">{comment.length} / 500</span>
              </div>

              {decision === 'reject' && (
                <div className="checkbox-wrap">
                  <input
                    type="checkbox"
                    id="chk-reject-reason"
                    checked={rejectReasonChecked}
                    onChange={(e) => setRejectReasonChecked(e.target.checked)}
                  />
                  <label htmlFor="chk-reject-reason" className="checkbox-lbl text-red-urgent">
                    반려 사유를 확인했습니다.
                  </label>
                </div>
              )}

              <div className="decision-actions">
                <Button
                  variant="secondary"
                  onClick={() => {
                    setComment('요청 내용을 확인하였습니다. 승인합니다.');
                    setDecision('approve');
                    setRejectReasonChecked(false);
                  }}
                >
                  초기화
                </Button>
                <div style={{ flex: 1, display: 'flex' }}>
                  <Button
                    variant={decision === 'reject' ? 'danger' : 'primary'}
                    onClick={handleProcessDecision}
                    disabled={decision === 'reject' && !rejectReasonChecked}
                  >
                    {decision === 'approve' ? '승인 완료하기' : decision === 'reject' ? '반려 처리하기' : '보류 적용하기'}
                  </Button>
                </div>
              </div>
            </div>
          </div>
          )}
        </div>

        <div className="inbox-section timeline-history-section">
          <div className="section-title-wrap">
            <h3>결재 처리 이력</h3>
            <span className="subtitle-desc">현재 요청의 진행 상태를 확인합니다.</span>
          </div>

          <div className="timeline-flow-body">
            <div className="horizontal-timeline">
              <div className="t-node active">
                <div className="t-node-dot">1</div>
                <span className="t-node-name">인스턴스 시작</span>
              </div>
              <div className="t-line active" />
              <div className={`t-node ${selectedTask.status === 'OPEN' ? 'processing' : 'active'}`}>
                <div className="t-node-dot">2</div>
                <span className="t-node-name">승인 대기</span>
              </div>
              <div className="t-line" />
              <div className="t-node">
                <div className="t-node-dot">3</div>
                <span className="t-node-name">후속 노드 진행</span>
              </div>
            </div>

            <div className="timeline-vertical-logs">
              {(instanceHistory.length ? instanceHistory : [selectedTask]).map((history) => (
                <div className="v-log-item blue" key={history.id}>
                  <div className="v-log-time">
                    {formatDateTime(history.completed_at || history.created_at)}
                  </div>
                  <div className="v-log-content">
                    <div className="v-log-header">
                      <span className="v-log-actor">{history.assignee || getRequester(selectedTask)}</span>
                      <span className="v-log-badge blue">
                        {history.step_order ? `${history.step_order}단계 · ` : ''}
                        {history.status}
                      </span>
                    </div>
                    <p className="v-log-comment">
                      {history.comment ||
                        (history.status === 'OPEN'
                          ? `${history.node_id} 노드에서 승인을 기다리고 있습니다.`
                          : `${history.node_id} 노드에서 ${history.status} 처리되었습니다.`)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="inbox-dashboard-layout">
      {screen === 'list' ? renderList() : renderDetail()}
    </div>
  );
};
