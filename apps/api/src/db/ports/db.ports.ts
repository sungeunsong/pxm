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
  group_id?: string | null;
  tags?: string[];
  version_note?: string;
  imported_from?: WorkflowImportSourceMetadata;
  created_by?: string | null;
  updated_by?: string | null;
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
  group_id?: string | null;
  tags?: string[];
  version_note?: string;
  created_at?: string;
  updated_at?: string;
  node_count: number;
  edge_count: number;
  created_by?: string | null;
  updated_by?: string | null;
};

export type WorkflowHistoryActor = {
  actor_type: 'user' | 'service_account' | 'api_client';
  actor_id: string | null;
  roles: string[];
  scopes?: string[];
  workspace_ids: string[];
  group_ids?: string[];
  group_roles?: Record<string, 'group_manager' | 'user'>;
  owned_workflow_ids: string[];
  allowed_workflow_ids: string[];
  allowed_instance_ids: string[];
  api_key_id?: string | null;
  business_actor?: Record<string, any> | null;
};

export type WorkflowInstanceAccess = {
  workspace_id?: string;
  group_id?: string | null;
  requester_id?: string | null;
  client_id?: string | null;
  approver_ids?: string[];
  caller?: Record<string, any> | null;
  business_actor?: Record<string, any> | null;
  workflow_version_id?: string | null;
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

export type WorkflowInputPresetScope = 'private' | 'group' | 'shared';

export type WorkflowInputPreset = {
  id: string;
  workflow_id: string;
  alias: string;
  name: string;
  description?: string;
  values: Record<string, any>;
  scope: WorkflowInputPresetScope;
  group_id?: string | null;
  shared_group_ids: string[];
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
  shared_group_ids?: string[];
  actor?: string | null;
};

export abstract class WorkflowInputPresetRepositoryPort {
  abstract listAllInputPresets(): Promise<WorkflowInputPreset[]>;
  abstract listInputPresets(workflowId: string): Promise<WorkflowInputPreset[]>;
  abstract getInputPreset(workflowId: string, idOrAlias: string): Promise<WorkflowInputPreset | null>;
  abstract upsertInputPreset(
    workflowId: string,
    preset: UpsertWorkflowInputPreset,
  ): Promise<WorkflowInputPreset>;
  abstract deleteInputPreset(workflowId: string, presetId: string): Promise<boolean>;
}

export type PxmRole = 'admin' | 'group_manager' | 'user';
export type PxmGroupRole = Exclude<PxmRole, 'admin'>;
export type PxmGroupStatus = 'active' | 'deleted';
export type PxmPrincipalStatus = 'active' | 'disabled' | 'deleted';
export type PxmApiKeyOwnerType = 'USER' | 'SERVICE_ACCOUNT';
export type PxmApiKeyStatus = 'active' | 'disabled' | 'expired';
export type PxmApiKeyScope = 'workflow:read' | 'workflow:execute' | 'task:approve';

export type PxmGroup = {
  id: string;
  name: string;
  description?: string;
  status: PxmGroupStatus;
  created_by?: string | null;
  updated_by?: string | null;
  deleted_at?: string | null;
  created_at: string;
  updated_at: string;
};

export type PxmUser = {
  id: string;
  display_name: string;
  email?: string | null;
  role: PxmRole;
  group_ids: string[];
  memberships: PxmGroupMembership[];
  status: PxmPrincipalStatus;
  created_by?: string | null;
  updated_by?: string | null;
  created_at: string;
  updated_at: string;
};

export type PxmGroupMembership = {
  group_id: string;
  role: PxmGroupRole;
};

export type PxmServiceAccount = {
  id: string;
  name: string;
  group_id: string;
  description?: string;
  status: PxmPrincipalStatus;
  created_by?: string | null;
  updated_by?: string | null;
  created_at: string;
  updated_at: string;
};

export type PxmApiKey = {
  id: string;
  name: string;
  owner_type: PxmApiKeyOwnerType;
  owner_id: string;
  group_id: string;
  key_prefix: string;
  key_hash: string;
  scopes: PxmApiKeyScope[];
  allowed_workflow_ids: string[];
  ip_allowlist?: string[];
  rate_limit_per_minute?: number | null;
  status: PxmApiKeyStatus;
  expires_at?: string | null;
  last_used_at?: string | null;
  created_by?: string | null;
  disabled_at?: string | null;
  created_at: string;
  updated_at: string;
};

export type PxmApiKeyUsageLog = {
  id: string;
  api_key_id: string;
  owner_type: PxmApiKeyOwnerType;
  owner_id: string;
  group_id: string;
  endpoint: string;
  workflow_id?: string | null;
  instance_id?: string | null;
  request_id?: string | null;
  ip?: string | null;
  user_agent?: string | null;
  business_actor?: Record<string, any> | null;
  created_at: string;
};

export type UpsertPxmGroup = {
  id?: string;
  name: string;
  description?: string;
  actor?: string | null;
};

export type UpsertPxmUser = {
  id?: string;
  display_name: string;
  email?: string | null;
  role?: PxmRole;
  group_ids?: string[];
  memberships?: PxmGroupMembership[];
  status?: PxmPrincipalStatus;
  actor?: string | null;
  password_hash?: string;
};

export type UpsertPxmServiceAccount = {
  id?: string;
  name: string;
  group_id: string;
  description?: string;
  status?: PxmPrincipalStatus;
  actor?: string | null;
};

export type CreatePxmApiKey = {
  id?: string;
  name: string;
  owner_type: PxmApiKeyOwnerType;
  owner_id: string;
  group_id: string;
  key_prefix: string;
  key_hash: string;
  scopes: PxmApiKeyScope[];
  allowed_workflow_ids: string[];
  ip_allowlist?: string[];
  rate_limit_per_minute?: number | null;
  expires_at?: string | null;
  actor?: string | null;
};

export type AppendPxmApiKeyUsageLog = Omit<PxmApiKeyUsageLog, 'id' | 'created_at'> & {
  id?: string;
};

export type PxmSession = {
  id: string;
  token_hash: string;
  csrf_hash: string;
  user_id: string;
  ip?: string | null;
  user_agent?: string | null;
  created_at: string;
  last_seen_at: string;
  idle_expires_at: string;
  absolute_expires_at: string;
  revoked_at?: string | null;
  revoke_reason?: string | null;
};

export type CreatePxmSession = Omit<PxmSession, 'created_at' | 'last_seen_at' | 'revoked_at' | 'revoke_reason'>;

export abstract class AuthzRepositoryPort {
  abstract upsertGroup(group: UpsertPxmGroup): Promise<PxmGroup>;
  abstract listGroups(includeDeleted?: boolean): Promise<PxmGroup[]>;
  abstract getGroup(id: string): Promise<PxmGroup | null>;
  abstract softDeleteGroup(id: string, actor?: string | null): Promise<boolean>;
  abstract restoreGroup(id: string, actor?: string | null): Promise<boolean>;

  abstract upsertUser(user: UpsertPxmUser): Promise<PxmUser>;
  abstract listUsers(groupId?: string): Promise<PxmUser[]>;
  abstract getUser(id: string): Promise<PxmUser | null>;
  abstract getUserPasswordHash(id: string): Promise<string | null>;
  abstract updateUserPasswordHash(id: string, passwordHash: string, actor?: string | null): Promise<boolean>;
  abstract updateUserProfile(id: string, displayName: string, email?: string | null): Promise<PxmUser | null>;

  abstract upsertServiceAccount(account: UpsertPxmServiceAccount): Promise<PxmServiceAccount>;
  abstract listServiceAccounts(groupId?: string): Promise<PxmServiceAccount[]>;
  abstract getServiceAccount(id: string): Promise<PxmServiceAccount | null>;

  abstract createApiKey(key: CreatePxmApiKey): Promise<PxmApiKey>;
  abstract listApiKeys(groupId?: string): Promise<PxmApiKey[]>;
  abstract getApiKey(id: string): Promise<PxmApiKey | null>;
  abstract findApiKeyByHash(keyHash: string): Promise<PxmApiKey | null>;
  abstract disableApiKey(id: string, actor?: string | null): Promise<boolean>;
  abstract touchApiKey(id: string, usedAt: string): Promise<void>;
  abstract appendApiKeyUsageLog(log: AppendPxmApiKeyUsageLog): Promise<PxmApiKeyUsageLog>;
  abstract countApiKeyUsageSince(apiKeyId: string, since: string): Promise<number>;
  abstract createSession(session: CreatePxmSession): Promise<PxmSession>;
  abstract findSessionByTokenHash(tokenHash: string): Promise<PxmSession | null>;
  abstract touchSession(id: string, lastSeenAt: string, idleExpiresAt: string): Promise<void>;
  abstract revokeSession(id: string, reason: string): Promise<boolean>;
  abstract revokeUserSessions(userId: string, reason: string, exceptId?: string): Promise<number>;
  abstract listUserSessions(userId: string): Promise<PxmSession[]>;
}
