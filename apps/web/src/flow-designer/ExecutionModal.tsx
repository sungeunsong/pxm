import React, { useEffect, useState, useRef } from 'react';
import { X, CheckCircle, Circle, AlertCircle, Loader } from 'lucide-react';
import { Button } from '../components/Button';
import { FormRenderer } from './FormRenderer';
import type { FormSchema } from './form-types';
import './ExecutionModal.css';

export interface ExecutionEvent {
  type: string;
  instance_id: string;
  status?: string;
  node_id?: string;
  node_label?: string;
  timestamp: string;
  payload?: any;
}

export interface ExecutionModalProps {
  isOpen: boolean;
  instanceId: string | null;
  templateName: string;
  formSchema?: FormSchema;
  onFormSubmit?: (formData: Record<string, any>) => void;
  onClose: () => void;
}

export const ExecutionModal: React.FC<ExecutionModalProps> = ({
  isOpen,
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

  useEffect(() => {
    if (!isOpen || !instanceId) {
      return;
    }

    // SSE 연결
    const eventSource = new EventSource(`http://localhost:3000/instances/${instanceId}/stream`);
    eventSourceRef.current = eventSource;

    // 공통 이벤트 핸들러
    const handleEvent = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        console.log('SSE Event (Modal):', data);

        // event_type과 payload를 사용하여 이벤트 생성
        const executionEvent: ExecutionEvent = {
          type: data.event_type || 'UNKNOWN',
          instance_id: data.instance_id,
          status: data.payload?.status,
          node_id: data.payload?.node_id,
          node_label: data.payload?.node_label,
          timestamp: data.created_at || new Date().toISOString(),
          payload: data.payload,
        };

        setEvents((prev) => [...prev, executionEvent]);

        // 상태 업데이트
        if (executionEvent.status) {
          setStatus(executionEvent.status);
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
    ];

    eventTypes.forEach((eventType) => {
      eventSource.addEventListener(eventType, handleEvent);
    });

    // 기본 message 이벤트도 처리
    eventSource.onmessage = handleEvent;

    eventSource.onerror = (err) => {
      console.error('SSE Error:', err);
      setError('실시간 연결이 끊어졌습니다.');
      eventSource.close();
    };

    return () => {
      eventSource.close();
    };
  }, [isOpen, instanceId]);

  const handleClose = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }
    setEvents([]);
    setStatus('RUNNING');
    setError(null);
    onClose();
  };

  if (!isOpen) return null;

  const getStatusIcon = (eventStatus?: string) => {
    switch (eventStatus) {
      case 'COMPLETED':
        return <CheckCircle size={16} className="status-icon success" />;
      case 'FAILED':
        return <AlertCircle size={16} className="status-icon error" />;
      case 'RUNNING':
        return <Loader size={16} className="status-icon running" />;
      default:
        return <Circle size={16} className="status-icon pending" />;
    }
  };

  const getStatusColor = (eventStatus?: string) => {
    switch (eventStatus) {
      case 'COMPLETED':
        return 'success';
      case 'FAILED':
        return 'error';
      case 'RUNNING':
        return 'running';
      default:
        return 'pending';
    }
  };

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal-content execution-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2 className="modal-title">워크플로우 실행</h2>
            <p className="modal-subtitle">{templateName}</p>
          </div>
          <button className="modal-close" onClick={handleClose}>
            <X size={20} />
          </button>
        </div>

        <div className="modal-body">
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
                onCancel={handleClose}
              />
            </div>
          ) : (
            <>
              {/* 전체 상태 */}
              <div className={`execution-status status-${getStatusColor(status)}`}>
                {getStatusIcon(status)}
                <div className="execution-status-info">
                  <span className="execution-status-label">상태</span>
                  <span className="execution-status-value">{status}</span>
                </div>
              </div>

              {/* 에러 메시지 */}
              {error && (
                <div className="execution-error">
                  <AlertCircle size={16} />
                  <span>{error}</span>
                </div>
              )}

              {/* 이벤트 타임라인 */}
              <div className="execution-timeline">
                <h3 className="timeline-title">실행 로그</h3>
                {events.length === 0 ? (
                  <div className="timeline-empty">
                    <Loader size={24} className="spinning" />
                    <p>이벤트를 기다리는 중...</p>
                  </div>
                ) : (
                  <div className="timeline-events">
                    {events.map((event, index) => (
                      <div key={index} className={`timeline-event event-${event.type.toLowerCase()}`}>
                        <div className="timeline-event-marker">
                          {getStatusIcon(event.status)}
                        </div>
                        <div className="timeline-event-content">
                          <div className="timeline-event-header">
                            <span className="timeline-event-type">{event.type}</span>
                            <span className="timeline-event-time">
                              {new Date(event.timestamp).toLocaleTimeString('ko-KR')}
                            </span>
                          </div>
                          {event.node_label && (
                            <div className="timeline-event-detail">
                              노드: <strong>{event.node_label}</strong>
                            </div>
                          )}
                          {event.status && (
                            <div className="timeline-event-detail">
                              상태: <span className={`status-badge status-${getStatusColor(event.status)}`}>
                                {event.status}
                              </span>
                            </div>
                          )}
                          {event.payload && (
                            <details className="timeline-event-payload">
                              <summary>상세 정보</summary>
                              <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                            </details>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <div className="modal-footer">
          <Button onClick={handleClose} variant="secondary">
            닫기
          </Button>
        </div>
      </div>
    </div>
  );
};
