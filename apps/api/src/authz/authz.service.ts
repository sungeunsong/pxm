import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, Optional, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import {
  ApiKeyUsageQuery,
  ApprovalDelegation,
  AppendPxmApiKeyUsageLog,
  AuthzRepositoryPort,
  ExternalPrincipalMapping,
  ExternalPrincipalMappingStatus,
  ExternalPrincipalMappingView,
  PxmApiKey,
  PxmApiKeyScope,
  PxmGroup,
  PxmGroupMembership,
  PxmServiceAccount,
  PxmUser,
  WorkflowRepositoryPort,
  WorkflowInstanceRepositoryPort,
  WorkflowHistoryActor,
  WorkflowTaskRepositoryPort,
} from '../db/ports/db.ports';
import {
  ApiKeyResponseDto,
  CreateExternalPrincipalMappingDto,
  CreateApiKeyDto,
  CreateApprovalDelegationDto,
  CreatedApiKeyResponseDto,
  UpdateExternalPrincipalMappingDto,
  UpsertGroupDto,
  UpsertServiceAccountDto,
  UpsertUserDto,
} from './dto/authz.dto';
import { hashPassword } from './password';
import { isIP } from 'net';
import { SchedulesService } from '../schedules/schedules.service';
import { DbWatchService } from '../db-watch/db-watch.service';
import { ManagementAuditService } from '../audit/management-audit.service';
import { CredentialsService } from '../credentials/credentials.service';
import { assertCanManageGroup } from './management-auth';
import { ExternalApprovalMailer } from '../tasks/external-approval.mailer';

const API_KEY_PREFIX = 'pxm_live_';
const API_KEY_VISIBLE_PREFIX_LENGTH = 18;
const ALLOWED_API_KEY_SCOPES: PxmApiKeyScope[] = [
  'workflow:read',
  'workflow:execute',
  'task:approve',
];

@Injectable()
export class AuthzService {
  constructor(
    private readonly authzRepo: AuthzRepositoryPort,
    private readonly workflowRepo: WorkflowRepositoryPort,
    @Optional() private readonly instanceRepo?: WorkflowInstanceRepositoryPort,
    @Optional() private readonly schedulesService?: SchedulesService,
    @Optional() private readonly dbWatchService?: DbWatchService,
    @Optional() private readonly managementAudit?: ManagementAuditService,
    @Optional() private readonly credentialsService?: CredentialsService,
    @Optional() private readonly taskRepo?: WorkflowTaskRepositoryPort,
    @Optional() private readonly approvalMailer?: ExternalApprovalMailer,
  ) {}

  async upsertGroup(dto: UpsertGroupDto): Promise<PxmGroup> {
    if (!dto?.name?.trim()) {
      throw new BadRequestException('name is required');
    }
    return this.authzRepo.upsertGroup({
      id: optionalId(dto.id),
      name: dto.name.trim(),
      description: optionalString(dto.description) || '',
      actor: optionalString(dto.actor),
    });
  }

  async listGroups(includeDeleted = false): Promise<PxmGroup[]> {
    return this.authzRepo.listGroups(includeDeleted);
  }

  async getGroup(id: string): Promise<PxmGroup> {
    const group = await this.authzRepo.getGroup(id);
    if (!group) {
      throw new NotFoundException('Group not found');
    }
    return group;
  }

  async getGroupDeletionImpact(id: string) {
    const group = await this.getGroup(id);
    if (group.status === 'deleted') throw new NotFoundException('Active group not found');
    const workflowSummaries = (await this.workflowRepo.listDefinitions())
      .filter((workflow) => (workflow.group_id || workflow.metadata?.group_id) === id);
    const workflows = (await Promise.all(workflowSummaries.map((workflow) => this.workflowRepo.getDefinition(workflow.id))))
      .filter(Boolean);
    const nodes = workflows.flatMap((workflow) => workflow.nodes || []);
    const credentialIds = new Set<string>();
    for (const node of nodes) collectCredentialIds(node, credentialIds);
    const [apiKeys, serviceAccounts, externalMappings, users, workflowRecordIds, auditUsage, credentialUsage] = await Promise.all([
      this.authzRepo.listApiKeys(id),
      this.authzRepo.listServiceAccounts(id),
      this.authzRepo.listExternalPrincipalMappings({ group_id: id }),
      this.authzRepo.listUsers(id),
      this.authzRepo.listGroupWorkflowRecordIds(id),
      this.managementAudit?.summarizeGroupUsage(id) || Promise.resolve([]),
      this.credentialsService?.getGroupUsageEvidence(id) || Promise.resolve({ reference_count: 0, history_count: 0 }),
    ]);
    const definitionIds = [...new Set([...workflows.map((workflow) => workflow.id), ...workflowRecordIds])];
    const workflowRecordCount = workflowRecordIds.length;
    const runtime = this.instanceRepo
      ? await this.instanceRepo.getGroupDeletionRuntimeImpact(definitionIds)
      : { active_instance_count: 0, active_instance_ids: [], open_approval_count: 0 };
    const usageReasons = [
      ...(workflowRecordCount > 0 ? [{ code: 'workflow_history', label: '워크플로우 생성 이력', count: workflowRecordCount }] : []),
      ...(apiKeys.length > 0 ? [{ code: 'api_key_history', label: 'API Key 발급 이력', count: apiKeys.length }] : []),
      ...(serviceAccounts.length > 0 ? [{ code: 'service_account_history', label: '서비스 계정 이력', count: serviceAccounts.length }] : []),
      ...(externalMappings.length > 0 ? [{ code: 'external_mapping_history', label: '외부 승인자 매핑 이력', count: externalMappings.length }] : []),
      ...(users.length > 0 ? [{ code: 'membership', label: '현재 소속 사용자', count: users.length }] : []),
      ...(credentialUsage.reference_count > 0 ? [{ code: 'credential_reference', label: 'Credential 연결', count: credentialUsage.reference_count }] : []),
      ...(credentialUsage.history_count > 0 ? [{ code: 'credential_history', label: 'Credential 사용 이력', count: credentialUsage.history_count }] : []),
      ...(auditUsage.length > 0 ? [{ code: 'management_history', label: '과거 관리·사용 이력', count: auditUsage.reduce((sum, row) => sum + row.count, 0) }] : []),
    ];
    const deletionMode = runtime.active_instance_count > 0
      ? 'blocked'
      : usageReasons.length === 0
        ? 'permanent'
        : 'recoverable';
    return {
      group: { id: group.id, name: group.name },
      workflows: workflows.map((workflow) => ({ id: workflow.id, name: workflow.name, lifecycle_status: workflow.lifecycle_status || workflow.metadata?.lifecycle_status || 'DRAFT' })),
      active_instance_count: runtime.active_instance_count,
      active_instance_ids: runtime.active_instance_ids,
      open_approval_count: runtime.open_approval_count,
      schedule_trigger_count: nodes.filter((node) => node?.data?.nodeType === 'start' && node?.data?.triggerType === 'schedule').length,
      db_watch_trigger_count: nodes.filter((node) => node?.data?.nodeType === 'start' && node?.data?.triggerType === 'db_watch').length,
      referenced_credential_ids: [...credentialIds],
      api_key_count: apiKeys.length,
      active_api_key_count: apiKeys.filter((key) => key.status === 'active').length,
      service_account_count: serviceAccounts.length,
      external_mapping_count: externalMappings.length,
      member_count: users.length,
      usage_history_reasons: usageReasons,
      deletion_mode: deletionMode,
      permanent_deletion_allowed: deletionMode === 'permanent',
      deletion_blocked: runtime.active_instance_count > 0,
    };
  }

