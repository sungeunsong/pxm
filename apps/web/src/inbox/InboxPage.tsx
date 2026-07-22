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
  form_data?: Record<string, any>;
  created_at: string;
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
    return (
      task.template_name ||
      readField(task, ['요청 프로세스', 'processName', 'title', 'requestTitle'], '') ||
      task.node_id ||
      '승인 요청'
    );
  };

  const getRequester = (task: Task | null) =>
    readField(task, ['신청자', 'requester', 'requesterName', 'applicant'], task?.assignee || '-');

  const getProcessLabel = (task: Task | null) =>
    task?.template_name || readField(task, ['요청 프로세스', 'processName'], task?.process_definition_id || '-');

  const fetchTasks = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/tasks');
      if (!res.ok) throw new Error('Failed to fetch tasks');
      setTasks(await res.json());
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
    if (activeSubTab !== 'pending') return [];
    const q = searchTerm.trim().toLowerCase();
    if (!q) return tasks;
    return tasks.filter((task) =>
      [getTaskTitle(task), getRequester(task), task.instance_id, task.node_id]
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [activeSubTab, searchTerm, tasks]);

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

  const openTask = (task: Task) => {
    setSelectedTask(task);
    setDecision('approve');
    setComment('요청 내용을 확인하였습니다. 승인합니다.');
    setRejectReasonChecked(false);
    setScreen('detail');
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
          승인 대기 <span className="tab-count badge-pending">{tasks.length}</span>
        </button>
        <button
          className={`sub-tab-btn ${activeSubTab === 'completed' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('completed')}
        >
          처리 완료 <span className="tab-count badge-completed">0</span>
        </button>
        <button
          className={`sub-tab-btn ${activeSubTab === 'rejected' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('rejected')}
        >
          반려함 <span className="tab-count badge-rejected">0</span>
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
              <tr key={task.id} className="task-row-item" onClick={() => openTask(task)}>
                <td>
                  <div className="req-name-cell">
                    <span className="req-tag">{task.node_id}</span>
                    {getTaskTitle(task)}
                  </div>
                </td>
                <td>{getRequester(task)}</td>
                <td>{formatDate(task.created_at)}</td>
                <td>{task.node_id}</td>
                <td><span className="status-badge-outline pending">승인 대기</span></td>
              </tr>
            ))}

            {visibleTasks.length === 0 && (
              <tr>
                <td colSpan={5} className="table-empty-cell">
                  {activeSubTab === 'pending'
                    ? '승인 대기 작업이 없습니다.'
                    : '이 탭은 아직 실제 이력 API가 연결되지 않았습니다.'}
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
          <span className="status-badge-full orange">승인 대기</span>
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
                    <span className="info-label">요청 시스템</span>
                    <span className="info-val">{readField(selectedTask, ['요청 시스템', 'system', 'targetSystem'])}</span>
                  </div>
                  <div className="info-cell">
                    <span className="info-label">요청 권한</span>
                    <span className="info-val highlighting-blue">
                      {readField(selectedTask, ['요청 권한', 'permission', 'permissionScope'])}
                    </span>
                  </div>
                  <div className="info-cell">
                    <span className="info-label">요청 사유</span>
                    <span className="info-val text-box-reason">
                      {readField(selectedTask, ['요청 사유', 'purpose', 'reason', 'message'])}
                    </span>
                  </div>
                </div>
              </div>

              <div className="info-block">
                <h5>대상 시스템</h5>
                <div className="grid-info-2col">
                  <div className="info-cell">
                    <span className="info-label">시스템명</span>
                    <span className="info-val">{readField(selectedTask, ['시스템명', 'systemName', 'targetSystem'])}</span>
                  </div>
                  <div className="info-cell">
                    <span className="info-label">접속 정보</span>
                    <span className="info-val font-mono-style">{readField(selectedTask, ['접속 정보', 'connectionInfo'])}</span>
                  </div>
                  <div className="info-cell">
                    <span className="info-label">시스템 구분</span>
                    <span className="info-val">{readField(selectedTask, ['시스템 구분', 'systemType'])}</span>
                  </div>
                  <div className="info-cell">
                    <span className="info-label">운영 환경</span>
                    <span className="info-val highlighting-green">{readField(selectedTask, ['운영 환경', 'environment'])}</span>
                  </div>
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

          <div className="inbox-section-compact detail-action-section">
            <div className="section-title-wrap">
              <h3>승인 의사결정</h3>
              <span className="subtitle-desc">검토 결과를 선택하고 처리합니다.</span>
            </div>

            <div className="action-card-body">
              <div className="decision-btn-group">
                <button
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
              <div className="t-node processing">
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
              <div className="v-log-item blue">
                <div className="v-log-time">{formatDateTime(selectedTask.created_at)} (현재)</div>
                <div className="v-log-content">
                  <div className="v-log-header">
                    <span className="v-log-actor">{getRequester(selectedTask)}</span>
                    <span className="v-log-badge blue">진행 중</span>
                  </div>
                  <p className="v-log-comment">
                    {selectedTask.node_id} 노드에서 승인 처리를 기다리고 있습니다.
                  </p>
                </div>
              </div>
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
