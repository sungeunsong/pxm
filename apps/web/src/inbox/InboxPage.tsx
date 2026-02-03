import React, { useEffect, useState } from 'react';
import { Header } from '../components/Header';
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

export const InboxPage: React.FC = () => {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);

  // Task 목록 조회
  const fetchTasks = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/tasks?assignee=admin');
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      setTasks(data);
    } catch (error) {
      console.error('Failed to fetch tasks:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTasks();
    // 3초마다 폴링 (실시간성 확보)
    const interval = setInterval(fetchTasks, 3000);
    return () => clearInterval(interval);
  }, []);

  // 승인/반려 처리
  const handleComplete = async (taskId: string, action: 'approve' | 'reject') => {
    try {
      if (!confirm(`${action === 'approve' ? '승인' : '반려'} 하시겠습니까?`)) return;

      const res = await fetch(`/api/tasks/${taskId}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });

      if (res.ok) {
        // 즉시 반영을 위해 목록 갱신
        fetchTasks();
      } else {
        alert('처리 중 오류가 발생했습니다.');
      }
    } catch (error) {
      console.error('Failed to complete task:', error);
    }
  };

  // 값 포맷팅 헬퍼
  const formatValue = (value: any): React.ReactNode => {
    if (value === null || value === undefined) return <span className="text-secondary">-</span>;
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (typeof value === 'object') {
       return <code style={{ fontSize: '11px', background: 'rgba(0,0,0,0.2)', padding: '2px 4px', borderRadius: '3px' }}>
         {JSON.stringify(value)}
       </code>;
    }
    return String(value);
  };

  return (
    <div className="inbox-page">
      <Header title="PXM Inbox" actions={
        <Button variant="secondary" size="sm" onClick={() => window.location.href = '/'}>
          디자이너로 돌아가기
        </Button>
      }/>
      
      <main className="inbox-content">
        <div className="inbox-container">
          <div className="inbox-header">
            <h2>
              대기 중인 문서 
              <span style={{ marginLeft: '8px', fontSize: '14px', color: 'var(--text-tertiary)', fontWeight: 'normal' }}>
                ({loading ? '...' : tasks.length})
              </span>
            </h2>
            <Button variant="ghost" size="sm" onClick={fetchTasks}>새로고침</Button>
          </div>

          {loading && tasks.length === 0 ? (
            <div className="loading" style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>
              로딩 중...
            </div>
          ) : tasks.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">🎉</div>
              <h3>모든 결재를 완료했습니다!</h3>
              <p>현재 대기 중인 문서가 없습니다.</p>
            </div>
          ) : (
            <div className="task-list">
              {tasks.map(task => (
                <div key={task.id} className="task-card">
                  <div className="task-header">
                    <span className="task-id" title={task.instance_id}>
                      Instance: {task.instance_id.slice(0, 8)}
                    </span>
                    <span className="task-date">
                      {new Date(task.created_at).toLocaleString()}
                    </span>
                  </div>
                  
                  <div className="task-body">
                    <h4>결재 요청 내용</h4>
                    <div className="form-summary">
                      {task.form_data && Object.keys(task.form_data).length > 0 ? (
                        Object.entries(task.form_data).map(([key, value]) => (
                          <div key={key} className="summary-item">
                            <span className="summary-label">{key}</span>
                            <span className="summary-value">{formatValue(value)}</span>
                          </div>
                        ))
                      ) : (
                        <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
                          폼 데이터가 없습니다.
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="task-footer">
                    <div className="status-badge">Waiting Approval</div>
                    <div className="task-actions">
                      <Button variant="danger" size="sm" onClick={() => handleComplete(task.id, 'reject')}>
                        반려 (Reject)
                      </Button>
                      <Button variant="primary" size="sm" onClick={() => handleComplete(task.id, 'approve')}>
                        승인 (Approve)
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
};
