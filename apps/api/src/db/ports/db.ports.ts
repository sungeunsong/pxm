export abstract class WorkflowRepositoryPort {
  abstract createDefinition(
    id: string,
    name: string,
    nodes: any[],
    edges: any[],
    metadata?: WorkflowDefinitionMetadata,
  ): Promise<void>;
  abstract listDefinitions(): Promise<any[]>;
  abstract getDefinition(id: string): Promise<any>;
  abstract listDefinitionVersions(id: string): Promise<WorkflowDefinitionVersion[]>;
  abstract getDefinitionVersion(id: string, version: number): Promise<any>;
  abstract restoreDefinitionVersion(
    id: string,
    version: number,
    metadata?: WorkflowDefinitionMetadata,
  ): Promise<any>;
  abstract deleteDefinition(id: string): Promise<boolean>;
}

export type WorkflowDefinitionMetadata = {
  description?: string;
  group?: string;
  tags?: string[];
  version_note?: string;
  imported_from?: WorkflowImportSourceMetadata;
};

export type WorkflowImportSourceMetadata = {
  schema_version: string;
  definition_id?: string;
  version?: number;
  exported_version_note?: string;
  exported_at?: string;
};

export type WorkflowDefinitionVersion = {
  definition_id: string;
  version: number;
  name: string;
  description?: string;
  group?: string;
  tags?: string[];
  version_note?: string;
  created_at?: string;
  updated_at?: string;
  node_count: number;
  edge_count: number;
};

export type WorkflowHistoryActor = {
  actor_type: 'user' | 'api_client';
  actor_id: string | null;
  roles: string[];
  workspace_ids: string[];
  owned_workflow_ids: string[];
  allowed_workflow_ids: string[];
  allowed_instance_ids: string[];
};

export type WorkflowInstanceAccess = {
  workspace_id?: string;
  requester_id?: string | null;
  client_id?: string | null;
  approver_ids?: string[];
};

export abstract class WorkflowInstanceRepositoryPort {
  abstract createInstance(
    id: string,
    definitionId: string,
    status: string,
    ctx: any,
    access?: WorkflowInstanceAccess,
  ): Promise<void>;
  abstract listInstances(actor?: WorkflowHistoryActor): Promise<any[]>;
  abstract listChildInstances(parentInstanceId: string): Promise<any[]>;
  abstract getInstance(id: string): Promise<any>;
  abstract updateInstanceStatus(id: string, status: string): Promise<void>;
  abstract updateInstanceCtx(id: string, ctx: any): Promise<void>;
  abstract completeJobsForInstance(id: string): Promise<void>;
  abstract createToken(token: {
    id: string;
    instanceId: string;
    nodeId: string;
    status: string;
    parentTokenId?: string;
    scopeKey?: string;
  }): Promise<void>;
  abstract createJob(job: {
    instanceId: string;
    tokenId?: string | null;
    type: string;
    runAt: Date;
    payload: any;
  }): Promise<void>;
}

export abstract class WorkflowTaskRepositoryPort {
  abstract createTask(
    id: string,
    instanceId: string,
    nodeId: string,
    assignee: string,
    status: string,
    payload: any,
  ): Promise<void>;
  abstract listTasks(assignee?: string): Promise<any[]>;
  abstract getTask(id: string): Promise<any>;
  abstract updateTaskStatus(id: string, status: string): Promise<void>;
}

export abstract class OutboxRepositoryPort {
  abstract fetchAfter(
    instanceId: string,
    afterId: number,
    limit?: number,
  ): Promise<any[]>;

  abstract appendEvent(
    instanceId: string,
    eventType: string,
    payload: any,
  ): Promise<any>;

  abstract fetchTrace(instanceId: string, limit?: number): Promise<any[]>;
}

export abstract class EngineQueueRepositoryPort {
  abstract getQueueStats(): Promise<{
    by_status: Record<string, number>;
    queued: number;
    running: number;
    failed: number;
    completed: number;
    oldest_queued_at: string | null;
    oldest_queued_age_ms: number | null;
    running_workers: Array<{
      worker_id: string;
      running_jobs: number;
      last_updated_at: string | null;
    }>;
    worker_heartbeats: Array<{
      worker_id: string;
      last_heartbeat_at: string | null;
      locked_instances: number;
    }>;
    max_attempt: number;
  }>;
}

export type WorkflowScheduleJob = {
  id: string;
  definitionId: string;
  definitionName: string;
  startNodeId: string;
  scheduleType: 'interval' | 'cron';
  intervalSeconds?: number | null;
  cronExpression?: string | null;
  input?: Record<string, any>;
  nextRunAt: Date;
  active: boolean;
  status?: string;
  lastRunAt?: string | null;
  lastInstanceId?: string | null;
  lastError?: string | null;
  updatedAt?: string | null;
  createdAt?: string | null;
};

export type WorkflowScheduleRun = {
  id: string;
  scheduleJobId: string;
  definitionId: string;
  instanceId?: string | null;
  scheduledFor: string;
  firedAt: string;
  status: 'STARTED' | 'FAILED';
  error?: string | null;
  createdAt: string;
};

export type WorkflowScheduleStatus = {
  job: WorkflowScheduleJob | null;
  runs: WorkflowScheduleRun[];
};

export abstract class WorkflowScheduleRepositoryPort {
  abstract replaceDefinitionSchedules(
    definitionId: string,
    jobs: WorkflowScheduleJob[],
  ): Promise<void>;

  abstract claimDueSchedules(
    now: Date,
    owner: string,
    limit: number,
  ): Promise<WorkflowScheduleJob[]>;

  abstract markScheduleSuccess(
    id: string,
    nextRunAt: Date,
    instanceId: string,
  ): Promise<void>;

  abstract markScheduleFailure(
    id: string,
    error: string,
    nextRunAt: Date,
  ): Promise<void>;

  abstract getDefinitionScheduleStatus(
    definitionId: string,
    limit?: number,
  ): Promise<WorkflowScheduleStatus>;
}

export type WorkflowInputPresetScope = 'private' | 'group' | 'public';

export type WorkflowInputPreset = {
  id: string;
  workflow_id: string;
  alias: string;
  name: string;
  description?: string;
  values: Record<string, any>;
  scope: WorkflowInputPresetScope;
  group_id?: string | null;
  enabled: boolean;
  created_by?: string | null;
  updated_by?: string | null;
  created_at: string;
  updated_at: string;
};

export type UpsertWorkflowInputPreset = {
  id?: string;
  alias?: string;
  name: string;
  description?: string;
  values: Record<string, any>;
  scope?: WorkflowInputPresetScope;
  group_id?: string | null;
  actor?: string | null;
};

export abstract class WorkflowInputPresetRepositoryPort {
  abstract listInputPresets(workflowId: string): Promise<WorkflowInputPreset[]>;
  abstract getInputPreset(workflowId: string, idOrAlias: string): Promise<WorkflowInputPreset | null>;
  abstract upsertInputPreset(
    workflowId: string,
    preset: UpsertWorkflowInputPreset,
  ): Promise<WorkflowInputPreset>;
  abstract deleteInputPreset(workflowId: string, presetId: string): Promise<boolean>;
}
