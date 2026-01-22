import { useState, useCallback } from 'react';
import { WorkflowGraph } from './WorkflowGraph';
import { ExecutionTimeline } from './ExecutionTimeline';
import { useWorkflowState } from './useWorkflowState';
import './styles.css';

// 상태별 라벨
const STATUS_LABELS: Record<string, string> = {
  created: 'Created',
  running: 'Running',
  waiting: 'Waiting',
  completed: 'Completed',
  failed: 'Failed',
};

export function RuntimeTrace() {
  const [instanceId, setInstanceId] = useState<string>('');
  const [activeInstanceId, setActiveInstanceId] = useState<string>('');

  const { nodeStatuses, activeEdge, events, instanceStatus } = useWorkflowState(activeInstanceId);

  // 인스턴스 생성
  const handleCreateInstance = useCallback(async () => {
    try {
      const res = await fetch('http://localhost:3000/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template_id: '00000000-0000-0000-0000-000000000001',
          ctx: { cursor: 'start' },
        }),
      });
      const data = await res.json();
      if (data.instance_id) {
        setInstanceId(data.instance_id);
        setActiveInstanceId(data.instance_id);
      }
    } catch (err) {
      console.error('Failed to create instance:', err);
    }
  }, []);

  // 기존 인스턴스 연결
  const handleConnect = useCallback(() => {
    if (instanceId.trim()) {
      setActiveInstanceId(instanceId.trim());
    }
  }, [instanceId]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        backgroundColor: '#0f172a',
        color: '#e2e8f0',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      }}
    >
      {/* 헤더 */}
      <header className="status-header">
        {/* 로고 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 24 }}>⚡</span>
          <span style={{ fontSize: 18, fontWeight: 700, color: '#f8fafc' }}>
            PXM Runtime
          </span>
        </div>

        {/* 구분선 */}
        <div style={{ width: 1, height: 24, backgroundColor: '#334155' }} />

        {/* 인스턴스 입력 */}
        <div className="instance-form">
          <input
            type="text"
            className="instance-input"
            placeholder="Instance ID or create new..."
            value={instanceId}
            onChange={(e) => setInstanceId(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
          />
          <button className="btn btn-secondary" onClick={handleConnect}>
            Connect
          </button>
          <button className="btn btn-primary" onClick={handleCreateInstance}>
            + New Instance
          </button>
        </div>

        {/* 구분선 */}
        <div style={{ width: 1, height: 24, backgroundColor: '#334155' }} />

        {/* 상태 배지 */}
        {activeInstanceId && (
          <>
            <span className={`status-badge ${instanceStatus}`}>
              {instanceStatus === 'running' && (
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    backgroundColor: 'currentColor',
                    animation: 'pulse 1s infinite',
                  }}
                />
              )}
              {STATUS_LABELS[instanceStatus]}
            </span>
            <span style={{ fontSize: 11, color: '#64748b', fontFamily: 'monospace' }}>
              {activeInstanceId.slice(0, 8)}...
            </span>
          </>
        )}
      </header>

      {/* 메인 콘텐츠 */}
      <main style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* 워크플로우 그래프 */}
        <div style={{ flex: 1, position: 'relative' }}>
          {activeInstanceId ? (
            <WorkflowGraph
              nodeStatuses={nodeStatuses}
              activeEdge={activeEdge}
            />
          ) : (
            <div
              style={{
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 16,
                color: '#64748b',
              }}
            >
              <span style={{ fontSize: 64 }}>🔍</span>
              <p style={{ fontSize: 16 }}>
                Create a new instance or enter an existing ID to start tracing
              </p>
              <button
                className="btn btn-primary"
                style={{ fontSize: 16, padding: '12px 24px' }}
                onClick={handleCreateInstance}
              >
                Create New Instance
              </button>
            </div>
          )}
        </div>

        {/* 실행 로그 패널 */}
        {activeInstanceId && (
          <div style={{ width: 360, flexShrink: 0 }}>
            <ExecutionTimeline events={events} />
          </div>
        )}
      </main>
    </div>
  );
}
