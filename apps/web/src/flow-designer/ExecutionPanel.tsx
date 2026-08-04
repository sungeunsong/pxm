import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { CheckCircle, Circle, AlertCircle, Loader, Clock, X, Copy, Terminal } from 'lucide-react';
import type { FormSchema } from './form-types';
import { FormRenderer } from './FormRenderer';
import { RetryScheduledCard, NodeFailedCard } from './RetryCards';
import { sanitizeTerminalText } from './terminal-output';
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

const internalEventTypes = new Set(['V2_JOB_PROCESSED']);

const getNodeName = (event: ExecutionEvent) =>
  event.node_label || event.node_id || event.payload?.node_id || '워크플로우';

const getEventTitle = (event: ExecutionEvent) => {
  const nodeName = getNodeName(event);
  switch (event.type) {
    case 'INSTANCE_RUNNING':
      return '워크플로우 실행 시작';
    case 'INSTANCE_WAITING':
      return '사용자 승인 대기';
    case 'INSTANCE_COMPLETED':
      return '워크플로우 완료';
    case 'INSTANCE_FAILED':
      return '워크플로우 실패';
    case 'NODE_STARTED':
      return `${nodeName} 시작`;
    case 'NODE_COMPLETED':
      return `${nodeName} 완료`;
    case 'NODE_FAILED':
      return `${nodeName} 실패`;
    case 'TASK_CREATED':
      return `${nodeName} 승인 요청 생성`;
    case 'TIMER_SCHEDULED':
      return `${nodeName} 타이머 예약`;
    case 'GATEWAY_JOIN_WAITING':
      return `${nodeName} 병렬 합류 대기`;
    default:
      return event.type;
  }
};

const getEventDescription = (event: ExecutionEvent) => {
  switch (event.type) {
    case 'NODE_STARTED':
      return '해당 노드 실행을 시작했습니다.';
    case 'NODE_COMPLETED':
      return '해당 노드 실행이 정상 완료됐습니다.';
    case 'TASK_CREATED':
      return `담당자 ${event.payload?.assignee || 'admin'}에게 승인 작업이 생성됐습니다.`;
    case 'INSTANCE_WAITING':
      return '승인 또는 외부 입력을 기다리는 상태입니다.';
    case 'INSTANCE_COMPLETED':
      return '모든 토큰이 종료되어 인스턴스가 완료됐습니다.';
    case 'GATEWAY_JOIN_WAITING':
      return `${event.payload?.arrived || 0}/${event.payload?.expected || '?'}개 분기가 도착했습니다.`;
    default:
      return event.node_id ? `노드 ID: ${event.node_id}` : '';
  }
};

const getEventCategory = (event: ExecutionEvent) => {
  if (event.type.startsWith('INSTANCE_')) return '인스턴스';
  if (event.type.startsWith('NODE_')) return '노드';
  if (event.type.startsWith('TASK_')) return '승인';
  if (event.type.startsWith('TIMER_')) return '타이머';
  if (event.type.startsWith('GATEWAY_')) return '게이트웨이';
  return '시스템';
};

export interface ExecutionPanelProps {
  instanceId: string | null;
  templateId?: string | null;
  templateName: string;
  formSchema?: FormSchema;
  onFormSubmit?: (formData: Record<string, any>) => void;
  onClose: () => void;
}

type CommandTerminalEntry = {
  nodeId: string;
  nodeLabel: string;
  commandId: string;
  outputPath: string;
  exitCode?: number | string | null;
  timedOut?: boolean;
  durationMs?: number | string | null;
  stdout: string;
  stderr: string;
  hasOutput: boolean;
};