  async deleteGroup(id: string, actor?: string | null) {
    const currentGroup = await this.authzRepo.getGroup(id);
    if (!currentGroup) throw new NotFoundException('Group not found');
    if (currentGroup.status === 'deleted') return { success: true as const, already_deleted: true, impact: null };
    const impact = await this.getGroupDeletionImpact(id);
    if (impact.deletion_blocked) {
      throw new ConflictException({
        message: 'Group has active workflow instances',
        code: 'GROUP_HAS_ACTIVE_INSTANCES',
        impact,
      });
    }
    if (impact.deletion_mode === 'permanent') {
      const deleted = await this.authzRepo.hardDeleteGroup(id);
      if (!deleted) throw new ConflictException('Group changed while checking deletion impact');
      return { success: true as const, already_deleted: false, deletion_mode: 'permanent' as const, impact };
    }
    for (const workflow of impact.workflows) {
      await this.schedulesService?.syncDefinitionSchedules(workflow.id, workflow.name, []);
      await this.dbWatchService?.syncDefinitionWatchJobs(workflow.id, workflow.name, []);
    }
    const deleted = await this.authzRepo.softDeleteGroup(id, actor);
    if (!deleted) {
      const racedGroup = await this.authzRepo.getGroup(id);
      if (racedGroup?.status === 'deleted') return { success: true as const, already_deleted: true, impact: null };
      throw new NotFoundException('Group not found');
    }
    return { success: true as const, already_deleted: false, deletion_mode: 'recoverable' as const, impact };
  }

  async restoreGroup(id: string, actor?: string | null) {
    const currentGroup = await this.authzRepo.getGroup(id);
    if (!currentGroup) throw new NotFoundException('Group not found');
    if (currentGroup.status === 'active') return { success: true as const, already_active: true };
    const restored = await this.authzRepo.restoreGroup(id, actor);
    if (!restored) {
      throw new NotFoundException('Deleted group not found');
    }
    return { success: true as const, already_active: false };
  }

  async completeGroupRecoveryReview(id: string, actor?: string | null) {
    const group = await this.getGroup(id);
    if (group.status !== 'active') throw new ConflictException('Deleted group must be restored first');
    const completed = await this.authzRepo.completeGroupRecoveryReview(id, actor);
    if (!completed) throw new NotFoundException('Group not found');
    return { success: true as const };
  }

  async upsertUser(dto: UpsertUserDto): Promise<PxmUser> {
    if (!dto?.display_name?.trim()) {
      throw new BadRequestException('display_name is required');
    }
    const existing = dto.id ? await this.authzRepo.getUser(dto.id.trim()) : null;
    const role = dto.role || existing?.role || 'user';
    if (!['admin', 'group_manager', 'user'].includes(role)) {
      throw new BadRequestException('role is invalid');
    }
    const requestedMemberships = dto.memberships === undefined
      ? normalizeStringArray(dto.group_ids).map((group_id) => ({
          group_id,
          role: role === 'group_manager' ? 'group_manager' as const : 'user' as const,
        }))
      : normalizeMemberships(dto.memberships);
    const memberships = dto.memberships === undefined
      ? requestedMemberships
      : mergeMemberships(existing?.memberships || [], requestedMemberships);
    const groupIds = memberships.map((membership) => membership.group_id);
    const effectiveRole = role === 'admin' || (dto.memberships !== undefined && existing?.role === 'admin')
      ? 'admin'
      : memberships.some((membership) => membership.role === 'group_manager')
        ? 'group_manager'
        : 'user';
    if (dto.password !== undefined && dto.password.length < 8) {
      throw new BadRequestException('password must be at least 8 characters');
    }
    await this.assertGroupsExist(groupIds);
    return this.authzRepo.upsertUser({
      id: optionalId(dto.id),
      display_name: dto.display_name.trim(),
      email: optionalString(dto.email),
      role: effectiveRole,
      group_ids: groupIds,
      memberships,
      status: normalizePrincipalStatus(dto.status),
      actor: optionalString(dto.actor),
      password_hash: dto.password ? await hashPassword(dto.password) : undefined,
    });
  }

  async createUser(dto: UpsertUserDto): Promise<PxmUser> {
    if (dto.id && await this.authzRepo.getUser(dto.id.trim())) {
      throw new ConflictException('User ID already exists');
    }
    return this.upsertUser(dto);
  }

  async listUsers(groupId?: string): Promise<PxmUser[]> {
    return this.authzRepo.listUsers(optionalString(groupId) || undefined);
  }

  async listApprovalDelegationCandidates(groupId: string, actor: WorkflowHistoryActor): Promise<PxmUser[]> {
    this.assertDelegationGroupAccess(groupId, actor);
    return (await this.authzRepo.listUsers(groupId)).filter((user) => user.status === 'active');
  }

