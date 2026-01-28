import { useState, useCallback } from 'react';
import { WorkflowGraph } from './WorkflowGraph';
import { ExecutionTimeline } from './ExecutionTimeline';
import { useWorkflowState } from './useWorkflowState';
import { ThemeProvider, useTheme } from './ThemeContext';
import { ThemeToggle } from './ThemeToggle';
import './styles.css';

// 상태별 라벨
const STATUS_LABELS: Record<string, string> = {
  created: 'Created',
  running: 'Running',
  waiting: 'Waiting',
  completed: 'Completed',
  failed: 'Failed',
};

function RuntimeTraceContent() {
  const [instanceId, setInstanceId] = useState<string>('');
  const [activeInstanceId, setActiveInstanceId] = useState<string>('');
  const { colors, mode } = useTheme();

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
        backgroundColor: colors.bgPrimary,
        color: colors.textSecondary,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        transition: 'background-color 0.3s, color 0.3s',
      }}
    >
      {/* 헤더 */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 20px',
          background: mode === 'dark'
            ? 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)'
            : 'linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%)',
          borderBottom: `1px solid ${colors.border}`,
          transition: 'all 0.3s',
        }}
      >
        {/* 로고 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 24 }}>⚡</span>
          <span style={{ fontSize: 18, fontWeight: 700, color: colors.textPrimary }}>
            PXM Runtime
          </span>
        </div>

        {/* 구분선 */}
        <div style={{ width: 1, height: 24, backgroundColor: colors.border }} />

        {/* 인스턴스 입력 */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="text"
            placeholder="Instance ID or create new..."
            value={instanceId}
            onChange={(e) => setInstanceId(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
            style={{
              padding: '8px 12px',
              borderRadius: 8,
              border: `1px solid ${colors.border}`,
              backgroundColor: colors.bgSecondary,
              color: colors.textPrimary,
              fontSize: 13,
              width: 320,
              outline: 'none',
              transition: 'all 0.2s',
            }}
          />
          <button
            onClick={handleConnect}
            style={{
              padding: '8px 16px',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              border: 'none',
              backgroundColor: colors.bgTertiary,
              color: colors.textSecondary,
              transition: 'all 0.2s',
            }}
          >
            Connect
          </button>
          <button
            onClick={handleCreateInstance}
            style={{
              padding: '8px 16px',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              border: 'none',
              backgroundColor: colors.accent,
              color: '#fff',
              transition: 'all 0.2s',
            }}
          >
            + New Instance
          </button>
        </div>

        {/* 구분선 */}
        <div style={{ width: 1, height: 24, backgroundColor: colors.border }} />

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
            <span style={{ fontSize: 11, color: colors.textMuted, fontFamily: 'monospace' }}>
              {activeInstanceId.slice(0, 8)}...
            </span>
          </>
        )}

        {/* 우측 여백 */}
        <div style={{ flex: 1 }} />

        {/* 테마 토글 */}
        <ThemeToggle />
      </header>

      {/* 메인 콘텐츠 */}
      <main style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* 워크플로우 그래프 */}
        <div style={{ flex: 1, position: 'relative' }}>
          {activeInstanceId ? (
            <WorkflowGraph
              nodeStatuses={nodeStatuses}
              activeEdge={activeEdge}
              themeMode={mode}
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
                color: colors.textMuted,
                backgroundColor: colors.bgPrimary,
              }}
            >
              <span style={{ fontSize: 64 }}>🔍</span>
              <p style={{ fontSize: 16 }}>
                Create a new instance or enter an existing ID to start tracing
              </p>
              <button
                style={{
                  fontSize: 16,
                  padding: '12px 24px',
                  borderRadius: 8,
                  fontWeight: 600,
                  cursor: 'pointer',
                  border: 'none',
                  backgroundColor: colors.accent,
                  color: '#fff',
                }}
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
            <ExecutionTimeline events={events} themeMode={mode} />
          </div>
        )}
      </main>
    </div>
  );
}

export function RuntimeTrace() {
  return (
    <ThemeProvider>
      <RuntimeTraceContent />
    </ThemeProvider>
  );
}
