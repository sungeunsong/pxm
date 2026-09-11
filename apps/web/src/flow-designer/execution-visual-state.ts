import type { ExecutionNodeStatus } from './form-types';

export interface CanvasExecutionEvent {
  id?: string | number;
  type?: string;
  event_type?: string;
  node_id?: string;
  payload?: {
    node_id?: string;
    reason?: string;
    [key: string]: unknown;
  };
}

export function nodeExecutionTransition(event: CanvasExecutionEvent): {
  nodeId: string;
  status: ExecutionNodeStatus;
} | null {
  const type = event.type || event.event_type || '';
  const nodeId = event.node_id || event.payload?.node_id;
  if (!nodeId) return null;

  switch (type) {
    case 'NODE_STARTED':
      return { nodeId, status: 'running' };
    case 'NODE_COMPLETED':
      return { nodeId, status: 'completed' };
    case 'NODE_FAILED':
      return { nodeId, status: 'failed' };
    case 'TASK_CREATED':
    case 'TIMER_SCHEDULED':
    case 'NODE_WAITING':
    case 'INSTANCE_WAITING':
      return { nodeId, status: 'waiting' };
    default:
      return null;
  }
}

export function foldNodeExecutionStatuses(events: CanvasExecutionEvent[]) {
  const statuses: Record<string, ExecutionNodeStatus> = {};
  for (const event of events) {
    const transition = nodeExecutionTransition(event);
    if (transition) statuses[transition.nodeId] = transition.status;
  }
  return statuses;
}

export function latestNumericEventId(events: CanvasExecutionEvent[]) {
  return events.reduce((latest, event) => {
    const id = Number(event.id);
    return Number.isFinite(id) ? Math.max(latest, id) : latest;
  }, 0);
}
