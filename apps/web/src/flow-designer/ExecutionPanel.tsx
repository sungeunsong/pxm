import React, { useCallback, useEffect, useState, useRef } from 'react';
import { CheckCircle, Circle, AlertCircle, Loader, Clock, X } from 'lucide-react';
import type { FormSchema } from './form-types';
import { FormRenderer } from './FormRenderer';
import { RetryScheduledCard, NodeFailedCard } from './RetryCards';
import './ExecutionPanel.css';

export interface ExecutionEvent {
  id?: string | number;
  source?: string;
  type: string;
  instance_id: string;
  status?: string;
  node_id?: string;
  node_label?: string;
  timestamp: string;
  payload?: any;
}

const toExecutionEvent = (data: any): ExecutionEvent => ({
  id: data.id || data.source_id,
  source: data.source || (data.id ? 'outbox' : undefined),
  type: data.type || data.event_type || 'UNKNOWN',
  instance_id: data.instance_id,
  status: data.status || data.payload?.status,
  node_id: data.node_id || data.payload?.node_id,
  node_label: data.node_label || data.payload?.node_label,
  timestamp: data.created_at || data.timestamp || new Date().toISOString(),
  payload: data.payload || {},
});

const deriveInstanceStatus = (event: ExecutionEvent): string | null => {
  if (event.type === 'INSTANCE_WAITING') return 'WAITING';
  if (event.type === 'INSTANCE_RUNNING') return 'RUNNING';
  if (event.type === 'INSTANCE_COMPLETED') return 'COMPLETED';
  if (event.type === 'INSTANCE_FAILED') return 'FAILED';
  return event.status || null;
};

export interface ExecutionPanelProps {
  instanceId: string | null;
  templateName: string;
  formSchema?: FormSchema;
  onFormSubmit?: (formData: Record<string, any>) => void;
  onClose: () => void;
}