  async listApprovalDelegations(groupId: string | undefined, actor: WorkflowHistoryActor): Promise<ApprovalDelegation[]> {
    if (!actor.actor_id || actor.api_key_id) throw new ForbiddenException('PXM user session is required');
    if (groupId) this.assertDelegationGroupAccess(groupId, actor);
    const rows = await this.authzRepo.listApprovalDelegations(groupId ? { group_id: groupId } : {});
    if (actor.roles.includes('admin')) return rows;
    const managed = new Set((actor.group_ids || []).filter((id) => actor.group_roles?.[id] === 'group_manager'));
    return rows.filter((row) => managed.has(row.group_id) || row.delegator_id === actor.actor_id || row.delegate_id === actor.actor_id);
  }

  async createApprovalDelegation(dto: CreateApprovalDelegationDto, actor: WorkflowHistoryActor) {
    if (!actor.actor_id || actor.api_key_id) throw new ForbiddenException('PXM user session is required');
    this.assertDelegationGroupAccess(dto.group_id, actor);
    const delegatorId = dto.delegator_id?.trim() || actor.actor_id;
    const actingForAnother = delegatorId !== actor.actor_id;
    if (actingForAnother) {
      assertCanManageGroup(actor, dto.group_id);
      if (!dto.reason?.trim()) throw new BadRequestException('reason is required when configuring delegation for another user');
    }
    if (delegatorId === dto.delegate_id) throw new BadRequestException('delegate must be a different user');
    const [group, delegator, delegate] = await Promise.all([
      this.authzRepo.getGroup(dto.group_id), this.authzRepo.getUser(delegatorId), this.authzRepo.getUser(dto.delegate_id),
    ]);
    if (!group || group.status !== 'active') throw new BadRequestException('Active group is required');
    for (const [label, user] of [['delegator', delegator], ['delegate', delegate]] as const) {
      if (!user || user.status !== 'active' || !user.group_ids.includes(dto.group_id)) {
        throw new BadRequestException(`${label} must be an active PXM user in the same group`);
      }
    }
    const startsAt = new Date(dto.starts_at); const endsAt = new Date(dto.ends_at);
    if (!(startsAt < endsAt) || endsAt <= new Date()) throw new BadRequestException('ends_at must be later than starts_at and in the future');
    const workflowIds = [...new Set((dto.workflow_ids || []).map((id) => id.trim()).filter(Boolean))];
    if (dto.scope === 'selected') {
      if (!workflowIds.length) throw new BadRequestException('workflow_ids is required for selected scope');
      const allowed = new Set(await this.authzRepo.listGroupWorkflowRecordIds(dto.group_id));
      if (workflowIds.some((id) => !allowed.has(id))) throw new BadRequestException('workflow_ids must belong to the selected group');
    }
    const existing = await this.authzRepo.listApprovalDelegations({ group_id: dto.group_id, delegator_id: delegatorId });
    if (existing.some((row) => row.status === 'active' && new Date(row.starts_at) < endsAt && new Date(row.ends_at) > startsAt)) {
      throw new ConflictException('An overlapping delegation already exists for this user and group');
    }
    const delegation = await this.authzRepo.createApprovalDelegation({
      group_id: dto.group_id, delegator_id: delegatorId, delegate_id: dto.delegate_id,
      scope: dto.scope, workflow_ids: dto.scope === 'selected' ? workflowIds : [], include_existing: dto.include_existing,
      starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(), reason: dto.reason?.trim() || null,
      created_by: actor.actor_id,
    });
    const currentOpenCount = dto.include_existing
      ? (await this.previewApprovalDelegation(dto.group_id, delegatorId, dto.scope, workflowIds, actor)).current_open_task_count
      : 0;
    if (delegator?.email && this.approvalMailer) {
      await this.approvalMailer.sendDelegationNotification({ to: delegator.email, delegatorName: delegator.display_name, delegateName: delegate!.display_name, startsAt: delegation.starts_at, endsAt: delegation.ends_at }).catch(() => undefined);
    }
    return { ...delegation, current_open_task_count: currentOpenCount };
  }

  async revokeApprovalDelegation(id: string, actor: WorkflowHistoryActor): Promise<ApprovalDelegation> {
    if (!actor.actor_id || actor.api_key_id) throw new ForbiddenException('PXM user session is required');
    const delegation = (await this.authzRepo.listApprovalDelegations()).find((item) => item.id === id);
    if (!delegation) throw new NotFoundException('Delegation not found');
    if (delegation.delegator_id !== actor.actor_id) assertCanManageGroup(actor, delegation.group_id);
    const revoked = await this.authzRepo.revokeApprovalDelegation(id, actor.actor_id);
    if (!revoked) throw new ConflictException('Delegation is already revoked');
    const [delegator, delegate] = await Promise.all([this.authzRepo.getUser(revoked.delegator_id), this.authzRepo.getUser(revoked.delegate_id)]);
    if (delegator?.email && this.approvalMailer) {
      await this.approvalMailer.sendDelegationNotification({ to: delegator.email, delegatorName: delegator.display_name, delegateName: delegate?.display_name || revoked.delegate_id, startsAt: revoked.starts_at, endsAt: revoked.ends_at, revoked: true }).catch(() => undefined);
    }
    return revoked;
  }

  async previewApprovalDelegation(groupId: string, delegatorId: string, scope: 'all' | 'selected', workflowIds: string[], actor: WorkflowHistoryActor) {
    this.assertDelegationGroupAccess(groupId, actor);
    if (delegatorId !== actor.actor_id) assertCanManageGroup(actor, groupId);
    const open = await this.taskRepo?.listTasks(delegatorId) || [];
    let count = 0;
    for (const task of open) {
      if (task.status !== 'OPEN' || task.payload?.approval_delegation_allowed === false) continue;
      const instance = await this.instanceRepo?.getInstance(task.instance_id);
      const taskGroupId = instance?.group_id || instance?.context?.runtime?.access?.group_id || instance?.ctx?.runtime?.access?.group_id;
      const workflowId = String(instance?.definition_id || instance?.process_definition_id || '');
      if (taskGroupId === groupId && (scope === 'all' || workflowIds.includes(workflowId))) count += 1;
    }
    return { current_open_task_count: count };
  }

