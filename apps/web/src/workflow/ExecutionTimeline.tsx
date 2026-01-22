import { type ExecutionEvent } from './types';

interface ExecutionTimelineProps {
  events: ExecutionEvent[];
}

// 이벤트 타입별 아이콘과 색상
const EVENT_STYLES: Record<string, { icon: string; color: string }> = {
  INSTANCE_CREATED: { icon: '🚀', color: '#3b82f6' },
  INSTANCE_RUNNING: { icon: '▶️', color: '#3b82f6' },
  INSTANCE_WAITING: { icon: '⏳', color: '#f59e0b' },
  INSTANCE_COMPLETED: { icon: '✅', color: '#22c55e' },
  INSTANCE_FAILED: { icon: '❌', color: '#ef4444' },
  NODE_STARTED: { icon: '⚡', color: '#8b5cf6' },
  NODE_COMPLETED: { icon: '✓', color: '#22c55e' },
  NODE_FAILED: { icon: '✗', color: '#ef4444' },
  RETRY_SCHEDULED: { icon: '🔄', color: '#c026d3' },
  TIMER_SCHEDULED: { icon: '⏱️', color: '#f59e0b' },
  TIMER_ESCALATED: { icon: '🚨', color: '#ef4444' },
};

function formatTime(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('ko-KR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
    });
  } catch {
    return timestamp;
  }
}

function EventCard({ event }: { event: ExecutionEvent }) {
  const style = EVENT_STYLES[event.eventType] || { icon: '📌', color: '#64748b' };

  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        padding: '10px 12px',
        backgroundColor: '#1e293b',
        borderRadius: 8,
        borderLeft: `3px solid ${style.color}`,
        marginBottom: 8,
        transition: 'all 0.2s ease',
        animation: 'slideIn 0.3s ease-out',
      }}
    >
      {/* 아이콘 */}
      <div style={{ fontSize: 16, flexShrink: 0 }}>
        {style.icon}
      </div>

      {/* 내용 */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* 헤더 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontWeight: 600, fontSize: 12, color: style.color }}>
            {event.eventType}
          </span>
          <span style={{ fontSize: 10, color: '#64748b' }}>
            {formatTime(event.timestamp)}
          </span>
        </div>

        {/* 노드 ID */}
        {event.nodeId && (
          <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>
            Node: <span style={{ color: '#e2e8f0' }}>{event.nodeId}</span>
          </div>
        )}

        {/* 메시지 */}
        {event.message && (
          <div style={{ fontSize: 11, color: '#94a3b8' }}>
            {event.message}
          </div>
        )}

        {/* 상세 정보 (retry_info 등) */}
        {event.details && Object.keys(event.details).length > 0 && (
          <div
            style={{
              marginTop: 6,
              padding: '6px 8px',
              backgroundColor: '#0f172a',
              borderRadius: 6,
              fontSize: 10,
              fontFamily: 'monospace',
              color: '#94a3b8',
              maxHeight: 60,
              overflow: 'auto',
            }}
          >
            {Object.entries(event.details).map(([key, value]) => (
              <div key={key}>
                <span style={{ color: '#64748b' }}>{key}:</span>{' '}
                <span style={{ color: '#e2e8f0' }}>
                  {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function ExecutionTimeline({ events }: ExecutionTimelineProps) {
  // 최신 이벤트가 위로
  const reversedEvents = [...events].reverse();

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: '#0f172a',
        borderLeft: '1px solid #334155',
      }}
    >
      {/* 헤더 */}
      <div
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid #334155',
          backgroundColor: '#1e293b',
        }}
      >
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#e2e8f0' }}>
          Execution Timeline
        </h3>
        <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
          {events.length} events
        </div>
      </div>

      {/* 이벤트 목록 */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 12,
        }}
      >
        {reversedEvents.length === 0 ? (
          <div
            style={{
              textAlign: 'center',
              color: '#64748b',
              padding: 24,
              fontSize: 13,
            }}
          >
            Waiting for events...
          </div>
        ) : (
          reversedEvents.map((event) => (
            <EventCard key={event.id} event={event} />
          ))
        )}
      </div>
    </div>
  );
}