export const ExecutionPanel: React.FC<ExecutionPanelProps> = ({
  instanceId,
  templateName,
  formSchema,
  onFormSubmit,
  onClose,
}) => {
  const [events, setEvents] = useState<ExecutionEvent[]>([]);
  const [status, setStatus] = useState<string>('RUNNING');
  const [error, setError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const loadTrace = useCallback(async () => {
    if (!instanceId) {
      return;
    }

    const response = await fetch(`/api/instances/${instanceId}/trace`);
    if (!response.ok) {
      throw new Error(`trace api failed: ${response.status}`);
    }

    const rows = await response.json();
    const nextEvents = (Array.isArray(rows) ? rows : []).map(toExecutionEvent);
    setEvents(nextEvents);

    const latestStatus = [...nextEvents]
      .reverse()
      .map(deriveInstanceStatus)
      .find(Boolean);
    if (latestStatus) {
      setStatus(latestStatus);
    }
  }, [instanceId]);

  useEffect(() => {
    if (!instanceId) {
      return;
    }

    setEvents([]);
    setStatus('RUNNING');
    setError(null);
    loadTrace().catch((err) => {
      console.error('Failed to load trace:', err);
    });

    // SSE 연결
    const eventSource = new EventSource(`/api/instances/${instanceId}/stream`);
    eventSourceRef.current = eventSource;

    // 공통 이벤트 핸들러
    const handleEvent = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        console.log('SSE Event (Panel):', data);

        const executionEvent = toExecutionEvent(data);

        setEvents((prev) => {
          const eventKey = `${executionEvent.source || 'sse'}:${executionEvent.id || executionEvent.timestamp}:${executionEvent.type}`;
          const exists = prev.some((item) => {
            const itemKey = `${item.source || 'sse'}:${item.id || item.timestamp}:${item.type}`;
            return itemKey === eventKey;
          });
          return exists ? prev : [...prev, executionEvent];
        });

        // 상태 업데이트
        const nextStatus = deriveInstanceStatus(executionEvent);
        if (nextStatus) {
          setStatus(nextStatus);
        }

        // 완료 또는 실패 시 연결 종료
        if (executionEvent.type === 'INSTANCE_COMPLETED' || executionEvent.type === 'INSTANCE_FAILED') {
          setTimeout(() => {
            eventSource.close();
          }, 1000);
        }
      } catch (err) {
        console.error('Failed to parse SSE event:', err);
      }
    };

    // 모든 이벤트 타입에 대해 리스너 등록
    const eventTypes = [
      'INSTANCE_CREATED',
      'INSTANCE_RUNNING',
      'INSTANCE_WAITING',
      'INSTANCE_COMPLETED',
      'INSTANCE_FAILED',
      'NODE_STARTED',
      'NODE_COMPLETED',
      'NODE_FAILED',
      'TIMER_SCHEDULED',
      'TIMER_ESCALATED',
      'RETRY_SCHEDULED',
      'APPROVAL_REQUIRED',
      'TASK_CREATED',
    ];

    eventTypes.forEach((eventType) => {
      eventSource.addEventListener(eventType, handleEvent);
    });

    // 기본 message 이벤트도 처리
    eventSource.onmessage = handleEvent;

    eventSource.onerror = (err) => {
      console.error('SSE Error:', err);
      setError('실시간 연결이 끊어져 저장된 실행 로그를 표시합니다.');
      loadTrace().catch((traceErr) => {
        console.error('Failed to load trace after SSE error:', traceErr);
      });
      eventSource.close();
    };

    return () => {
      eventSource.close();
    };
  }, [instanceId, loadTrace]);

  const getActivityStatus = (type: string) => {
    if (type.includes('COMPLETED')) return 'COMPLETED';
    if (type.includes('FAILED')) return 'FAILED';
    if (type.includes('WAITING')) return 'WAITING';
    if (type.includes('RUNNING') || type.includes('STARTED')) return 'RUNNING';
    return undefined;
  };

  const getStatusIcon = (eventStatus?: string, isTimeline = false) => {
    switch (eventStatus) {
      case 'COMPLETED':
        return <CheckCircle size={14} className="status-icon success" />;
      case 'FAILED':
        return <AlertCircle size={14} className="status-icon error" />;
      case 'WAITING':
        return <Clock size={14} className="status-icon waiting" />;
      case 'RUNNING':
        return isTimeline ? (
          <Circle size={14} className="status-icon running" fill="currentColor" />
        ) : (
          <Loader size={14} className="status-icon running" />
        );
      default:
        return <Circle size={14} className="status-icon pending" />;
    }
  };

  const getStatusColor = (eventStatus?: string) => {
    switch (eventStatus) {
      case 'COMPLETED':
        return 'success';
      case 'FAILED':
        return 'error';
      case 'WAITING':
        return 'waiting';
      case 'RUNNING':
        return 'running';
      default:
        return 'pending';
    }
  };

  return (
    <div className="execution-panel">
      <div className="execution-panel-header">
        <div>
          <h3 className="execution-panel-title">워크플로우 실행</h3>
          <p className="execution-panel-subtitle">{templateName}</p>
        </div>
        <button className="execution-panel-close" onClick={onClose}>
          <X size={18} />
        </button>
      </div>

      <div className="execution-panel-body">
        {/* 폼 입력 화면 (instanceId가 null이고 formSchema가 있을 때) */}
        {!instanceId && formSchema && onFormSubmit ? (
          <div className="execution-form">
            <p className="form-description">
              워크플로우를 실행하기 전에 필요한 정보를 입력해주세요.
            </p>
            <FormRenderer
              schema={formSchema}
              onSubmit={(data) => {
                onFormSubmit(data);
              }}
              onCancel={onClose}
            />
          </div>
        ) : (
          <>
            {/* 전체 상태 */}
            <div className={`execution-status-compact status-${getStatusColor(status)}`}>
              {getStatusIcon(status)}
              <span className="execution-status-text">{status}</span>
            </div>

            {/* 에러 메시지 */}
            {error && (
              <div className="execution-error">
                <AlertCircle size={14} />
                <span>{error}</span>
              </div>
            )}

            {/* 이벤트 타임라인 */}
            <div className="execution-timeline">
              <h4 className="timeline-title">실행 로그</h4>
              {events.length === 0 ? (
                <div className="timeline-empty">
                  <Loader size={20} className="spinning" />
                  <p>이벤트를 기다리는 중...</p>
                </div>
              ) : (
                <div className="timeline-events">
                  {events.map((event, index) => {
                    // RETRY_SCHEDULED 이벤트 특별 처리
                    if (event.type === 'RETRY_SCHEDULED' && event.payload?.retry_info) {
                      return (
                        <RetryScheduledCard
                          key={index}
                          retryInfo={event.payload.retry_info}
                          timestamp={event.timestamp}
                          nodeLabel={event.node_label}
                          payload={event.payload}
                        />
                      );
                    }
                    
                    // NODE_FAILED 이벤트 특별 처리
                    if (event.type === 'NODE_FAILED' && event.payload?.retry_info) {
                      return (
                        <NodeFailedCard
                          key={index}
                          retryInfo={event.payload.retry_info}
                          timestamp={event.timestamp}
                          nodeLabel={event.node_label}
                          payload={event.payload}
                          isFinal={event.payload.final === true}
                          statusCode={event.payload.status_code}
                        />
                      );
                    }
                    
                    // 기본 이벤트 렌더링
                    return (
                    <div key={index} className={`timeline-event event-${event.type.toLowerCase()}`}>
                      <div className="timeline-event-marker">
                        {getStatusIcon(event.status || getActivityStatus(event.type), true)}
                      </div>
                      <div className="timeline-event-content">
                        <div className="timeline-event-header">
                          <span className="timeline-event-type">{event.type}</span>
                          <span className="timeline-event-time">
                            {new Date(event.timestamp).toLocaleTimeString('ko-KR', { 
                              hour: '2-digit', 
                              minute: '2-digit',
                              second: '2-digit'
                            })}
                          </span>
                        </div>
                        {event.node_label && (
                          <div className="timeline-event-detail">
                            {event.node_label}
                          </div>
                        )}
                        {/* 상세 정보 */}
                        <details className="timeline-event-payload">
                          <summary>상세</summary>
                          <pre>{JSON.stringify({
                            type: event.type,
                            node_id: event.node_id,
                            status: event.status,
                            payload: event.payload
                          }, null, 2)}</pre>
                        </details>
                      </div>
                    </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