export const ExecutionPanel: React.FC<ExecutionPanelProps> = ({
  instanceId,
  templateId,
  templateName,
  formSchema,
  onFormSubmit,
  onClose,
}) => {
  const [events, setEvents] = useState<ExecutionEvent[]>([]);
  const [status, setStatus] = useState<string>('RUNNING');
  const [error, setError] = useState<string | null>(null);
  const [instanceDetail, setInstanceDetail] = useState<any>(null);
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

  const loadInstanceDetail = useCallback(async () => {
    if (!instanceId) {
      return;
    }

    const response = await fetch(`/api/instances/${instanceId}`);
    if (!response.ok) {
      throw new Error(`instance api failed: ${response.status}`);
    }

    setInstanceDetail(await response.json());
  }, [instanceId]);

  useEffect(() => {
    if (!instanceId) {
      return;
    }

    setEvents([]);
    setInstanceDetail(null);
    setStatus('RUNNING');
    setError(null);
    loadTrace().catch((err) => {
      console.error('Failed to load trace:', err);
    });
    loadInstanceDetail().catch((err) => {
      console.error('Failed to load instance detail:', err);
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
          loadInstanceDetail().catch((detailErr) => {
            console.error('Failed to refresh instance detail:', detailErr);
          });
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
      loadInstanceDetail().catch((detailErr) => {
        console.error('Failed to load instance detail after SSE error:', detailErr);
      });
      eventSource.close();
    };

    return () => {
      eventSource.close();
    };
  }, [instanceId, loadInstanceDetail, loadTrace]);

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

  const visibleEvents = events.filter((event) => !internalEventTypes.has(event.type));
  const hiddenInternalCount = events.length - visibleEvents.length;
  const terminalEntriesByNodeId = useMemo(
    () => new Map(buildTerminalEntries(instanceDetail, visibleEvents).map((entry) => [entry.nodeId, entry])),
    [instanceDetail, visibleEvents],
  );
  const handleCopyInstanceId = async () => {
    if (instanceId) {
      await navigator.clipboard.writeText(instanceId);
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
              presetScopeId={templateId || undefined}
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

            {instanceId && (
              <div className="execution-instance-id-row">
                <span className="execution-instance-id-label">Instance ID</span>
                <code className="execution-instance-id-value">{instanceId}</code>
                <button
                  type="button"
                  className="execution-id-copy-button"
                  onClick={handleCopyInstanceId}
                  title="Instance ID 복사"
                  aria-label="Instance ID 복사"
                >
                  <Copy size={13} />
                </button>
              </div>
            )}

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
              {hiddenInternalCount > 0 && (
                <div className="timeline-internal-note">
                  내부 엔진 처리 이벤트 {hiddenInternalCount}건은 숨겼습니다.
                </div>
              )}
              {visibleEvents.length === 0 ? (
                <div className="timeline-empty">
                  <Loader size={20} className="spinning" />
                  <p>이벤트를 기다리는 중...</p>
                </div>
              ) : (
                <div className="timeline-events">
                  {visibleEvents.map((event, index) => {
                    const terminalEntry =
                      event.type === 'NODE_COMPLETED' && event.node_id
                        ? terminalEntriesByNodeId.get(event.node_id)
                        : undefined;

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
                          <div className="timeline-event-title-group">
                            <span className="timeline-event-title">{getEventTitle(event)}</span>
                            <span className="timeline-event-category">{getEventCategory(event)}</span>
                          </div>
                          <span className="timeline-event-time">
                            {new Date(event.timestamp).toLocaleTimeString('ko-KR', { 
                              hour: '2-digit', 
                              minute: '2-digit',
                              second: '2-digit'
                            })}
                          </span>
                        </div>
                        <div className="timeline-event-meta">
                          <span className="timeline-event-type">{event.type}</span>
                          {event.node_id && <span className="timeline-event-node">node: {event.node_id}</span>}
                        </div>
                        {getEventDescription(event) && (
                          <div className="timeline-event-detail">
                            {getEventDescription(event)}
                          </div>
                        )}
                        {terminalEntry && (
                          <CommandTerminalCard entry={terminalEntry} compact />
                        )}
                        {isJsNodeEvent(event) && (
                          <JsExecutionBlocks event={event} />
                        )}
                        {/* 상세 정보 */}
                        <details className="timeline-event-payload">
                          <summary>상세</summary>
                          <pre>{JSON.stringify({
                            type: event.type,
                            node_id: event.node_id,
                            status: event.status,
                            payload: sanitizeLogValue(event.payload)
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

const CommandTerminalCard: React.FC<{ entry: CommandTerminalEntry; compact?: boolean }> = ({ entry, compact = false }) => {
  const sanitizedStdout = sanitizeTerminalText(entry.stdout);
  const sanitizedStderr = sanitizeTerminalText(entry.stderr);

  const handleCopy = async () => {
    await navigator.clipboard.writeText([
      `$ ${sanitizeTerminalText(entry.commandId)}`,
      sanitizedStdout ? `\n# stdout\n${sanitizedStdout}` : '',
      sanitizedStderr ? `\n# stderr\n${sanitizedStderr}` : '',
    ].join('\n').trim());
  };

  return (
    <article className={`command-terminal-card ${compact ? 'compact' : ''} ${entry.exitCode === 0 ? 'success' : entry.hasOutput ? 'failed' : 'pending'}`}>
      <div className="command-terminal-card-header">
        <div className="command-terminal-card-title">
          <Terminal size={13} />
          <span>{compact ? 'Terminal output' : entry.nodeLabel}</span>
        </div>
        <button
          type="button"
          className="command-terminal-copy"
          onClick={handleCopy}
          title="terminal output 복사"
          aria-label="terminal output 복사"
        >
          <Copy size={12} />
        </button>
      </div>
      <div className="command-terminal-meta">
        <code>{entry.commandId}</code>
        <span>exit {entry.exitCode ?? '-'}</span>
        <span>{entry.durationMs ?? '-'}ms</span>
        {entry.timedOut && <span>timeout</span>}
      </div>
      <div className="command-terminal-output">
        <div className="command-terminal-line prompt">$ {sanitizeTerminalText(entry.commandId)}</div>
        {entry.hasOutput ? (
          <>
            {entry.stdout && (
              <pre className="command-terminal-stream stdout">{sanitizedStdout}</pre>
            )}
            {entry.stderr && (
              <pre className="command-terminal-stream stderr">{sanitizedStderr}</pre>
            )}
            {!entry.stdout && !entry.stderr && (
              <div className="command-terminal-line muted">no stdout/stderr</div>
            )}
          </>
        ) : (
          <div className="command-terminal-line muted">
            command output is not available yet
          </div>
        )}
      </div>
      <div className="command-terminal-path">output: {entry.outputPath}</div>
    </article>
  );
};

const JsExecutionBlocks: React.FC<{ event: ExecutionEvent }> = ({ event }) => {
  const consoleEntries = Array.isArray(event.payload?.console) ? event.payload.console : [];
  const hasOutput = event.type === 'NODE_COMPLETED' && Object.prototype.hasOwnProperty.call(event.payload || {}, 'output');

  if (!hasOutput && consoleEntries.length === 0) {
    return null;
  }

  return (
    <div className="js-execution-blocks">
      {hasOutput && (
        <details className="js-output-block" open>
          <summary>Output JSON</summary>
          <pre>{JSON.stringify(sanitizeLogValue(event.payload.output), null, 2)}</pre>
        </details>
      )}
      {consoleEntries.length > 0 && (
        <div className="js-console-block">
          <div className="js-console-title">Console output</div>
          <div className="js-console-lines">
            {consoleEntries.map((entry: any, index: number) => (
              <div key={index} className={`js-console-line level-${String(entry.level || 'log').toLowerCase()}`}>
                <span className="js-console-level">{String(entry.level || 'log')}</span>
                <span className="js-console-message">{sanitizeTerminalText(String(entry.message || ''))}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

function isJsNodeEvent(event: ExecutionEvent) {
  return (
    (event.type === 'NODE_COMPLETED' || event.type === 'NODE_FAILED') &&
    event.payload?.script_type === 'javascript'
  );
}

function buildTerminalEntries(instanceDetail: any, events: ExecutionEvent[]): CommandTerminalEntry[] {
  const context = instanceDetail?.context || instanceDetail?.ctx || {};
  const runtimeNodes = context?.runtime?.nodes || [];
  const terminalNodes = new Map<string, any>();

  for (const node of runtimeNodes) {
    const nodeType = node?.data?.nodeType || node?.node_type || node?.type;
    const data = node?.data || node?.config || {};
    const pluginId = data.plugin_id || data.pluginId;
    if (nodeType === 'command' || (nodeType === 'service' && pluginId === 'builtin.ssh')) {
      terminalNodes.set(String(node.id || node.node_id), node);
    }
  }

  for (const event of events) {
    if (!event.node_id) continue;
    const commandId = event.payload?.command_id;
    if (commandId) {
      terminalNodes.set(event.node_id, terminalNodes.get(event.node_id) || {
        id: event.node_id,
        data: {
          label: event.node_label || event.node_id,
          nodeType: 'command',
          commandId,
          outputPath: event.payload?.output_path,
        },
      });
    }
  }

  return [...terminalNodes.values()].map((node) => {
    const nodeId = String(node.id || node.node_id);
    const data = node.data || node.config || {};
    const isSsh = (data.plugin_id || data.pluginId) === 'builtin.ssh';
    const completedEvent = [...events]
      .reverse()
      .find((event) => event.node_id === nodeId && event.type === 'NODE_COMPLETED' && (isSsh || event.payload?.command_id));
    const failedEvent = [...events]
      .reverse()
      .find((event) => event.node_id === nodeId && event.type === 'NODE_FAILED');
    const outputPath =
      completedEvent?.payload?.output_path ||
      data.outputPath ||
      data.output_path ||
      `${isSsh ? 'sshResults' : 'commandResults'}.${nodeId}`;
    const contextOutput = getContextValueAtPath(context, outputPath) || getContextValueAtPath(context, `data.outputs.${outputPath}`);
    const output = (isSsh ? completedEvent?.payload?.output : undefined) || contextOutput;
    const commandId =
      String(output?.command_id || completedEvent?.payload?.command_id || failedEvent?.payload?.command_id || data.command || data.commandId || data.command_id || 'command');

    return {
      nodeId,
      nodeLabel: String(data.label || node.label || completedEvent?.node_label || failedEvent?.node_label || nodeId),
      commandId,
      outputPath,
      exitCode: output?.exit_code ?? completedEvent?.payload?.exit_code ?? failedEvent?.payload?.exit_code,
      timedOut: Boolean(output?.timed_out ?? completedEvent?.payload?.timed_out ?? failedEvent?.payload?.timed_out),
      durationMs: output?.duration_ms ?? completedEvent?.payload?.duration_ms ?? failedEvent?.payload?.duration_ms,
      stdout: typeof output?.stdout === 'string' ? output.stdout : '',
      stderr: typeof output?.stderr === 'string' ? output.stderr : '',
      hasOutput: Boolean(output && typeof output === 'object'),
    };
  });
}

function getContextValueAtPath(context: any, path: string) {
  if (!context || !path) {
    return undefined;
  }

  return path
    .split('.')
    .filter(Boolean)
    .reduce((value, key) => {
      if (value === undefined || value === null) {
        return undefined;
      }
      return value[key];
    }, context);
}

const SECRET_FIELD_PATTERN = /(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|connection[_-]?uri|authorization|credential|passphrase)/i;
function sanitizeLogValue(value: any): any {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    return sanitizeTerminalText(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(item));
  }
  if (typeof value === 'object') {
    return Object.entries(value).reduce<Record<string, any>>((acc, [key, item]) => {
      acc[key] = SECRET_FIELD_PATTERN.test(key) ? '***' : sanitizeLogValue(item);
      return acc;
    }, {});
  }
  return String(value);
}