  private assertDelegationGroupAccess(groupId: string, actor: WorkflowHistoryActor) {
    if (!actor.actor_id || actor.api_key_id) throw new ForbiddenException('PXM user session is required');
    if (actor.roles.includes('admin')) return;
    if (!(actor.group_ids || []).includes(groupId)) throw new ForbiddenException('Group access is required');
  }

  async setUserMembership(
    userId: string,
    groupId: string,
    role: 'group_manager' | 'user',
    actor?: string | null,
  ): Promise<PxmUser> {
    const user = await this.getUser(userId);
    await this.assertGroupsExist([groupId]);
    const memberships = mergeMemberships(user.memberships || [], [{ group_id: groupId, role }]);
    return this.saveMemberships(user, memberships, actor);
  }

  async removeUserMembership(
    userId: string,
    groupId: string,
    actor?: string | null,
  ): Promise<PxmUser> {
    const user = await this.getUser(userId);
    const memberships = (user.memberships || []).filter((membership) => membership.group_id !== groupId);
    if (memberships.length === (user.memberships || []).length) {
      throw new NotFoundException('User is not a member of the group');
    }
    return this.saveMemberships(user, memberships, actor);
  }

  async getUser(id: string): Promise<PxmUser> {
    const user = await this.authzRepo.getUser(id);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  private saveMemberships(
    user: PxmUser,
    memberships: PxmGroupMembership[],
    actor?: string | null,
  ): Promise<PxmUser> {
    const role = user.role === 'admin'
      ? 'admin'
      : memberships.some((membership) => membership.role === 'group_manager')
        ? 'group_manager'
        : 'user';
    return this.authzRepo.upsertUser({
      id: user.id,
      display_name: user.display_name,
      email: user.email,
      role,
      group_ids: memberships.map((membership) => membership.group_id),
      memberships,
      status: user.status,
      actor,
    });
  }

  async listExternalPrincipalMappings(query: {
    provider?: string;
    subject?: string;
    group_id?: string;
    status?: ExternalPrincipalMappingStatus;
  } = {}): Promise<ExternalPrincipalMappingView[]> {
    if (query.status && query.status !== 'active' && query.status !== 'disabled') {
      throw new BadRequestException('status is invalid');
    }
    const mappings = await this.authzRepo.listExternalPrincipalMappings({
      provider: optionalString(query.provider) || undefined,
      subject: optionalString(query.subject) || undefined,
      group_id: optionalString(query.group_id) || undefined,
      status: query.status,
    });
    return Promise.all(mappings.map((mapping) => this.externalPrincipalMappingView(mapping)));
  }

  async getExternalPrincipalMapping(id: string): Promise<ExternalPrincipalMappingView> {
    const mapping = await this.authzRepo.getExternalPrincipalMapping(id);
    if (!mapping) throw new NotFoundException('External principal mapping not found');
    return this.externalPrincipalMappingView(mapping);
  }

  async createExternalPrincipalMapping(
    dto: CreateExternalPrincipalMappingDto,
    actor?: string | null,
  ): Promise<ExternalPrincipalMappingView> {
    const provider = normalizeExternalProvider(dto.provider);
    const subject = normalizeExternalSubject(dto.subject);
    const groupId = requireString(dto.group_id, 'group_id');
    const userId = requireString(dto.pxm_user_id, 'pxm_user_id');
    await this.assertMappingTarget(groupId, userId);
    if (await this.authzRepo.findExternalPrincipalMapping(provider, subject)) {
      throw new ConflictException('External principal mapping already exists');
    }
    try {
      const mapping = await this.authzRepo.createExternalPrincipalMapping({
        provider,
        subject,
        group_id: groupId,
        pxm_user_id: userId,
        display_name: optionalString(dto.display_name),
        email: normalizeOptionalEmail(dto.email),
        department: optionalString(dto.department),
        actor: optionalString(actor),
      });
      return this.externalPrincipalMappingView(mapping);
    } catch (error: any) {
      if (isDuplicateKeyError(error)) {
        throw new ConflictException('External principal mapping already exists');
      }
      throw error;
    }
  }

  async updateExternalPrincipalMapping(
    id: string,
    dto: UpdateExternalPrincipalMappingDto,
    actor?: string | null,
  ): Promise<ExternalPrincipalMappingView> {
    await this.getExternalPrincipalMapping(id);
    const groupId = requireString(dto.group_id, 'group_id');
    const userId = requireString(dto.pxm_user_id, 'pxm_user_id');
    await this.assertMappingTarget(groupId, userId);
    const mapping = await this.authzRepo.updateExternalPrincipalMapping(id, {
      group_id: groupId,
      pxm_user_id: userId,
      display_name: optionalString(dto.display_name),
      email: normalizeOptionalEmail(dto.email),
      department: optionalString(dto.department),
      actor: optionalString(actor),
    });
    if (!mapping) throw new NotFoundException('External principal mapping not found');
    return this.externalPrincipalMappingView(mapping);
  }

  async setExternalPrincipalMappingStatus(
    id: string,
    status: ExternalPrincipalMappingStatus,
    actor?: string | null,
  ): Promise<ExternalPrincipalMappingView> {
    if (status !== 'active' && status !== 'disabled') {
      throw new BadRequestException('status is invalid');
    }
    const current = await this.getExternalPrincipalMapping(id);
    if (status === 'active') await this.assertMappingTarget(current.group_id, current.pxm_user_id);
    const mapping = await this.authzRepo.setExternalPrincipalMappingStatus(id, status, actor);
    if (!mapping) throw new NotFoundException('External principal mapping not found');
    return this.externalPrincipalMappingView(mapping);
  }

  async resolveExternalApprovalPrincipals(
    formData: Record<string, any>,
    requestPath: string,
    groupId?: string | null,
    nodes: any[] = [],
  ): Promise<void> {
    const request = valueAtPath(formData, requestPath);
    if (!request || typeof request !== 'object' || Array.isArray(request)) return;
    const steps = request.approval_line?.steps;
    if (!Array.isArray(steps)) return;
    const normalizedGroupId = optionalString(groupId);
    const defaultChannels = defaultApprovalChannels(nodes, requestPath);

    for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
      const step = steps[stepIndex];
      if (!step || typeof step !== 'object' || Array.isArray(step)) continue;
      const approvers = Array.isArray(step.approvers) ? step.approvers : [step];
      for (let approverIndex = 0; approverIndex < approvers.length; approverIndex += 1) {
        const approver = approvers[approverIndex];
        const location = `approval step ${stepIndex + 1} approver ${approverIndex + 1}`;
        if (!approver || typeof approver !== 'object' || Array.isArray(approver)) {
          throw new BadRequestException(`${location} must be an object`);
        }
        const channels = normalizeApprovalChannels(approver, defaultChannels, location);
        const allowsPxm = channels.includes('pxm_user');
        const allowsEmail = channels.includes('external_email');
        const rawProvider = optionalString(approver.principal?.provider)
          || (allowsPxm ? 'pxm' : 'email');
        const provider = normalizeExternalProvider(rawProvider);
        const subject = normalizeExternalSubject(
          optionalString(approver.principal?.subject) || optionalString(approver.assignee),
          `${location} principal.subject`,
        );
        const mapping = provider === 'pxm'
          ? null
          : await this.authzRepo.findExternalPrincipalMapping(provider, subject);
        const explicitUserId = optionalString(approver.pxm_user_id);
        let targetUser: PxmUser | null = null;
        let pxmUserId = explicitUserId || (provider === 'pxm' ? subject : null);

        if (allowsPxm) {
          if (!normalizedGroupId) {
            throw new BadRequestException(`${location} cannot use pxm_user without a workflow group`);
          }
          if (mapping) {
            if (mapping.status !== 'active') {
              throw new BadRequestException(`${location} external principal mapping is disabled`);
            }
            if (mapping.group_id !== normalizedGroupId) {
              throw new BadRequestException(`${location} external principal mapping belongs to another group`);
            }
            if (explicitUserId && explicitUserId !== mapping.pxm_user_id) {
              throw new BadRequestException(`${location} pxm_user_id conflicts with the registered mapping`);
            }
            pxmUserId = mapping.pxm_user_id;
          }
          if (!pxmUserId) {
            throw new BadRequestException(`${location} requires an active external principal mapping for pxm_user`);
          }
          targetUser = await this.authzRepo.getUser(pxmUserId);
          assertActiveGroupUser(targetUser, normalizedGroupId, location);
          approver.pxm_user_id = pxmUserId;
        } else if (pxmUserId) {
          targetUser = await this.authzRepo.getUser(pxmUserId);
        } else if (mapping?.status === 'active' && mapping.group_id === normalizedGroupId) {
          targetUser = await this.authzRepo.getUser(mapping.pxm_user_id);
        }
        const usableTargetUser = Boolean(
          targetUser?.status === 'active'
          && normalizedGroupId
          && (targetUser.role === 'admin' || targetUser.group_ids.includes(normalizedGroupId)),
        );

        const email = resolveDeliveryEmail([
          approver.delivery?.email,
          approver.display?.email,
          approver.email,
          mapping?.status === 'active' && mapping.group_id === normalizedGroupId ? mapping.email : null,
          usableTargetUser ? targetUser?.email : null,
          provider === 'email' || subject.includes('@') ? subject : null,
        ], location);
        if (allowsEmail && !email) {
          throw new BadRequestException(`${location} requires a valid external email`);
        }
        if (allowsEmail) approver.delivery = { ...(approver.delivery || {}), email };

        approver.principal = { ...(approver.principal || {}), provider, subject };
        approver.approval_channels = channels;
        if (mapping && mapping.status === 'active' && mapping.group_id === normalizedGroupId) {
          approver.principal_mapping = {
            id: mapping.id,
            provider: mapping.provider,
            subject: mapping.subject,
            group_id: mapping.group_id,
            pxm_user_id: mapping.pxm_user_id,
            status: mapping.status,
            version: mapping.version,
            updated_at: mapping.updated_at,
          };
        }
        const currentDisplay = approver.display && typeof approver.display === 'object'
          ? approver.display
          : {};
        approver.display = {
          ...currentDisplay,
          name: optionalString(currentDisplay.name) || mapping?.display_name || targetUser?.display_name || null,
          email: optionalString(currentDisplay.email) || email || null,
          department: optionalString(currentDisplay.department) || mapping?.department || null,
        };
      }
    }
  }

