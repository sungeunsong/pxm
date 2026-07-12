import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import {
  AppendPxmApiKeyUsageLog,
  AuthzRepositoryPort,
  PxmApiKey,
  PxmApiKeyScope,
  PxmGroup,
  PxmServiceAccount,
  PxmUser,
} from '../db/ports/db.ports';
import {
  ApiKeyResponseDto,
  CreateApiKeyDto,
  CreatedApiKeyResponseDto,
  UpsertGroupDto,
  UpsertServiceAccountDto,
  UpsertUserDto,
} from './dto/authz.dto';

const API_KEY_PREFIX = 'pxm_live_';
const API_KEY_VISIBLE_PREFIX_LENGTH = 18;
const ALLOWED_API_KEY_SCOPES: PxmApiKeyScope[] = [
  'workflow:read',
  'workflow:execute',
  'task:approve',
];

@Injectable()
export class AuthzService {
  constructor(private readonly authzRepo: AuthzRepositoryPort) {}

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
    const role = dto.role || 'user';
    if (!['admin', 'group_manager', 'user'].includes(role)) {
      throw new BadRequestException('role is invalid');
    }
    const groupIds = normalizeStringArray(dto.group_ids);
    await this.assertGroupsExist(groupIds);
    return this.authzRepo.upsertUser({
      id: optionalId(dto.id),
      display_name: dto.display_name.trim(),
      email: optionalString(dto.email),
      role,
      group_ids: groupIds,
      status: normalizePrincipalStatus(dto.status),
      actor: optionalString(dto.actor),
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
    const key = await this.authzRepo.createApiKey({
      id: optionalId(dto.id),
      name: dto.name.trim(),
      owner_type: dto.owner_type,
      owner_id: dto.owner_id.trim(),
      group_id: dto.group_id.trim(),
      key_prefix: rawKey.slice(0, API_KEY_VISIBLE_PREFIX_LENGTH),
      key_hash: hashApiKey(rawKey),
      scopes,
      allowed_workflow_ids: normalizeStringArray(dto.allowed_workflow_ids),
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
