import React, { useEffect, useState } from 'react';
import { 
  Check, 
  X, 
  Pause, 
  RotateCcw, 
  Search as SearchIcon, 
  Filter, 
  Download, 
  FileText, 
  Smartphone
} from 'lucide-react';
import { Button } from '../components/Button';
import './InboxPage.css';

interface Task {
  id: string;
  instance_id: string;
  node_id: string;
  status: string;
  form_data: Record<string, any>;
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
  
  // 의사 결정/처리 선택 상태
  const [decision, setDecision] = useState<'approve' | 'reject' | 'hold'>('approve');
  const [comment, setComment] = useState('요청 내용을 확인하였습니다. 승인합니다.');
  const [rejectReasonChecked, setRejectReasonChecked] = useState(false);

  // 실시간 폴링 및 Task 갱신
  const fetchTasks = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/tasks?assignee=admin');
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      setTasks(data);
      
      // 첫 번째 Task 자동 선택
      if (data.length > 0 && !selectedTask) {
        setSelectedTask(data[0]);
      }
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

  // 처리 제출
  const handleProcessDecision = async () => {
    if (!selectedTask) return;
    
    const action = decision === 'hold' ? 'approve' : (decision === 'reject' ? 'reject' : 'approve');
    const displayActionText = decision === 'approve' ? '승인' : decision === 'reject' ? '반려' : '보류';

    try {
      if (!confirm(`선택한 문서를 [${displayActionText}] 처리하시겠습니까?\n의견: ${comment}`)) return;

      const res = await fetch(`/api/tasks/${selectedTask.id}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          action,
          comment: comment 
        }),
      });

      if (res.ok) {
        alert(`성공적으로 [${displayActionText}] 처리되었습니다.`);
        setSelectedTask(null);
        fetchTasks();
      } else {
        alert('처리 중 오류가 발생했습니다.');
      }
    } catch (error) {
      console.error('Failed to process task:', error);
    }
  };

  // 대기 중인 Task가 없을 때 보여줄 프리미엄 목 데이터 생성
  const dummyTask: Task = {
    id: "dummy-req-20250520",
    instance_id: "REQ-20250520-0001",
    node_id: "approval_node_final",
    status: "WAITING",
    form_data: {
      "신청자": "이철훈 사원 (IT운영팀)",
      "신청일시": "2025-05-20 10:15",
      "요청 프로세스": "권한 신청 프로세스 v1.3",
      "요청 ID": "REQ-20250520-0001",
      "요청 시스템": "ERP DB (ERP-PROD)",
      "요청 권한": "SELECT, INSERT, UPDATE (읽기/쓰기)",
      "요청 사유": "월간 리포트 생성 및 데이터 분석을 위한 접근 권한이 필요합니다.",
      "시스템명": "ERP DB (ERP-PROD)",
      "접속 정보": "172.16.10.25:1521 / erpprod",
      "시스템 구분": "데이터베이스",
      "운영 환경": "운영 (PROD)"
    },
    created_at: "2026-05-22T01:15:00.000Z"
  };

  const currentActiveTask = selectedTask || (tasks.length > 0 ? tasks[0] : dummyTask);

  return (
    <div className="inbox-dashboard-layout">
      {/* 본문 5개 대시보드 영역 분할 */}
      <div className="inbox-grid">
        
        {/* ================= SECTION 1: 내 결재함 ================= */}
        <section className="inbox-section section-inbox-list">
          <div className="section-title-wrap">
            <span className="section-num">1</span>
            <h3>내 결재함</h3>
            <span className="subtitle-desc">승인해야 할 요청을 상태별로 확인하고 빠르게 처리합니다.</span>
          </div>

          {/* 서브 탭 분류 */}
          <div className="sub-tabs">
            <button 
              className={`sub-tab-btn ${activeSubTab === 'pending' ? 'active' : ''}`}
              onClick={() => setActiveSubTab('pending')}
            >
              승인 대기 <span className="tab-count badge-pending">{tasks.length > 0 ? tasks.length : 1}</span>
            </button>
            <button 
              className={`sub-tab-btn ${activeSubTab === 'completed' ? 'active' : ''}`}
              onClick={() => setActiveSubTab('completed')}
            >
              처리 완료 <span className="tab-count badge-completed">128</span>
            </button>
            <button 
              className={`sub-tab-btn ${activeSubTab === 'rejected' ? 'active' : ''}`}
              onClick={() => setActiveSubTab('rejected')}
            >
              반려함 <span className="tab-count badge-rejected">5</span>
            </button>
          </div>

          {/* 검색 및 필터 헤더 */}
          <div className="search-filter-bar">
            <div className="select-wrapper">
              <select className="form-select-sm">
                <option>전체 프로세스</option>
                <option>권한 신청 프로세스</option>
                <option>계정 생성 프로세스</option>
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
            <button className="icon-action-btn"><Filter size={13} /></button>
            <button className="icon-action-btn" onClick={fetchTasks} title="새로고침">
              <RotateCcw size={13} />
            </button>
            {loading && <span style={{ fontSize: '11px', color: '#3b82f6', marginLeft: '4px' }}>loading...</span>}
          </div>

          {/* 결재 문서 목록 테이블 */}
          <div className="table-container">
            <table className="inbox-table">
              <thead>
                <tr>
                  <th>요청명</th>
                  <th>신청자</th>
                  <th>요청일</th>
                  <th>우선순위</th>
                  <th>상태</th>
                </tr>
              </thead>
              <tbody>
                {/* 실데이터 렌더링 */}
                {tasks.map(task => (
                  <tr 
                    key={task.id} 
                    className={`task-row-item ${currentActiveTask.id === task.id ? 'selected' : ''}`}
                    onClick={() => setSelectedTask(task)}
                  >
                    <td>
                      <div className="req-name-cell">
                        <span className="req-tag">DB</span> 
                        {task.form_data?.["요청 프로세스"] || "DB 권한 신청"}
                      </div>
                    </td>
                    <td>{task.form_data?.["신청자"]?.split(" ")[0] || "이철훈"}</td>
                    <td>{new Date(task.created_at).toLocaleDateString()}</td>
                    <td><span className="priority-badge high">높음</span></td>
                    <td><span className="status-badge-outline pending">승인 대기</span></td>
                  </tr>
                ))}

                {/* 묵데이터 렌더링 (실데이터와 조화) */}
                <tr 
                  className={`task-row-item ${currentActiveTask.id === dummyTask.id ? 'selected' : ''}`}
                  onClick={() => setSelectedTask(dummyTask)}
                >
                  <td>
                    <div className="req-name-cell">
                      <span className="req-tag">DB</span> DB 권한 신청
                    </div>
                  </td>
                  <td>이철훈</td>
                  <td>2025-05-20</td>
                  <td><span className="priority-badge high">높음</span></td>
                  <td><span className="status-badge-outline pending">승인 대기</span></td>
                </tr>

                <tr className="task-row-item opacity-75">
                  <td>
                    <div className="req-name-cell">
                      <span className="req-tag tag-sys">SYS</span> 서버 계정 생성 요청
                    </div>
                  </td>
                  <td>박지은</td>
                  <td>2025-05-20</td>
                  <td><span className="priority-badge normal">보통</span></td>
                  <td><span className="status-badge-outline pending">승인 대기</span></td>
                </tr>

                <tr className="task-row-item opacity-75">
                  <td>
                    <div className="req-name-cell">
                      <span className="req-tag tag-api">API</span> 시스템 접근 권한 요청
                    </div>
                  </td>
                  <td>최인수</td>
                  <td>2025-05-20</td>
                  <td><span className="priority-badge low">낮음</span></td>
                  <td><span className="status-badge-outline pending">승인 대기</span></td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="pagination-bar">
            <span>전체 15건</span>
            <div className="pagination-arrows">
              <button disabled>&lt;</button>
              <button className="active">1</button>
              <button>2</button>
              <button>3</button>
              <button>&gt;</button>
            </div>
            <select className="form-select-sm limit-select">
              <option>5개씩 보기</option>
              <option>10개씩 보기</option>
            </select>
          </div>
        </section>

        {/* ================= SECTION 2: 결재 상세 ================= */}
        <section className="inbox-section section-inbox-details">
          <div className="section-title-wrap">
            <span className="section-num">2</span>
            <h3>결재 상세</h3>
            <span className="subtitle-desc">요청 내용을 상세히 확인하고 이전 승인 이력까지 한눈에 볼 수 있습니다.</span>
          </div>

          <div className="details-card-body">
            <div className="details-header-title">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <h4>{currentActiveTask.form_data?.["요청 프로세스"] || "DB 권한 신청"}</h4>
                {onSwitchToDesigner && (
                  <button 
                    onClick={onSwitchToDesigner}
                    style={{ 
                      background: 'none', 
                      border: 'none', 
                      color: '#2563eb', 
                      fontSize: '11.5px', 
                      cursor: 'pointer', 
                      textAlign: 'left',
                      padding: 0,
                      fontWeight: 'bold',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px'
                    }}
                  >
                    🎨 Flow Designer에서 템플릿 보기 &gt;
                  </button>
                )}
              </div>
              <span className="status-badge-full orange">승인 대기</span>
            </div>

            {/* 신청 정보 */}
            <div className="info-block">
              <h5>신청 정보</h5>
              <div className="grid-info-2col">
                <div className="info-cell">
                  <span className="info-label">신청자</span>
                  <span className="info-val">{currentActiveTask.form_data?.["신청자"] || "이철훈 사원 (IT운영팀)"}</span>
                </div>
                <div className="info-cell">
                  <span className="info-label">신청일시</span>
                  <span className="info-val">{currentActiveTask.form_data?.["신청일시"] || "2025-05-20 10:15"}</span>
                </div>
                <div className="info-cell">
                  <span className="info-label">프로세스</span>
                  <span className="info-val">{currentActiveTask.form_data?.["요청 프로세스"] || "권한 신청 프로세스 v1.3"}</span>
                </div>
                <div className="info-cell">
                  <span className="info-label">요청 ID</span>
                  <span className="info-val" style={{ fontFamily: 'monospace', fontWeight: 'bold' }}>
                    {currentActiveTask.instance_id || "REQ-20250520-0001"}
                  </span>
                </div>
              </div>
            </div>

            {/* 요청 내용 */}
            <div className="info-block">
              <h5>요청 내용</h5>
              <div className="vertical-info-list">
                <div className="info-cell">
                  <span className="info-label">요청 시스템</span>
                  <span className="info-val">{currentActiveTask.form_data?.["요청 시스템"] || "ERP DB (ERP-PROD)"}</span>
                </div>
                <div className="info-cell">
                  <span className="info-label">요청 권한</span>
                  <span className="info-val highlighting-blue">{currentActiveTask.form_data?.["요청 권한"] || "SELECT, INSERT, UPDATE"}</span>
                </div>
                <div className="info-cell">
                  <span className="info-label">요청 사유</span>
                  <span className="info-val text-box-reason">
                    {currentActiveTask.form_data?.["요청 사유"] || "월간 리포트 생성 및 데이터 분석을 위한 접근 권한이 필요합니다."}
                  </span>
                </div>
              </div>
            </div>

            {/* 대상 시스템 */}
            <div className="info-block">
              <h5>대상 시스템</h5>
              <div className="grid-info-2col">
                <div className="info-cell">
                  <span className="info-label">시스템명</span>
                  <span className="info-val">{currentActiveTask.form_data?.["시스템명"] || "ERP DB (ERP-PROD)"}</span>
                </div>
                <div className="info-cell">
                  <span className="info-label">접속 정보</span>
                  <span className="info-val font-mono-style">{currentActiveTask.form_data?.["접속 정보"] || "172.16.10.25:1521 / erpprod"}</span>
                </div>
                <div className="info-cell">
                  <span className="info-label">시스템 구분</span>
                  <span className="info-val">{currentActiveTask.form_data?.["시스템 구분"] || "데이터베이스"}</span>
                </div>
                <div className="info-cell">
                  <span className="info-label">운영 환경</span>
                  <span className="info-val highlighting-green">{currentActiveTask.form_data?.["운영 환경"] || "운영 (PROD)"}</span>
                </div>
              </div>
            </div>

            {/* 첨부 파일 */}
            <div className="info-block">
              <h5>첨부 파일</h5>
              <div className="file-attachment-list">
                <div className="file-item">
                  <FileText size={14} className="file-icon" />
                  <span className="file-name">요청서_이철훈.pdf (225 KB)</span>
                  <button className="btn-icon-download"><Download size={12} /></button>
                </div>
                <div className="file-item">
                  <FileText size={14} className="file-icon" />
                  <span className="file-name">쿼리_리스트.xlsx (48 KB)</span>
                  <button className="btn-icon-download"><Download size={12} /></button>
                </div>
              </div>
            </div>

            {/* 이전 승인 이력 */}
            <div className="info-block">
              <h5>이전 승인 이력</h5>
              <div className="inner-history-steps">
                <div className="history-step-row done">
                  <div className="h-step-marker">✓</div>
                  <div className="h-step-desc">
                    <span className="step-num-text">1단계 : 팀장 승인</span>
                    <span className="step-actor">박지은 팀장 (IT운영팀)</span>
                  </div>
                  <span className="step-status green">승인</span>
                  <span className="step-time">2025-05-20 09:50</span>
                </div>

                <div className="history-step-row done">
                  <div className="h-step-marker">✓</div>
                  <div className="h-step-desc">
                    <span className="step-num-text">2단계 : 보안 검토</span>
                    <span className="step-actor">최한수 과장 (보안팀)</span>
                  </div>
                  <span className="step-status green">승인</span>
                  <span className="step-time">2025-05-20 10:00</span>
                </div>

                <div className="history-step-row active">
                  <div className="h-step-marker pulse">●</div>
                  <div className="h-step-desc">
                    <span className="step-num-text">3단계 : 최종 승인 (현재 단계)</span>
                    <span className="step-actor">김결재 부장 (경영지원본부)</span>
                  </div>
                  <span className="step-status blue">진행 중</span>
                  <span className="step-time">-</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 오른쪽 영역 (3, 4, 5섹션을 세로 및 가로 배치 가능하게 구성) */}
        <div className="inbox-right-subgrids">
          
          {/* ================= SECTION 3: 승인/반려 ================= */}
          <section className="inbox-section section-action-decision">
            <div className="section-title-wrap">
              <span className="section-num">3</span>
              <h3>승인/반려</h3>
              <span className="subtitle-desc">요청을 검토 후 적절한 처리를 선택합니다.</span>
            </div>

            <div className="action-card-body">
              <span className="action-label">처리 결과 선택</span>
              
              <div className="decision-btn-group">
                <button 
                  className={`decision-btn btn-approve ${decision === 'approve' ? 'selected' : ''}`}
                  onClick={() => {
                    setDecision('approve');
                    setComment('요청 내용을 확인하였습니다. 승인합니다.');
                  }}
                >
                  <div className="circle-icon green">
                    <Check size={18} />
                  </div>
                  <span>승인</span>
                </button>

                <button 
                  className={`decision-btn btn-reject ${decision === 'reject' ? 'selected' : ''}`}
                  onClick={() => {
                    setDecision('reject');
                    setComment('보안 지침 위반 우려 및 시스템 부하 가중 사유로 반려합니다.');
                  }}
                >
                  <div className="circle-icon red">
                    <X size={18} />
                  </div>
                  <span>반려</span>
                </button>

                <button 
                  className={`decision-btn btn-hold ${decision === 'hold' ? 'selected' : ''}`}
                  onClick={() => {
                    setDecision('hold');
                    setComment('해당 리포트 추출의 타당성 조사를 위해 일시 보류합니다.');
                  }}
                >
                  <div className="circle-icon grey">
                    <Pause size={18} />
                  </div>
                  <span>보류</span>
                </button>
              </div>

              {/* 코멘트 입력 */}
              <div className="comment-area-wrap">
                <span className="action-label">코멘트 입력</span>
                <textarea 
                  className="form-textarea-comment"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="요청 처리에 관한 의견을 작성해주세요."
                  maxLength={500}
                />
                <span className="char-counter">{comment.length} / 500</span>
              </div>

              {/* 반려 시 필수 체크박스 */}
              {decision === 'reject' && (
                <div className="checkbox-wrap">
                  <input 
                    type="checkbox" 
                    id="chk-reject-reason" 
                    checked={rejectReasonChecked}
                    onChange={(e) => setRejectReasonChecked(e.target.checked)}
                  />
                  <label htmlFor="chk-reject-reason" className="checkbox-lbl text-red-urgent">
                    반려 사유 필수 확인 (반려 선택 시 필수 체크)
                  </label>
                </div>
              )}

              {/* 하단 취소/처리하기 버튼 */}
              <div className="decision-actions">
                <Button 
                  variant="secondary" 
                  onClick={() => {
                    setComment('요청 내용을 확인하였습니다. 승인합니다.');
                    setDecision('approve');
                  }}
                >
                  취소
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
          </section>

          {/* ================= SECTION 4: 모바일 / 간략 승인 카드 ================= */}
          <section className="inbox-section section-mobile-card">
            <div className="section-title-wrap">
              <span className="section-num">4</span>
              <h3>모바일 / 간략 승인 카드</h3>
            </div>

            <div className="mobile-card-body">
              {/* 스마트폰 목업 뷰 */}
              <div className="smartphone-mockup">
                <div className="phone-screen">
                  <div className="phone-header">
                    <span>← 내 결재함 (15)</span>
                    <Smartphone size={10} />
                  </div>
                  
                  <div className="phone-content-card">
                    <div className="phone-card-title">
                      <h5>DB 권한 신청</h5>
                      <span className="mini-badge-orange">승인 대기</span>
                    </div>
                    <div className="phone-card-detail">
                      <div className="phone-detail-row">
                        <span className="p-lbl">신청자</span>
                        <span className="p-val">이철훈 사원</span>
                      </div>
                      <div className="phone-detail-row">
                        <span className="p-lbl">요청일</span>
                        <span className="p-val">2025-05-20 10:15</span>
                      </div>
                      <div className="phone-detail-row">
                        <span className="p-lbl">시스템</span>
                        <span className="p-val">ERP DB (ERP-PROD)</span>
                      </div>
                      <div className="phone-detail-row">
                        <span className="p-lbl">권한</span>
                        <span className="p-val">SELECT, INSERT, UPDATE</span>
                      </div>
                      <div className="phone-detail-row vertical">
                        <span className="p-lbl">사유</span>
                        <span className="p-val bg-box">월간 리포트 생성 및 데이터 분석을...</span>
                      </div>
                      <div className="phone-detail-row">
                        <span className="p-lbl">우선순위</span>
                        <span className="p-val text-red">높음</span>
                      </div>
                    </div>

                    {/* 원터치 승인 3버튼 */}
                    <div className="phone-action-btns">
                      <button className="phone-btn approve" onClick={() => {
                        setDecision('approve');
                        setComment('[모바일 간편 승인] 요청을 최종 확인하여 즉시 승인 처리합니다.');
                        alert('모바일 퀵 승인 모드가 활성화되었습니다. [승인 완료하기]를 눌러 처리를 확정하세요.');
                      }}>
                        승인
                      </button>
                      <button className="phone-btn reject" onClick={() => {
                        setDecision('reject');
                        setComment('[모바일 간편 반려] 보안 요건 미충족 사유로 즉시 반려합니다.');
                        setRejectReasonChecked(true);
                        alert('모바일 퀵 반려 모드가 활성화되었습니다. [반려 처리하기]를 눌러 처리를 확정하세요.');
                      }}>
                        반려
                      </button>
                      <button className="phone-btn hold" onClick={() => {
                        setDecision('hold');
                        setComment('[모바일 간편 보류] 상세 추가 협의 필요로 보류합니다.');
                        alert('모바일 퀵 보류 모드가 활성화되었습니다. [보류 적용하기]를 눌러 처리를 확정하세요.');
                      }}>
                        보류
                      </button>
                    </div>

                    <button className="phone-more-link" onClick={() => alert('상세조회 페이지로 스크롤됩니다.')}>
                      상세 보기 &gt;
                    </button>
                  </div>
                </div>
              </div>

              {/* 모바일 퀵 처리 기능 가이드 */}
              <div className="mobile-guide-box">
                <h6>모바일 Quick 처리 기능</h6>
                <ul>
                  <li>카드 형태로 핵심 정보만 신속 요약 표시</li>
                  <li>원터치로 승인/반려/보류 설정 즉각 반응</li>
                  <li>상세 보기는 원클릭 링크 이동 연동</li>
                  <li>실시간 푸시 알림으로 대기 Task 누락 방지</li>
                </ul>
              </div>
            </div>
          </section>

          {/* ================= SECTION 5: 처리 이력 (타임라인 단계 시각화) ================= */}
          <section className="inbox-section section-timeline-flow">
            <div className="section-title-wrap">
              <span className="section-num">5</span>
              <h3>처리 이력</h3>
              <span className="subtitle-desc">해당 요청의 전체 처리 흐름과 코멘트를 타임라인으로 확인합니다.</span>
            </div>

            <div className="timeline-flow-body">
              {/* 가로형 결재 선 시각화 */}
              <div className="horizontal-timeline">
                <div className="t-node active">
                  <div className="t-node-dot">1</div>
                  <span className="t-node-name">1단계 팀장 승인</span>
                </div>
                <div className="t-line active" />
                <div className="t-node active">
                  <div className="t-node-dot">2</div>
                  <span className="t-node-name">2단계 보안 검토</span>
                </div>
                <div className="t-line active" />
                <div className="t-node processing">
                  <div className="t-node-dot">3</div>
                  <span className="t-node-name">3단계 최종 승인 (현재)</span>
                </div>
                <div className="t-line" />
                <div className="t-node">
                  <div className="t-node-dot">4</div>
                  <span className="t-node-name">4단계 시스템 적용</span>
                </div>
                <div className="t-line" />
                <div className="t-node">
                  <div className="t-node-dot">5</div>
                  <span className="t-node-name">5단계 완료</span>
                </div>
              </div>

              {/* 세로 상세 로그 리스트 */}
              <div className="timeline-vertical-logs">
                <div className="v-log-item green">
                  <div className="v-log-time">2025-05-20 09:50</div>
                  <div className="v-log-content">
                    <div className="v-log-header">
                      <span className="v-log-actor">박지은 팀장 (IT운영팀)</span>
                      <span className="v-log-badge green">승인</span>
                    </div>
                    <p className="v-log-comment">요청 사유 및 범위 명확하여 최종 컨펌합니다.</p>
                  </div>
                </div>

                <div className="v-log-item green">
                  <div className="v-log-time">2025-05-20 10:00</div>
                  <div className="v-log-content">
                    <div className="v-log-header">
                      <span className="v-log-actor">최한수 과장 (보안팀)</span>
                      <span className="v-log-badge green">승인</span>
                    </div>
                    <p className="v-log-comment">보안성 검토 결과 이상 없음 판정 완료.</p>
                  </div>
                </div>

                <div className="v-log-item blue">
                  <div className="v-log-time">2026-05-22 13:24 (현재)</div>
                  <div className="v-log-content">
                    <div className="v-log-header">
                      <span className="v-log-actor">김결재 부장 (경영지원본부)</span>
                      <span className="v-log-badge blue">진행 중</span>
                    </div>
                    <p className="v-log-comment">대기 중 - 최종 권한 위임 및 실행 의사 결정을 기다리고 있습니다.</p>
                  </div>
                </div>
              </div>

              {/* 요청 개요 플로팅 박스 */}
              <div className="summary-float-card">
                <h6>요청 개요</h6>
                <div className="sf-grid">
                  <span className="sf-lbl">요청명</span><span className="sf-val font-semibold">DB 권한 신청</span>
                  <span className="sf-lbl">신청자</span><span className="sf-val">이철훈 사원 (IT운영팀)</span>
                  <span className="sf-lbl">요청일</span><span className="sf-val">2025-05-20 10:15</span>
                  <span className="sf-lbl">요청 ID</span><span className="sf-val font-mono-style">REQ-20250520-0001</span>
                  <span className="sf-lbl">우선순위</span><span className="sf-val text-red">높음</span>
                </div>
              </div>
            </div>
          </section>

        </div> {/* inbox-right-subgrids */}

      </div> {/* inbox-grid */}
    </div>
  );
};