  async upsertServiceAccount(dto: UpsertServiceAccountDto): Promise<PxmServiceAccount> {
    if (!dto?.name?.trim()) {
      throw new BadRequestException('name is required');
    }
    if (!dto.group_id?.trim()) {
      throw new BadRequestException('group_id is required');
    }
    await this.assertGroupsExist([dto.group_id]);
    return this.authzRepo.upsertServiceAccount({
      id: optionalId(dto.id),
      name: dto.name.trim(),
      group_id: dto.group_id.trim(),
      description: optionalString(dto.description) || '',
      status: normalizePrincipalStatus(dto.status),
      actor: optionalString(dto.actor),
    });
  }

  async listServiceAccounts(groupId?: string): Promise<PxmServiceAccount[]> {
    return this.authzRepo.listServiceAccounts(optionalString(groupId) || undefined);
  }

  async getServiceAccount(id: string): Promise<PxmServiceAccount> {
    const account = await this.authzRepo.getServiceAccount(id);
    if (!account) {
      throw new NotFoundException('Service account not found');
    }
    return account;
  }

  async createApiKey(dto: CreateApiKeyDto): Promise<CreatedApiKeyResponseDto> {
    if (!dto?.name?.trim()) {
      throw new BadRequestException('name is required');
    }
    if (!dto.owner_id?.trim()) {
      throw new BadRequestException('owner_id is required');
    }
    if (!dto.group_id?.trim()) {
      throw new BadRequestException('group_id is required');
    }
    if (!['USER', 'SERVICE_ACCOUNT'].includes(dto.owner_type)) {
      throw new BadRequestException('owner_type is invalid');
    }
    if (!['all_in_group', 'allowlist'].includes(dto.workflow_access)) {
      throw new BadRequestException('workflow_access is required');
    }

    const group = await this.getGroup(dto.group_id.trim());
    if (group.status !== 'active') {
      throw new BadRequestException('group is not active');
    }

    const scopes = normalizeScopes(dto.scopes);
    await this.assertOwnerCanReceiveKey(dto.owner_type, dto.owner_id.trim(), dto.group_id.trim(), scopes);

    const rawKey = `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
    const allowedWorkflowIds = normalizeStringArray(dto.allowed_workflow_ids);
    if (dto.workflow_access === 'all_in_group' && allowedWorkflowIds.length > 0) {
      throw new BadRequestException('allowed_workflow_ids must be empty when workflow_access is all_in_group');
    }
    for (const workflowId of allowedWorkflowIds) {
      const workflow = await this.workflowRepo.getDefinition(workflowId);
      if (!workflow || (workflow.group_id || workflow.metadata?.group_id) !== dto.group_id.trim()) {
        throw new BadRequestException(`allowed workflow is not in the API key group: ${workflowId}`);
      }
    }

    const key = await this.authzRepo.createApiKey({
      id: optionalId(dto.id),
      name: dto.name.trim(),
      owner_type: dto.owner_type,
      owner_id: dto.owner_id.trim(),
      group_id: dto.group_id.trim(),
      key_prefix: rawKey.slice(0, API_KEY_VISIBLE_PREFIX_LENGTH),
      key_hash: hashApiKey(rawKey),
      scopes,
      workflow_access: dto.workflow_access,
      allowed_workflow_ids: allowedWorkflowIds,
      ip_allowlist: normalizeIpAllowlist(dto.ip_allowlist),
      rate_limit_per_minute: normalizeRateLimit(dto.rate_limit_per_minute),
      expires_at: normalizeExpiresAt(dto.expires_at),
      actor: optionalString(dto.actor),
    });

    return {
      ...mapApiKey(key),
      api_key: rawKey,
    };
  }

  async listApiKeys(groupId?: string): Promise<ApiKeyResponseDto[]> {
    const keys = await this.authzRepo.listApiKeys(optionalString(groupId) || undefined);
    return keys.map(mapApiKey);
  }

  async getApiKey(id: string): Promise<ApiKeyResponseDto> {
    const key = await this.authzRepo.getApiKey(id);
    if (!key) {
      throw new NotFoundException('API key not found');
    }
    return mapApiKey(key);
  }

  async disableApiKey(id: string, actor?: string | null): Promise<{ success: true }> {
    const disabled = await this.authzRepo.disableApiKey(id, actor);
    if (!disabled) {
      throw new NotFoundException('API key not found');
    }
    return { success: true };
  }

  async rotateApiKey(id: string, actor?: string | null): Promise<CreatedApiKeyResponseDto> {
    const current = await this.getApiKey(id);
    if (current.status !== 'active') {
      throw new BadRequestException('Only an active API key can be rotated');
    }
    const replacement = await this.createApiKey({
      name: current.name,
      owner_type: current.owner_type,
      owner_id: current.owner_id,
      group_id: current.group_id,
      scopes: current.scopes,
      workflow_access: current.workflow_access,
      allowed_workflow_ids: current.allowed_workflow_ids,
      ip_allowlist: current.ip_allowlist,
      rate_limit_per_minute: current.rate_limit_per_minute,
      expires_at: current.expires_at || null,
      actor: actor || undefined,
    });
    try {
      await this.disableApiKey(id, actor);
    } catch (error) {
      await this.disableApiKey(replacement.id, actor).catch(() => undefined);
      throw error;
    }
    return replacement;
  }

  async authenticateApiKey(rawKey: string): Promise<PxmApiKey> {
    if (!rawKey?.startsWith(API_KEY_PREFIX)) {
      throw new UnauthorizedException('API key is invalid');
    }
    const key = await this.authzRepo.findApiKeyByHash(hashApiKey(rawKey));
    if (!key) {
      throw new UnauthorizedException('API key is invalid');
    }
    if (effectiveApiKeyStatus(key) !== 'active') {
      throw new UnauthorizedException('API key is not active');
    }
    const group = await this.authzRepo.getGroup(key.group_id);
    if (!group || group.status !== 'active') {
      throw new UnauthorizedException('API key group is not active');
    }
    await this.authzRepo.touchApiKey(key.id, new Date().toISOString());
    return key;
  }

  async resolveAllowedWorkflowIds(key: PxmApiKey): Promise<string[]> {
    if (key.workflow_access !== 'all_in_group') {
      return key.allowed_workflow_ids;
    }
    return (await this.workflowRepo.listDefinitions())
      .filter((workflow) => (workflow.group_id || workflow.metadata?.group_id) === key.group_id)
      .map((workflow) => workflow.id);
  }

  async appendApiKeyUsageLog(log: AppendPxmApiKeyUsageLog) {
    return this.authzRepo.appendApiKeyUsageLog(log);
  }

  async completeApiKeyUsageLog(
    id: string,
    completion: { status_code: number | null; duration_ms: number; completed_at: string; completion_state: 'completed' | 'aborted' },
  ) {
    return this.authzRepo.completeApiKeyUsageLog(id, completion);
  }

  async listApiKeyUsage(query: ApiKeyUsageQuery) {
    const normalized = { ...query, from: query.from ? new Date(query.from).toISOString() : undefined, to: query.to ? new Date(query.to).toISOString() : undefined };
    if (normalized.from && normalized.to && normalized.from > normalized.to) throw new BadRequestException('from must be before to');
    const result = await this.authzRepo.listApiKeyUsage(normalized);
    return {
      ...result, page: query.page, pageSize: query.pageSize,
      items: result.items.map(item => ({
        id: item.id, api_key_id: item.api_key_id, owner_type: item.owner_type, owner_id: item.owner_id,
        group_id: item.group_id, endpoint: item.endpoint.split('?')[0], request_id: item.request_id,
        ip: item.ip, created_at: item.created_at, status_code: item.status_code,
        duration_ms: item.duration_ms, completed_at: item.completed_at, completion_state: item.completion_state,
        // External metadata is self-reported. Return only small identity fields, never arbitrary payloads.
        business_actor: item.business_actor ? Object.fromEntries(['id', 'name', 'subject', 'provider'].flatMap(key =>
          typeof item.business_actor?.[key] === 'string' ? [[key, item.business_actor[key].slice(0, 200)]] : [])) : null,
      })),
    };
  }

  async assertApiKeyRequestAllowed(key: PxmApiKey, requestIp?: string | null): Promise<void> {
    const ip = normalizeRequestIp(requestIp);
    const ipAllowlist = key.ip_allowlist || [];
    if (ipAllowlist.length > 0 && (!ip || !ipAllowlist.some((entry) => ipMatches(entry, ip)))) {
      throw new ForbiddenException('API key IP is not allowed');
    }
    const limit = Number(key.rate_limit_per_minute || 0);
    if (limit > 0) {
      const used = await this.authzRepo.countApiKeyUsageSince(
        key.id,
        new Date(Date.now() - 60_000).toISOString(),
      );
      if (used >= limit) throw new HttpException('API key rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private async assertGroupsExist(groupIds: string[]): Promise<void> {
    for (const groupId of groupIds) {
      const group = await this.authzRepo.getGroup(groupId);
      if (!group || group.status !== 'active') {
        throw new BadRequestException(`group not found or inactive: ${groupId}`);
      }
    }
  }

  private async assertMappingTarget(groupId: string, userId: string): Promise<void> {
    await this.assertGroupsExist([groupId]);
    const user = await this.authzRepo.getUser(userId);
    assertActiveGroupUser(user, groupId, 'mapping target');
  }

  private async externalPrincipalMappingView(
    mapping: ExternalPrincipalMapping,
  ): Promise<ExternalPrincipalMappingView> {
    const user = await this.authzRepo.getUser(mapping.pxm_user_id);
    const issues: ExternalPrincipalMappingView['issues'] = [];
    if (mapping.status !== 'active') issues.push('mapping_disabled');
    if (!user) issues.push('user_missing');
    else {
      if (user.status !== 'active') issues.push('user_disabled');
      if (user.role !== 'admin' && !user.group_ids.includes(mapping.group_id)) issues.push('group_mismatch');
    }
    const pxmUsable = mapping.status === 'active' && user?.status === 'active'
      && (user.role === 'admin' || user.group_ids.includes(mapping.group_id));
    if (!firstValidEmail([mapping.email, pxmUsable ? user?.email : null])) issues.push('email_missing');
    const emailUsable = mapping.status === 'active'
      && Boolean(firstValidEmail([mapping.email, pxmUsable ? user?.email : null]));
    return {
      ...mapping,
      pxm_user: user,
      available_channels: [
        ...(pxmUsable ? ['pxm_user' as const] : []),
        ...(emailUsable ? ['external_email' as const] : []),
      ],
      issues,
    };
  }

  private async assertOwnerCanReceiveKey(
    ownerType: CreateApiKeyDto['owner_type'],
    ownerId: string,
    groupId: string,
    scopes: PxmApiKeyScope[],
  ): Promise<void> {
    if (ownerType === 'USER') {
      const user = await this.authzRepo.getUser(ownerId);
      if (!user || user.status !== 'active') {
        throw new BadRequestException('user owner not found or inactive');
      }
      if (!user.group_ids.includes(groupId) && user.role !== 'admin') {
        throw new BadRequestException('user owner is not a member of the group');
      }
      return;
    }

    if (scopes.includes('task:approve')) {
      throw new BadRequestException('task:approve requires a USER owner API key');
    }

    const account = await this.authzRepo.getServiceAccount(ownerId);
    if (!account || account.status !== 'active') {
      throw new BadRequestException('service account owner not found or inactive');
    }
    if (account.group_id !== groupId) {
      throw new BadRequestException('service account owner is not in the group');
    }
  }
}

function collectCredentialIds(value: unknown, result: Set<string>): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectCredentialIds(item, result));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if ((key === 'credential_id' || key === 'credentialId' || key === 'dbWatchCredentialId') && typeof item === 'string' && item.trim()) {
      result.add(item.trim());
    } else {
      collectCredentialIds(item, result);
    }
  }
}

function mapApiKey(key: PxmApiKey): ApiKeyResponseDto {
  return {
    id: key.id,
    name: key.name,
    owner_type: key.owner_type,
    owner_id: key.owner_id,
    group_id: key.group_id,
    key_prefix: key.key_prefix,
    scopes: key.scopes,
    workflow_access: key.workflow_access === 'all_in_group' ? 'all_in_group' : 'allowlist',
    allowed_workflow_ids: key.allowed_workflow_ids,
    ip_allowlist: key.ip_allowlist || [],
    rate_limit_per_minute: key.rate_limit_per_minute || null,
    status: effectiveApiKeyStatus(key),
    expires_at: key.expires_at || null,
    last_used_at: key.last_used_at || null,
    created_by: key.created_by || null,
    disabled_at: key.disabled_at || null,
    disabled_reason: key.disabled_reason || null,
    created_at: key.created_at,
    updated_at: key.updated_at,
  };
}

function normalizeScopes(scopes: unknown): PxmApiKeyScope[] {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return ['workflow:execute'];
  }
  const normalized = scopes.map((scope) => String(scope).trim()).filter(Boolean);
  const invalid = normalized.find((scope) => !ALLOWED_API_KEY_SCOPES.includes(scope as PxmApiKeyScope));
  if (invalid) {
    throw new BadRequestException(`scope is invalid: ${invalid}`);
  }
  return Array.from(new Set(normalized)) as PxmApiKeyScope[];
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(new Set(value.map((item) => String(item).trim()).filter(Boolean)));
}

function normalizeMemberships(value: unknown): PxmGroupMembership[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const byGroup = new Map<string, PxmGroupMembership>();
  for (const item of value) {
    const groupId = optionalString((item as any)?.group_id);
    const role = (item as any)?.role;
    if (!groupId) {
      throw new BadRequestException('membership group_id is required');
    }
    if (role !== 'group_manager' && role !== 'user') {
      throw new BadRequestException(`membership role is invalid: ${groupId}`);
    }
    byGroup.set(groupId, { group_id: groupId, role });
  }
  return Array.from(byGroup.values());
}

function mergeMemberships(
  current: PxmGroupMembership[],
  requested: PxmGroupMembership[],
): PxmGroupMembership[] {
  const merged = new Map(current.map((membership) => [membership.group_id, membership]));
  for (const membership of requested) {
    merged.set(membership.group_id, membership);
  }
  return Array.from(merged.values());
}

function normalizePrincipalStatus(value: unknown) {
  if (value === undefined || value === null) {
    return 'active';
  }
  if (value === 'active' || value === 'disabled' || value === 'deleted') {
    return value;
  }
  throw new BadRequestException('status is invalid');
}

function normalizeExpiresAt(value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException('expires_at is invalid');
  }
  return date.toISOString();
}

function normalizeRateLimit(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100_000) {
    throw new BadRequestException('rate_limit_per_minute must be between 1 and 100000');
  }
  return limit;
}

function normalizeIpAllowlist(value: unknown): string[] {
  const entries = normalizeStringArray(value);
  for (const entry of entries) {
    const [address, prefix] = entry.split('/');
    const version = isIP(address);
    if (!version || (prefix !== undefined && (version !== 4 || !/^\d+$/.test(prefix) || Number(prefix) > 32))) {
      throw new BadRequestException(`IP allowlist entry is invalid: ${entry}`);
    }
  }
  return entries;
}

function normalizeRequestIp(value?: string | null): string | null {
  if (!value) return null;
  return value.startsWith('::ffff:') ? value.slice(7) : value;
}

function ipMatches(rule: string, ip: string): boolean {
  if (!rule.includes('/')) return rule === ip;
  const [network, prefixText] = rule.split('/');
  if (isIP(network) !== 4 || isIP(ip) !== 4) return false;
  const prefix = Number(prefixText);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4Number(network) & mask) === (ipv4Number(ip) & mask);
}

function ipv4Number(value: string): number {
  return value.split('.').reduce((result, octet) => ((result << 8) | Number(octet)) >>> 0, 0);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function optionalId(value: unknown): string | undefined {
  return optionalString(value) || undefined;
}

function requireString(value: unknown, field: string): string {
  const normalized = optionalString(value);
  if (!normalized) throw new BadRequestException(`${field} is required`);
  return normalized;
}

function normalizeExternalProvider(value: unknown): string {
  const provider = requireString(value, 'provider');
  if (provider.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(provider)) {
    throw new BadRequestException('provider is invalid');
  }
  return provider;
}

function normalizeExternalSubject(value: unknown, field = 'subject'): string {
  const subject = requireString(value, field);
  if (subject.length > 200 || /[\u0000-\u001f\u007f]/.test(subject)) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return subject;
}

function normalizeOptionalEmail(value: unknown): string | null {
  const email = optionalString(value);
  if (!email) return null;
  if (!isValidEmail(email)) throw new BadRequestException('email is invalid');
  return email.toLowerCase();
}

function firstValidEmail(values: unknown[]): string | null {
  for (const value of values) {
    const email = optionalString(value);
    if (email && isValidEmail(email)) return email.toLowerCase();
  }
  return null;
}

function resolveDeliveryEmail(values: unknown[], location: string): string | null {
  for (const value of values) {
    const email = optionalString(value);
    if (!email) continue;
    if (!isValidEmail(email)) throw new BadRequestException(`${location} has an invalid external email`);
    return email.toLowerCase();
  }
  return null;
}

function isValidEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function valueAtPath(value: Record<string, any>, path: string): any {
  return path.split('.').filter(Boolean).reduce<any>((current, part) => current?.[part], value);
}

function defaultApprovalChannels(nodes: any[], requestPath: string): Array<'pxm_user' | 'external_email'> {
  const node = (nodes || []).find((candidate) => {
    const data = candidate?.data || candidate?.config || candidate || {};
    const type = data.nodeType || candidate?.node_type || candidate?.type;
    const dynamic = data.approvalLineSource === 'dynamic' || data.approvalType === 'dynamic';
    const path = optionalString(data.approvalRequestPath) || 'approval_request';
    return type === 'approval' && dynamic && path === requestPath;
  });
  const data = node?.data || node?.config || node || {};
  const raw = Array.isArray(data.approvalChannels)
    ? data.approvalChannels
    : [optionalString(data.approverChannel) || 'pxm_user'];
  return normalizeChannelValues(raw, 'approval node');
}

function normalizeApprovalChannels(
  approver: Record<string, any>,
  defaults: Array<'pxm_user' | 'external_email'>,
  location: string,
): Array<'pxm_user' | 'external_email'> {
  const raw = approver.approval_channels !== undefined
    ? approver.approval_channels
    : approver.approver_channel
      ? [approver.approver_channel]
      : defaults;
  if (!Array.isArray(raw)) throw new BadRequestException(`${location} approval_channels must be an array`);
  return normalizeChannelValues(raw, location);
}

function normalizeChannelValues(
  values: unknown[],
  location: string,
): Array<'pxm_user' | 'external_email'> {
  const channels = Array.from(new Set(values.map((value) => optionalString(value)).filter(Boolean)));
  if (channels.length === 0) throw new BadRequestException(`${location} approval_channels must not be empty`);
  const invalid = channels.find((channel) => channel !== 'pxm_user' && channel !== 'external_email');
  if (invalid) throw new BadRequestException(`${location} approval channel is invalid: ${invalid}`);
  return channels as Array<'pxm_user' | 'external_email'>;
}

function assertActiveGroupUser(user: PxmUser | null, groupId: string, location: string): asserts user is PxmUser {
  if (!user || user.status !== 'active') {
    throw new BadRequestException(`${location} PXM user not found or inactive`);
  }
  if (user.role !== 'admin' && !user.group_ids.includes(groupId)) {
    throw new BadRequestException(`${location} PXM user is not a member of the workflow group`);
  }
}

function isDuplicateKeyError(error: any): boolean {
  return error?.code === 11000 || error?.code === '23505';
}

function hashApiKey(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function effectiveApiKeyStatus(key: PxmApiKey): string {
  if (key.status === 'active' && key.expires_at && Date.parse(key.expires_at) <= Date.now()) {
    return 'expired';
  }
  return key.status;
}
