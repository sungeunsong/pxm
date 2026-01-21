export type OutboxEventType =
  | "INSTANCE_CREATED"
  | "INSTANCE_RUNNING"
  | "INSTANCE_WAITING"
  | "INSTANCE_FAILED"
  | "INSTANCE_COMPLETED"
  | "NODE_STARTED"
  | "NODE_COMPLETED"
  | "NODE_FAILED"
  | "TASK_CREATED"
  | "TASK_COMPLETED"
  | "RETRY_SCHEDULED"
  | "TIMER_SCHEDULED";

export type RetryInfo = {
  attempt: number;
  next_run_at?: string; // ISO
  backoff_ms?: number;
};

export type OutboxEventPayload = {
  instance_id: string;
  token_id?: string;

  node_id?: string;
  from_node_id?: string;
  to_node_id?: string;
  edge_id?: string;

  status?: string;
  error_summary?: string;

  retry_info?: RetryInfo;

  timestamp: string; // ISO
};
