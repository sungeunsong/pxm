import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import {
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
} from '../db/ports/db.ports';
import {
  ApiKeyResponseDto,
  CreateExternalPrincipalMappingDto,
  CreateApiKeyDto,
  CreatedApiKeyResponseDto,
  UpdateExternalPrincipalMappingDto,
  UpsertGroupDto,
  UpsertServiceAccountDto,
  UpsertUserDto,
} from './dto/authz.dto';
import { hashPassword } from './password';
import { isIP } from 'net';

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

  async deleteGroup(id: string, actor?: string | null): Promise<{ success: true }> {
    const deleted = await this.authzRepo.softDeleteGroup(id, actor);
    if (!deleted) {
      throw new NotFoundException('Group not found');
    }
    return { success: true };
  }

  async restoreGroup(id: string, actor?: string | null): Promise<{ success: true }> {
    const restored = await this.authzRepo.restoreGroup(id, actor);
    if (!restored) {
      throw new NotFoundException('Deleted group not found');
    }
    return { success: true };
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
