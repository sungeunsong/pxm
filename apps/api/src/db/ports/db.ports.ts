export abstract class WorkflowRepositoryPort {
  abstract createDefinition(id: string, name: string, nodes: any[], edges: any[], metadata?: WorkflowDefinitionMetadata): Promise<void>;
  abstract listDefinitions(): Promise<any[]>;
  abstract getDefinition(id: string): Promise<any>;
  abstract getPublishedDefinition(id: string): Promise<any>;
  abstract setDefinitionLifecycle(id: string, lifecycle: WorkflowLifecycleUpdate): Promise<any>;
  abstract listDefinitionVersions(id: string): Promise<WorkflowDefinitionVersion[]>;
  abstract getDefinitionVersion(id: string, version: number): Promise<any>;
  abstract restoreDefinitionVersion(id: string, version: number, metadata?: WorkflowDefinitionMetadata): Promise<any>;
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
  lifecycle_status?: 'DRAFT' | 'PUBLISHED' | 'DISABLED';
  active_published_version?: number | null;
  published_at?: string | null;
  published_by?: string | null;
};

export type WorkflowLifecycleUpdate = {
  status: 'PUBLISHED' | 'DISABLED';
  active_published_version?: number | null;
  actor_id?: string | null;
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

export type IdempotentWorkflowStart = {
  key_hash: string;
  request_hash: string;
  expires_at: Date;
  instance: {
    id: string;
    definition_id: string;
    status: string;
    context: any;
    access?: WorkflowInstanceAccess;
  };
  token: {
    id: string;
    node_id: string;
    status: string;
  };
  job: {
    type: string;
    run_at: Date;
    payload: any;
  };
};

export type IdempotentWorkflowStartResult = {
  outcome: 'created' | 'replayed' | 'conflict';
  instance_id: string;
};

export type IdempotentInstanceCommand = {
  key_hash: string;
  request_hash: string;
  expires_at: Date;
  result: Record<string, any>;
  create_instances?: Array<{
    id: string;
    definition_id: string;
    status: string;
    context: any;
    access?: WorkflowInstanceAccess;
  }>;
  update_instances?: Array<{
    id: string;
    status?: string;
    context?: any;
    complete_jobs?: boolean;
    cancel_approvals?: boolean;
    paused?: boolean;
    paused_by?: string | null;
    pause_origin_instance_id?: string | null;
  }>;
  tokens?: Array<{
    id: string;
    instance_id: string;
    node_id: string;
    status: string;
  }>;
  jobs?: Array<{
    instance_id: string;
    token_id?: string | null;
    type: string;
    run_at: Date;
    payload: any;
  }>;
  events?: Array<{
    instance_id: string;
    event_type: string;
    payload: any;
  }>;
};

export type WorkflowInstanceMutation = Pick<
  IdempotentInstanceCommand,
  'create_instances' | 'update_instances' | 'tokens' | 'jobs' | 'events'
>;

export type IdempotentInstanceCommandResult = {
  outcome: 'created' | 'replayed' | 'conflict';
  result: Record<string, any>;
};

export type ExistingIdempotentInstanceCommandResult = {
  outcome: 'missing' | 'replayed' | 'conflict';
  result: Record<string, any>;
};

export abstract class WorkflowInstanceRepositoryPort {
  abstract createIdempotentStart(input: IdempotentWorkflowStart): Promise<IdempotentWorkflowStartResult>;
  abstract getIdempotentCommand(keyHash: string, requestHash: string): Promise<ExistingIdempotentInstanceCommandResult>;
  abstract executeIdempotentCommand(input: IdempotentInstanceCommand): Promise<IdempotentInstanceCommandResult>;
  abstract executeInstanceMutation(input: WorkflowInstanceMutation): Promise<void>;
  abstract createInstance(id: string, definitionId: string, status: string, ctx: any, access?: WorkflowInstanceAccess): Promise<void>;
  abstract listInstances(actor?: WorkflowHistoryActor): Promise<any[]>;
  abstract listChildInstances(parentInstanceId: string): Promise<any[]>;
  abstract getInstance(id: string): Promise<any>;
  abstract updateInstanceStatus(id: string, status: string): Promise<void>;
  abstract updateInstanceCtx(id: string, ctx: any): Promise<void>;
  abstract completeJobsForInstance(id: string): Promise<void>;
  abstract createToken(token: { id: string; instanceId: string; nodeId: string; status: string; parentTokenId?: string; scopeKey?: string }): Promise<void>;
  abstract createJob(job: { instanceId: string; tokenId?: string | null; type: string; runAt: Date; payload: any }): Promise<void>;
}

export abstract class WorkflowTaskRepositoryPort {
  abstract createTask(id: string, instanceId: string, nodeId: string, assignee: string, status: string, payload: any): Promise<void>;
  abstract listTasks(assignee: string): Promise<any[]>;
  abstract getTask(id: string): Promise<any>;
  abstract completeTask(command: CompleteWorkflowTaskCommand): Promise<CompleteWorkflowTaskResult>;
  abstract claimExternalApprovalTasks(owner: string, now: Date, claimUntil: Date, limit: number): Promise<ExternalApprovalClaim[]>;
  abstract setExternalApprovalDeliveryToken(taskId: string, owner: string, input: ExternalApprovalDeliveryToken): Promise<boolean>;
  abstract markExternalApprovalDelivery(
    taskId: string,
    owner: string,
    status: 'SENT' | 'FAILED',
    input: {
      sent_at?: string | null;
      retry_at?: string | null;
      error?: string | null;
    },
  ): Promise<void>;
  abstract requeueExternalApproval(taskId: string): Promise<boolean>;
  abstract findExternalApprovalByTokenHash(tokenHash: string): Promise<ExternalApprovalTask | null>;
  abstract setExternalApprovalOtp(taskId: string, tokenHash: string, input: ExternalApprovalOtp): Promise<boolean>;
  abstract incrementExternalApprovalOtpFailures(taskId: string, tokenHash: string): Promise<number>;
  abstract clearExternalApprovalOtp(taskId: string, tokenHash: string, otpHash: string): Promise<void>;
  abstract listTaskHistory(query: WorkflowTaskHistoryQuery): Promise<WorkflowTaskHistoryPage>;
  abstract getTaskHistoryItem(id: string): Promise<WorkflowTaskHistoryItem | null>;
  abstract fetchApprovalNotificationTasks(
    after: { created_at: string; id: string },
    limit: number,
  ): Promise<ApprovalNotificationTask[]>;
}

export type ApprovalNotificationTask = {
  id: string;
  instance_id: string;
  assignee: string;
  status: string;
  created_at: string;
  workflow_name: string | null;
  step_order: number | null;
  step_label: string | null;
  title: string;
  requester: string | null;
  source_url: string | null;
  email_hint: string | null;
};

export type WorkflowTaskHistoryQuery = {
  statuses?: Array<'OPEN' | 'APPROVED' | 'REJECTED' | 'CANCELED'>;
  workflow_id?: string;
  instance_id?: string;
  assignee?: string;
  approver_channel?: 'pxm_user' | 'external_email';
  from?: string;
  to?: string;
  group_ids?: string[];
  allowed_workflow_ids?: string[];
  cursor?: { created_at: string; id: string };
  limit: number;
};

export type WorkflowTaskHistoryItem = {
  task_id: string;
  instance_id: string;
  workflow_id: string | null;
  workflow_name: string | null;
  workflow_version: number | string | null;
  group_id: string | null;
  node_id: string;
  node_label: string | null;
  approval_request_id: string | null;
  approval_step_id: string | null;
  request_status: 'PENDING' | 'IN_PROGRESS' | 'APPROVED' | 'REJECTED' | 'CANCELED' | null;
  current_step_order: number | null;
  total_steps: number | null;
  step_order: number | null;
  step_mode: 'ALL' | 'ANY' | null;
  step_status: 'LOCKED' | 'OPEN' | 'APPROVED' | 'REJECTED' | 'CANCELED' | null;
  source_provider: string | null;
  external_request_id: string | null;
  external_revision: number | null;
  content_snapshot: Record<string, unknown> | null;
  approval_line_snapshot: Record<string, unknown> | null;
  status: 'OPEN' | 'APPROVED' | 'REJECTED' | 'CANCELED';
  approver_channel: 'pxm_user' | 'external_email';
  approval_channels: Array<'pxm_user' | 'external_email'>;
  assignee: string;
  action: 'approve' | 'reject' | null;
  comment: string | null;
  result: Record<string, unknown> | null;
  authentication_method: 'pxm_session' | 'api_key' | 'email_link' | 'email_otp' | null;
  completed_via: 'pxm_user' | 'external_email' | null;
  delivery_status: 'PENDING' | 'CLAIMED' | 'SENT' | 'FAILED' | null;
  delivery_attempt_count: number;
  delivery_last_error: string | null;
  link_expires_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type WorkflowTaskHistoryPage = {
  items: WorkflowTaskHistoryItem[];
  has_more: boolean;
};

export type ExternalApprovalClaim = {
  task_id: string;
  instance_id: string;
  email: string;
  require_otp: boolean;
  expires_in_hours: number;
  attempt_count: number;
  allows_pxm_user: boolean;
  title: string;
  requester: string | null;
  step_label: string | null;
  source_url: string | null;
};

export type ExternalApprovalDeliveryToken = {
  email: string;
  token_hash: string;
  token_expires_at: string;
  require_otp: boolean;
  attempt_count: number;
};

export type ExternalApprovalOtp = {
  otp_hash: string;
  otp_expires_at: string;
  otp_sent_at: string;
  otp_next_send_at: string;
};

export type ExternalApprovalTask = {
  id: string;
  instance_id: string;
  node_id: string;
  assignee: string;
  status: string;
  payload: {
    external_approval: {
      email?: string | null;
      token_hash?: string | null;
      token_expires_at?: string | null;
      require_otp?: boolean;
      consumed_at?: string | null;
      otp_hash?: string | null;
      otp_expires_at?: string | null;
      otp_attempts?: number;
    };
    [key: string]: unknown;
  };
};

export type CompleteWorkflowTaskCommand = {
  task_id: string;
  action: 'approve' | 'reject';
  status: 'APPROVED' | 'REJECTED';
  actor_id: string;
  api_key_id?: string | null;
  business_actor?: Record<string, any> | null;
  comment?: string | null;
  result?: Record<string, any> | null;
  idempotency_key?: string | null;
  authentication_method?:
    | 'pxm_session'
    | 'api_key'
    | 'email_link'
    | 'email_otp';
  external_approval?: {
    token_hash: string;
    email: string;
    auth_method: 'email_link' | 'email_otp';
  } | null;
};

export type CompleteWorkflowTaskResult = {
  outcome: 'completed' | 'idempotent' | 'already_completed' | 'not_found';
  task: any | null;
};

export type WebhookOutboxEvent = {
  id: string;
  instance_id: string;
  token_id: string | null;
  node_id: string | null;
  event_type:
    | 'APPROVAL_REQUEST_APPROVED'
    | 'APPROVAL_REQUEST_REJECTED'
    | 'APPROVAL_REQUEST_CANCELED';
  payload: Record<string, any>;
  created_at: string;
};

export abstract class OutboxRepositoryPort {
  abstract fetchAfter(instanceId: string, afterId: number, limit?: number): Promise<any[]>;

  abstract appendEvent(instanceId: string, eventType: string, payload: any): Promise<any>;

  abstract fetchTrace(instanceId: string, limit?: number): Promise<any[]>;

  abstract fetchWebhookEvents(
    afterId: string | null,
    limit?: number,
  ): Promise<WebhookOutboxEvent[]>;
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

  abstract getOperationsSnapshot(waitingThresholdMinutes: number, limit?: number): Promise<{
    jobs: Array<{
      id: string;
      instance_id: string;
      token_id: string | null;
      type: string;
      status: string;
      attempt: number;
      run_at: string;
      lock_owner: string | null;
      updated_at: string;
    }>;
    waiting_instances: Array<{
      id: string;
      state: string;
      updated_at: string;
      waiting_age_ms: number;
      classification: 'EXPECTED' | 'SUSPICIOUS';
      waiting_reason: 'OPEN_TASK' | 'SCHEDULED_JOB' | 'ACTIVE_CHILD' | 'NO_RESUME_SOURCE';
      open_task_count: number;
      scheduled_job_count: number;
      active_child_count: number;
    }>;
    expired_locks: Array<{
      instance_id: string;
      lock_owner: string;
      lock_until: string;
      heartbeat_at: string | null;
    }>;
  }>;

  abstract retryFailedJob(jobId: string): Promise<boolean>;

  abstract reclaimExpiredInstanceLock(instanceId: string): Promise<boolean>;
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
  abstract replaceDefinitionSchedules(definitionId: string, jobs: WorkflowScheduleJob[]): Promise<void>;

  abstract claimDueSchedules(now: Date, owner: string, limit: number): Promise<WorkflowScheduleJob[]>;

  abstract markScheduleSuccess(id: string, nextRunAt: Date, instanceId: string): Promise<void>;

  abstract markScheduleFailure(id: string, error: string, nextRunAt: Date): Promise<void>;

  abstract getDefinitionScheduleStatus(definitionId: string, limit?: number): Promise<WorkflowScheduleStatus>;
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
  abstract upsertInputPreset(workflowId: string, preset: UpsertWorkflowInputPreset): Promise<WorkflowInputPreset>;
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
  idle_timeout_minutes?: number;
  revoked_at?: string | null;
  revoke_reason?: string | null;
};

export type CreatePxmSession = Omit<PxmSession, 'created_at' | 'last_seen_at' | 'revoked_at' | 'revoke_reason'>;

export type PxmSessionSecurityPolicy = {
  idle_timeout_minutes: number;
  absolute_timeout_hours: number;
  updated_by?: string | null;
  updated_at: string;
};

export type UpsertPxmSessionSecurityPolicy = Pick<PxmSessionSecurityPolicy, 'idle_timeout_minutes' | 'absolute_timeout_hours'> & {
  updated_by: string;
};

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
  abstract revokeAllSessions(reason: string, exceptId?: string): Promise<number>;
  abstract listUserSessions(userId: string): Promise<PxmSession[]>;
  abstract getSessionSecurityPolicy(): Promise<PxmSessionSecurityPolicy | null>;
  abstract upsertSessionSecurityPolicy(policy: UpsertPxmSessionSecurityPolicy): Promise<PxmSessionSecurityPolicy>;
}
