import { useState, useEffect, useRef, useCallback } from 'react';
import { type NodeStatus, type ExecutionEvent } from './types';

interface NodeState {
  status: NodeStatus;
  attempt?: number;
  error?: string;
  duration?: number;
}

interface WorkflowState {
  nodeStatuses: Record<string, NodeState>;
  activeEdge: { source: string; target: string } | null;
  events: ExecutionEvent[];
  instanceStatus: 'created' | 'running' | 'waiting' | 'completed' | 'failed';
}

// 노드 간 연결 관계 (엣지 애니메이션용)
const NODE_CONNECTIONS: Record<string, string> = {
  start: 'service_http',
  service_http: 'timer',
  timer: 'end',
};

export function useWorkflowState(instanceId: string) {
  const [state, setState] = useState<WorkflowState>({
    nodeStatuses: {},
    activeEdge: null,
    events: [],
    instanceStatus: 'created',
  });

  const eventSourceRef = useRef<EventSource | null>(null);
  const lastEventIdRef = useRef<string>('0');

  // 이벤트 처리
  const handleEvent = useCallback((eventType: string, data: any) => {
    const timestamp = data.created_at || new Date().toISOString();
    const payload = data.payload || data;

    // 실행 이벤트 추가
    const event: ExecutionEvent = {
      id: data.id || String(Date.now()),
      timestamp,
      eventType,
      nodeId: payload.node_id,
      details: {},
    };

    // 이벤트별 상세 정보 추출
    if (payload.retry_info) {
      event.details = { ...payload.retry_info };
      event.message = `Attempt ${payload.retry_info.attempt + 1}/${payload.retry_info.max_attempts}`;
    }
    if (payload.timer_info) {
      event.details = { ...payload.timer_info };
      event.message = `Duration: ${payload.timer_info.duration_ms}ms`;
    }
    if (payload.error) {
      event.message = typeof payload.error === 'string' ? payload.error : payload.error.message;
    }
    if (payload.status_code) {
      event.details = { ...event.details, status_code: payload.status_code };
    }

    setState((prev) => {
      const newState = { ...prev };
      newState.events = [...prev.events, event].slice(-100); // 최근 100개만 유지

      // 노드 상태 업데이트
      const nodeId = payload.node_id;

      switch (eventType) {
        case 'INSTANCE_CREATED':
          newState.instanceStatus = 'created';
          break;

        case 'INSTANCE_RUNNING':
          newState.instanceStatus = 'running';
          break;

        case 'INSTANCE_WAITING':
          newState.instanceStatus = 'waiting';
          break;

        case 'INSTANCE_COMPLETED':
          newState.instanceStatus = 'completed';
          // 모든 노드 completed로
          Object.keys(newState.nodeStatuses).forEach((id) => {
            if (newState.nodeStatuses[id].status !== 'failed') {
              newState.nodeStatuses[id] = { ...newState.nodeStatuses[id], status: 'completed' };
            }
          });
          newState.activeEdge = null;
          break;

        case 'INSTANCE_FAILED':
          newState.instanceStatus = 'failed';
          newState.activeEdge = null;
          break;

        case 'NODE_STARTED':
          if (nodeId) {
            const attempt = payload.attempt ?? 0;
            newState.nodeStatuses[nodeId] = {
              status: attempt > 0 ? 'retrying' : 'running',
              attempt,
            };
            // 이전 노드에서 현재 노드로 엣지 애니메이션
            const prevNode = Object.entries(NODE_CONNECTIONS).find(([_, next]) => next === nodeId)?.[0];
            if (prevNode) {
              newState.activeEdge = { source: prevNode, target: nodeId };
            }
          }
          break;

        case 'NODE_COMPLETED':
          if (nodeId) {
            newState.nodeStatuses[nodeId] = {
              ...newState.nodeStatuses[nodeId],
              status: 'completed',
            };
            // 다음 노드로 엣지 애니메이션 준비
            const nextNode = NODE_CONNECTIONS[nodeId];
            if (nextNode) {
              newState.activeEdge = { source: nodeId, target: nextNode };
              // 잠시 후 엣지 애니메이션 끄기
              setTimeout(() => {
                setState((s) => ({
                  ...s,
                  activeEdge: s.activeEdge?.source === nodeId ? null : s.activeEdge,
                }));
              }, 500);
            } else {
              newState.activeEdge = null;
            }
          }
          break;

        case 'NODE_FAILED':
          if (nodeId) {
            const isFinal = payload.final === true;
            newState.nodeStatuses[nodeId] = {
              status: isFinal ? 'failed' : 'retrying',
              attempt: payload.attempt,
              error: payload.error?.message || 'Failed',
            };
          }
          break;

        case 'RETRY_SCHEDULED':
          if (nodeId) {
            newState.nodeStatuses[nodeId] = {
              ...newState.nodeStatuses[nodeId],
              status: 'retrying',
              attempt: payload.attempt,
            };
          }
          break;

        case 'TIMER_SCHEDULED':
          if (nodeId) {
            newState.nodeStatuses[nodeId] = {
              status: 'waiting',
              duration: payload.duration_ms,
            };
          }
          break;
      }

      return newState;
    });
  }, []);

  // SSE 연결
  useEffect(() => {
    if (!instanceId) return;

    const url = `http://localhost:3000/instances/${instanceId}/stream`;
    const es = new EventSource(url);
    eventSourceRef.current = es;

    // 이벤트 타입 목록
    const eventTypes = [
      'INSTANCE_CREATED',
      'INSTANCE_RUNNING',
      'INSTANCE_WAITING',
      'INSTANCE_COMPLETED',
      'INSTANCE_FAILED',
      'NODE_STARTED',
      'NODE_COMPLETED',
      'NODE_FAILED',
      'RETRY_SCHEDULED',
      'TIMER_SCHEDULED',
      'TIMER_ESCALATED',
    ];

    // 각 이벤트 타입에 리스너 등록
    eventTypes.forEach((type) => {
      es.addEventListener(type, (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          lastEventIdRef.current = e.lastEventId || data.id;
          handleEvent(type, data);
        } catch (err) {
          console.error('Failed to parse event:', err);
        }
      });
    });

    // 일반 메시지
    es.onmessage = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        if (data.event_type) {
          handleEvent(data.event_type, data);
        }
      } catch {
        // ignore
      }
    };

    es.onerror = () => {
      console.log('SSE connection error, will retry...');
    };

    return () => {
      es.close();
    };
  }, [instanceId, handleEvent]);

  return state;
}
