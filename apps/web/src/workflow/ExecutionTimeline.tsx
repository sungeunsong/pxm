import { type ExecutionEvent } from './types';
import { type ThemeMode, themes } from './theme';

interface ExecutionTimelineProps {
  events: ExecutionEvent[];
  themeMode?: ThemeMode;
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

interface EventCardProps {
  event: ExecutionEvent;
  colors: typeof themes.dark;
}

function EventCard({ event, colors }: EventCardProps) {
  const style = EVENT_STYLES[event.eventType] || { icon: '📌', color: '#64748b' };

  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        padding: '10px 12px',
        backgroundColor: colors.bgSecondary,
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
          <span style={{ fontSize: 10, color: colors.textMuted }}>
            {formatTime(event.timestamp)}
          </span>
        </div>

        {/* 노드 ID */}
        {event.nodeId && (
          <div style={{ fontSize: 11, color: colors.borderLight, marginBottom: 4 }}>
            Node: <span style={{ color: colors.textSecondary }}>{event.nodeId}</span>
          </div>
        )}

        {/* 메시지 */}
        {event.message && (
          <div style={{ fontSize: 11, color: colors.borderLight }}>
            {event.message}
          </div>
        )}

        {/* 상세 정보 (retry_info 등) */}
        {event.details && Object.keys(event.details).length > 0 && (
          <div
            style={{
              marginTop: 6,
              padding: '6px 8px',
              backgroundColor: colors.bgPrimary,
              borderRadius: 6,
              fontSize: 10,
              fontFamily: 'monospace',
              color: colors.borderLight,
              maxHeight: 60,
              overflow: 'auto',
            }}
          >
            {Object.entries(event.details).map(([key, value]) => (
              <div key={key}>
                <span style={{ color: colors.textMuted }}>{key}:</span>{' '}
                <span style={{ color: colors.textSecondary }}>
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

export function ExecutionTimeline({ events, themeMode = 'dark' }: ExecutionTimelineProps) {
  const colors = themes[themeMode];
  // 최신 이벤트가 위로
  const reversedEvents = [...events].reverse();

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: colors.bgPrimary,
        borderLeft: `1px solid ${colors.border}`,
        transition: 'all 0.3s',
      }}
    >
      {/* 헤더 */}
      <div
        style={{
          padding: '12px 16px',
          borderBottom: `1px solid ${colors.border}`,
          backgroundColor: colors.bgSecondary,
          transition: 'all 0.3s',
        }}
      >
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: colors.textSecondary }}>
          Execution Timeline
        </h3>
        <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 4 }}>
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
              color: colors.textMuted,
              padding: 24,
              fontSize: 13,
            }}
          >
            Waiting for events...
          </div>
        ) : (
          reversedEvents.map((event) => (
            <EventCard key={event.id} event={event} colors={colors} />
          ))
        )}
      </div>
    </div>
  );
}
