import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Check,
  FileText,
  Pause,
  RotateCcw,
  Search as SearchIcon,
  UserRoundCog,
  X,
} from 'lucide-react';
import { Button } from '../components/Button';
import { useFeedback } from '../components/feedback/feedback-context';
import { errorMessage } from '../lib/error-message';
import './InboxPage.css';
import type { SessionUser } from '../api/session';
import { ApprovalDelegationDrawer } from './ApprovalDelegationDrawer';

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
  form_fields?: Array<{ id: string; label: string; type: string }>;
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
  hold?: {
    actor_id: string;
    comment: string | null;
    held_at: string;
  } | null;
  completed_at?: string | null;
  completion_actor_id?: string | null;
  delegation?: { id?: string; delegation_id?: string; original_assignee: string; delegate_id?: string; delegated_until?: string } | null;
  reassignment_history?: Array<{ from: string; to: string; reason?: string | null; reassigned_at: string }>;
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
  currentUser: SessionUser;
}

// 아래 4개는 task 인자에만 의존하는 순수 함수다.
// 컴포넌트 안에 두면 렌더마다 새 참조가 생겨 useMemo 의존성이 계속 바뀐다.
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

const getApprovalDeadline = (task: Task | null) => {
  const seconds = Number(task?.payload?.approval_deadline?.deadline_seconds);
  if (!task?.created_at || !Number.isFinite(seconds) || seconds <= 0) return null;
  const dueAt = new Date(new Date(task.created_at).getTime() + seconds * 1000);
  return { dueAt, overdue: task.status === 'OPEN' && dueAt.getTime() <= Date.now() };
};

// 결재자에게 보이는 상태·방식은 내부 코드값이 아니라 업무 용어로 쓴다 (docs/ui-terminology.md).
const getStatusLabel = (task: Task) => {
  if (task.status === 'OPEN') return task.hold || task.payload?.hold ? '보류' : '승인 대기';
  if (task.status === 'APPROVED') return '승인 완료';
  if (task.status === 'REJECTED') return '반려';
  if (task.status === 'CANCELED') return '취소';
  return task.status;
};

const getStepModeLabel = (mode?: string | null) => (mode === 'ANY' ? '1인 승인' : '전원 승인');

const getStepProgress = (task: Task | null) =>
  task?.current_step_order && task.total_steps ? `${task.current_step_order} / ${task.total_steps}단계` : null;

