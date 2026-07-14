import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import {
  AppendPxmApiKeyUsageLog,
  AuthzRepositoryPort,
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
  CreateApiKeyDto,
  CreatedApiKeyResponseDto,
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

  async listUsers(groupId?: string): Promise<PxmUser[]> {
    return this.authzRepo.listUsers(optionalString(groupId) || undefined);
  }

  async getUser(id: string): Promise<PxmUser> {
    const user = await this.authzRepo.getUser(id);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
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

    const group = await this.getGroup(dto.group_id.trim());
    if (group.status !== 'active') {
      throw new BadRequestException('group is not active');
    }

    const scopes = normalizeScopes(dto.scopes);
    await this.assertOwnerCanReceiveKey(dto.owner_type, dto.owner_id.trim(), dto.group_id.trim(), scopes);

    const rawKey = `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
    const allowedWorkflowIds = dto.allowed_workflow_ids === undefined
      ? (await this.workflowRepo.listDefinitions())
          .filter((workflow) => (workflow.group_id || workflow.metadata?.group_id) === dto.group_id.trim())
          .map((workflow) => workflow.id)
      : normalizeStringArray(dto.allowed_workflow_ids);
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
      throw new BadRequestException('API key is invalid');
    }
    const key = await this.authzRepo.findApiKeyByHash(hashApiKey(rawKey));
    if (!key) {
      throw new BadRequestException('API key is invalid');
    }
    if (effectiveApiKeyStatus(key) !== 'active') {
      throw new BadRequestException('API key is not active');
    }
    const group = await this.authzRepo.getGroup(key.group_id);
    if (!group || group.status !== 'active') {
      throw new BadRequestException('API key group is not active');
    }
    await this.authzRepo.touchApiKey(key.id, new Date().toISOString());
    return key;
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

function hashApiKey(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function effectiveApiKeyStatus(key: PxmApiKey): string {
  if (key.status === 'active' && key.expires_at && Date.parse(key.expires_at) <= Date.now()) {
    return 'expired';
  }
  return key.status;
}