const formatInputValue = (value: unknown) => {
  if (typeof value === 'boolean') return value ? '예' : '아니오';
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

const isEmptyValue = (value: unknown) => value === undefined || value === null || String(value).trim() === '';

// 요약·제목·신청자처럼 이미 다른 자리에 보이는 값과 결재선 원본은 입력 목록에서 뺀다.
const NON_INPUT_KEYS = new Set(['approval_request', 'title', 'summary', 'requester']);

const getRequestInputs = (task: Task): Array<{ label: string; value: string }> => {
  const data = task.form_data || {};
  const entries = task.form_fields?.length
    ? task.form_fields.map((field) => ({ label: field.label, value: data[field.id] }))
    : Object.entries(data)
        .filter(([key]) => !NON_INPUT_KEYS.has(key))
        .map(([key, value]) => ({ label: key, value }));
  return entries
    .filter((entry) => !isEmptyValue(entry.value))
    .map((entry) => ({ label: entry.label, value: formatInputValue(entry.value) }));
};

const getRequestSummary = (task: Task) => {
  const summary =
    task.content_snapshot?.summary ||
    task.form_data?.approval_request?.content?.summary ||
    readField(task, ['요청 사유', 'purpose', 'reason', 'message'], '');
  return summary ? String(summary) : '';
};

export const InboxPage: React.FC<InboxPageProps> = ({ currentUser }) => {
  const { toast, confirm: confirmDialog } = useFeedback();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeSubTab, setActiveSubTab] = useState<'pending' | 'completed' | 'rejected'>('pending');
  const [searchTerm, setSearchTerm] = useState('');
  const [processFilter, setProcessFilter] = useState('');
  const [screen, setScreen] = useState<'list' | 'detail'>('list');
  const [decision, setDecision] = useState<'approve' | 'reject' | 'hold'>('approve');
  const [comment, setComment] = useState('요청 내용을 확인하였습니다. 승인합니다.');
  const [rejectReasonChecked, setRejectReasonChecked] = useState(false);
  const [instanceHistory, setInstanceHistory] = useState<Task[]>([]);
  const [delegationOpen, setDelegationOpen] = useState(false);

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
    const byProcess = processFilter
      ? byTab.filter((task) => getProcessLabel(task) === processFilter)
      : byTab;
    const q = searchTerm.trim().toLowerCase();
    if (!q) return byProcess;
    return byProcess.filter((task) =>
      [getTaskTitle(task), getRequester(task), task.instance_id]
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [activeSubTab, processFilter, searchTerm, tasks]);

  // 필터 목록은 실제 결재함에 존재하는 프로세스에서만 만든다.
  const processOptions = useMemo(
    () => Array.from(new Set(tasks.map((task) => getProcessLabel(task)).filter((label) => label && label !== '-'))).sort(),
    [tasks],
  );
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

    const proceed = await confirmDialog({
      title: `이 요청을 ${displayActionText} 처리할까요?`,
      description: comment.trim() ? `의견: ${comment}` : '남긴 의견이 없습니다.',
      confirmLabel: displayActionText,
      tone: decision === 'reject' ? 'danger' : 'default',
    });
    if (!proceed) return;

    try {
      const endpoint = decision === 'hold'
        ? `/api/tasks/${selectedTask.id}/hold`
        : `/api/tasks/${selectedTask.id}/complete`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: decision === 'hold'
          ? { 'Content-Type': 'application/json' }
          : { 'Content-Type': 'application/json', 'Idempotency-Key': `inbox:${selectedTask.id}:${action}` },
        body: JSON.stringify(decision === 'hold' ? { comment } : { action, comment }),
      });

      if (!res.ok) throw new Error('Failed to complete task');

      toast.success(`${displayActionText} 처리했습니다.`);
      await fetchTasks();
      setSelectedTask(null);
      setScreen('list');
    } catch (error) {
      console.error('Failed to process task:', error);
      toast.error(`${displayActionText} 처리에 실패했습니다.`, { description: errorMessage(error) });
    }
  };

  const renderList = () => (
    <div className="inbox-list-page">
      <div className="inbox-list-header">
        <div>
          <p>승인 대기 중인 작업을 확인하고 상세 화면에서 처리합니다.</p>
        </div>
        <div className="inbox-list-actions">
          <Button variant="secondary" size="sm" icon={<UserRoundCog size={15} />} onClick={() => setDelegationOpen(true)}>대리 결재 설정</Button>
          <button className="icon-action-btn" onClick={fetchTasks} title="새로고침"><RotateCcw size={14} /></button>
        </div>
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
          <select
            className="form-select-sm"
            value={processFilter}
            onChange={(event) => setProcessFilter(event.target.value)}
            aria-label="업무 양식 필터"
          >
            <option value="">전체 업무 양식</option>
            {processOptions.map((label) => (
              <option key={label} value={label}>{label}</option>
            ))}
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
        {loading && <span className="loading-text">loading...</span>}
      </div>

      <div className="table-container">
        <table className="inbox-table">
          <thead>
            <tr>
              <th>요청명</th>
              <th>신청자</th>
              <th>요청일</th>
              <th>결재 단계</th>
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
                  <div className="req-name-cell">{getTaskTitle(task)}</div>
                </td>
                <td>{getRequester(task)}</td>
                <td>{formatDate(task.created_at)}</td>
                <td>{getStepProgress(task) || '-'}</td>
                <td>
                  <span className={`status-badge-outline ${task.status.toLowerCase()}`}>
                    {getStatusLabel(task)}
                  </span>
                  {task.delegation && <span className="delegated-task-badge">대리 결재</span>}
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

    const deadline = getApprovalDeadline(selectedTask);
    const stepProgress = getStepProgress(selectedTask);
    const requestSummary = getRequestSummary(selectedTask);
    const requestInputs = getRequestInputs(selectedTask);
    return (
      <div className="inbox-detail-page">
        <div className="inbox-detail-header">
          <button className="back-to-list-btn" onClick={() => setScreen('list')}>
            <ArrowLeft size={15} />
            목록으로
          </button>
          <div>
            <h2>{getTaskTitle(selectedTask)}</h2>
            <p>{getProcessLabel(selectedTask)}</p>
          </div>
          <span className={`status-badge-full ${selectedTask.status === 'OPEN' ? 'orange' : ''}`}>
            {getStatusLabel(selectedTask)}
          </span>
        </div>

        <div className="detail-action-card">
          <div className="inbox-section-compact detail-info-section">
            <div className="section-title-wrap">
              <h3>결재 상세</h3>
              <span className="subtitle-desc">요청 내용을 검토합니다.</span>
            </div>

            <div className="details-card-body">
              <div className="info-block" data-testid="approval-request-content">
                <h5>요청 내용</h5>
                {requestSummary && <p className="text-box-reason">{requestSummary}</p>}
                {requestInputs.length > 0 ? (
                  <div className="vertical-info-list">
                    {requestInputs.map((input) => (
                      <div className="info-cell" key={input.label}>
                        <span className="info-label">{input.label}</span>
                        <span className="info-val">{input.value}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  !requestSummary && <p className="inbox-empty-note">신청자가 입력한 내용이 없습니다.</p>
                )}
              </div>

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
                    <span className="info-label">업무 양식</span>
                    <span className="info-val">{getProcessLabel(selectedTask)}</span>
                  </div>
                  {deadline && (
                    <div className="info-cell">
                      <span className="info-label">처리 기한</span>
                      <span className={`info-val ${deadline.overdue ? 'approval-deadline-overdue' : ''}`}>
                        {formatDateTime(deadline.dueAt.toISOString())}{deadline.overdue ? ' · 기한 초과' : ''}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              <div className="info-block">
                <h5>결재 진행</h5>
                <div className="vertical-info-list">
                  {stepProgress && (
                    <div className="info-cell">
                      <span className="info-label">현재 결재 단계</span>
                      <span className="info-val highlighting-blue">
                        {stepProgress} · {getStepModeLabel(selectedTask.step_mode)}
                      </span>
                    </div>
                  )}
                  {(selectedTask.approval_line_snapshot?.steps || []).map((step) => (
                    <div className="info-cell" key={step.order}>
                      <span className="info-label">
                        {step.order}단계 · {step.label || '결재'} · {getStepModeLabel(step.mode)}
                      </span>
                      <span className="info-val">
                        {(step.approvers || [])
                          .map((approver) => approver.display_snapshot?.name || approver.assignee || '-')
                          .join(', ')}
                      </span>
                    </div>
                  ))}
                  {selectedTask.delegation && (
                    <div className="info-cell">
                      <span className="info-label">대리 결재</span>
                      <span className="info-val">원래 승인자 {selectedTask.delegation.original_assignee}{selectedTask.completion_actor_id ? ` · 실제 처리자 ${selectedTask.completion_actor_id}` : selectedTask.delegation.delegated_until ? ` · ${formatDateTime(selectedTask.delegation.delegated_until)}까지` : ''}</span>
                    </div>
                  )}
                  {!!selectedTask.reassignment_history?.length && (
                    <div className="info-cell"><span className="info-label">담당자 재배정</span><span className="info-val">{selectedTask.reassignment_history.map((item) => `${item.from} → ${item.to}${item.reason ? ` (${item.reason})` : ''}`).join(', ')}</span></div>
                  )}
                  {!stepProgress && !selectedTask.approval_line_snapshot?.steps?.length && (
                    <div className="info-cell">
                      <span className="info-val">단일 결재입니다.</span>
                    </div>
                  )}
                </div>
              </div>

              <details className="inbox-tech-details">
                <summary>기술 정보</summary>
                <div className="vertical-info-list">
                  <div className="info-cell">
                    <span className="info-label">요청 ID</span>
                    <span className="info-val font-mono-style">{selectedTask.instance_id}</span>
                  </div>
                  <div className="info-cell">
                    <span className="info-label">결재 노드</span>
                    <span className="info-val font-mono-style">{selectedTask.node_id}</span>
                  </div>
                  {selectedTask.source_provider && selectedTask.external_request_id && (
                    <div className="info-cell">
                      <span className="info-label">외부 요청 키</span>
                      <span className="info-val font-mono-style">
                        {`${selectedTask.source_provider}:${selectedTask.external_request_id}:r${selectedTask.external_revision || 1}`}
                      </span>
                    </div>
                  )}
                  <div className="info-cell">
                    <span className="info-label">허용 결재 채널</span>
                    <span className="info-val">{getApprovalChannels(selectedTask)}</span>
                  </div>
                  {selectedTask.completed_via && (
                    <div className="info-cell">
                      <span className="info-label">실제 처리 채널</span>
                      <span className="info-val">
                        {selectedTask.completed_via === 'external_email' ? '이메일 링크' : 'PXM 웹'}
                        {selectedTask.authentication_method ? ` · ${selectedTask.authentication_method}` : ''}
                      </span>
                    </div>
                  )}
                </div>
              </details>
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
                  data-testid="decision-hold"
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
            <span className="subtitle-desc">이 요청에서 누가 언제 무엇을 처리했는지 확인합니다.</span>
          </div>

          <div className="timeline-flow-body">
            <div className="timeline-vertical-logs">
              {(instanceHistory.length ? instanceHistory : [selectedTask]).map((history) => (
                <div className="v-log-item blue" key={history.id}>
                  <div className="v-log-time">
                    {formatDateTime(history.completed_at || history.hold?.held_at || history.created_at)}
                  </div>
                  <div className="v-log-content">
                    <div className="v-log-header">
                      <span className="v-log-actor">{history.completion_actor_id || history.assignee || getRequester(selectedTask)}</span>
                      <span className="v-log-badge blue">
                        {history.step_order ? `${history.step_order}단계 · ` : ''}
                        {getStatusLabel(history)}
                      </span>
                    </div>
                    <p className="v-log-comment">
                      {history.comment || history.hold?.comment || history.payload?.hold?.comment ||
                        (history.status === 'OPEN' ? '승인을 기다리고 있습니다.' : `${getStatusLabel(history)} 처리되었습니다.`)}
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
      {delegationOpen && <ApprovalDelegationDrawer currentUser={currentUser} onClose={() => setDelegationOpen(false)} />}
    </div>
  );
};
