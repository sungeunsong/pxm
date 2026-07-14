import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'crypto';
import { Db } from 'mongodb';
import { MONGO_DB } from '../db/mongo.provider';
import type { WorkflowHistoryActor } from '../db/ports/db.ports';
import { assertCanManageGroup, isAdmin, managerGroupIds } from '../authz/management-auth';
import {
  CreateCredentialDto,
  CredentialAuditResponseDto,
  CredentialResponseDto,
  CredentialType,
  UpdateCredentialDto,
} from './dto/credential.dto';

type CredentialDocument = {
  _id: string;
  group_id?: string | null;
  shared_group_ids?: string[];
  name: string;
  type: CredentialType;
  description: string;
  scopes: string[];
  metadata: Record<string, any>;
  active: boolean;
  secret: EncryptedSecret;
  created_at: string;
  updated_at: string;
  last_used_at?: string | null;
  created_by?: string | null;
  updated_by?: string | null;
};

type EncryptedSecret = {
  algorithm: 'aes-256-gcm';
  iv: string;
  tag: string;
  ciphertext: string;
};

type AuditDocument = {
  _id: string;
  credential_id: string;
  group_id?: string | null;
  action: string;
  actor: string;
  node_id?: string | null;
  workflow_id?: string | null;
  details?: Record<string, unknown> | null;
  created_at: string;
};

@Injectable()
export class CredentialsService implements OnModuleInit {
  constructor(@Inject(MONGO_DB) private readonly db: Db) {}

  async onModuleInit() {
    getCredentialKey();
    await Promise.all([
      this.credentials.createIndex({ group_id: 1, active: 1, updated_at: -1 }),
      this.credentials.createIndex({ shared_group_ids: 1, active: 1, updated_at: -1 }),
      this.auditLogs.createIndex({ group_id: 1, created_at: -1 }),
      this.auditLogs.createIndex({ credential_id: 1, created_at: -1 }),
    ]);
  }

  async create(dto: CreateCredentialDto, actor: WorkflowHistoryActor): Promise<CredentialResponseDto> {
    const normalized = normalizeCreateDto(dto);
    assertCanManageGroup(actor, normalized.group_id);
    await this.assertShareTargetsManageable(actor, normalized.shared_group_ids);
    const now = new Date().toISOString();
    const actorId = actor.actor_id || 'system';
    const doc: CredentialDocument = {
      _id: randomUUID(),
      group_id: normalized.group_id,
      shared_group_ids: normalized.shared_group_ids,
      name: normalized.name,
      type: normalized.type,
      description: normalized.description,
      scopes: normalized.scopes,
      metadata: normalized.metadata,
      active: true,
      secret: encryptSecret(normalized.secret_value),
      created_at: now,
      updated_at: now,
      last_used_at: null,
      created_by: actorId,
      updated_by: actorId,
    };

    await this.credentials.insertOne(doc);
    await this.appendAudit(doc, 'created', { actor: actorId });
    if (doc.shared_group_ids?.length) {
      await this.appendAudit(doc, 'sharing_updated', {
        actor: actorId,
        details: { shared_group_ids: doc.shared_group_ids },
      });
    }
    return mapCredential(doc, actor);
  }

  async list(
    activeOnly: boolean,
    actor: WorkflowHistoryActor,
    requestedGroupId?: string,
  ): Promise<CredentialResponseDto[]> {
    const accessFilter = credentialListFilter(actor, requestedGroupId);
    const docs = await this.credentials
      .find({ ...accessFilter, ...(activeOnly ? { active: true } : {}) })
      .sort({ updated_at: -1 })
      .toArray();
    return docs.map((doc) => mapCredential(doc, actor));
  }

  async get(id: string, actor: WorkflowHistoryActor): Promise<CredentialResponseDto> {
    const doc = await this.findDocument(id);
    assertCredentialUseAccess(actor, doc);
    return mapCredential(doc, actor);
  }

  async getForRuntime(id: string, expectedGroupId: string | null | undefined): Promise<CredentialResponseDto> {
    const doc = await this.findDocument(id);
    if (!expectedGroupId || !credentialAvailableToGroup(doc, expectedGroupId)) {
      throw new ForbiddenException('Credential is not available to the workflow group');
    }
    if (!doc.active) {
      throw new BadRequestException('Credential is inactive');
    }
    return mapCredential(doc);
  }

  async update(id: string, dto: UpdateCredentialDto, actor: WorkflowHistoryActor): Promise<CredentialResponseDto> {
    const current = await this.findDocument(id);
    assertCredentialOwnerAccess(actor, current);
    const patch = normalizeUpdateDto(dto);
    const targetGroupId = patch.profile.group_id !== undefined ? patch.profile.group_id : current.group_id;
    assertCanManageGroup(actor, targetGroupId);
    if (patch.profile.shared_group_ids) {
      await this.assertShareTargetsManageable(actor, patch.profile.shared_group_ids);
      patch.profile.shared_group_ids = patch.profile.shared_group_ids.filter((groupId) => groupId !== targetGroupId);
    }
    const next: Partial<CredentialDocument> = {
      ...patch.profile,
      ...(targetGroupId !== current.group_id && patch.profile.shared_group_ids === undefined
        ? { shared_group_ids: (current.shared_group_ids || []).filter((groupId) => groupId !== targetGroupId) }
        : {}),
      updated_at: new Date().toISOString(),
      updated_by: actor.actor_id || 'system',
    };

    if (patch.secret_value !== undefined) {
      next.secret = encryptSecret(patch.secret_value);
    }

    await this.credentials.updateOne({ _id: id }, { $set: next });
    const updated = await this.findDocument(id);
    const auditAction = patch.secret_value !== undefined
      ? 'updated_with_secret'
      : dto.shared_group_ids !== undefined
        ? 'sharing_updated'
        : 'updated';
    await this.appendAudit(updated, auditAction, {
      actor: actor.actor_id || 'system',
      ...(dto.shared_group_ids !== undefined
        ? { details: { shared_group_ids: updated.shared_group_ids || [] } }
        : {}),
    });

    return mapCredential(updated, actor);
  }

  async delete(id: string, actor: WorkflowHistoryActor): Promise<{ success: true }> {
    const current = await this.findDocument(id);
    assertCredentialOwnerAccess(actor, current);
    await this.credentials.updateOne(
      { _id: id },
      {
        $set: {
          active: false,
          updated_at: new Date().toISOString(),
          updated_by: actor.actor_id || 'system',
        },
      },
    );
    await this.appendAudit(current, 'deactivated', { actor: actor.actor_id || 'system' });
    return { success: true };
  }

  async revokeGroupShares(groupId: string, actorId = 'system'): Promise<number> {
    const sharedCredentials = await this.credentials.find({ shared_group_ids: groupId }).toArray();
    if (!sharedCredentials.length) return 0;
    await this.credentials.updateMany(
      { shared_group_ids: groupId },
      {
        $pull: { shared_group_ids: groupId },
        $set: { updated_at: new Date().toISOString(), updated_by: actorId },
      },
    );
    await Promise.all(sharedCredentials.map((credential) => this.appendAudit(
      credential,
      'sharing_revoked_group_deleted',
      { actor: actorId, usage_group_id: groupId, details: { revoked_group_id: groupId } },
    )));
    return sharedCredentials.length;
  }

  async resolveSecret(
    id: string,
    usage: {
      actor?: string;
      actor_context?: WorkflowHistoryActor;
      expected_group_id?: string | null;
      node_id?: string;
      workflow_id?: string;
    },
  ): Promise<string> {
    const doc = await this.findDocument(id);
    if (usage.actor_context) {
      assertCredentialUseAccess(usage.actor_context, doc);
    } else if (usage.expected_group_id) {
      if (!credentialAvailableToGroup(doc, usage.expected_group_id)) {
        throw new ForbiddenException('Credential is not available to the workflow group');
      }
    } else {
      throw new ForbiddenException('Credential authorization context is required');
    }
    if (!doc.active) {
      throw new BadRequestException('Credential is inactive');
    }

    await this.credentials.updateOne(
      { _id: id },
      { $set: { last_used_at: new Date().toISOString() } },
    );
    await this.appendAudit(doc, 'used', {
      ...usage,
      usage_group_id: usage.expected_group_id || actorPrimaryCredentialGroup(usage.actor_context, doc),
    });
    return decryptSecret(doc.secret);
  }

  async audit(
    actor: WorkflowHistoryActor,
    id?: string,
    requestedGroupId?: string,
  ): Promise<CredentialAuditResponseDto[]> {
    let accessFilter: Record<string, any>;
    if (id) {
      const credential = await this.findDocument(id);
      assertCredentialUseAccess(actor, credential);
      accessFilter = hasCredentialOwnerAccess(actor, credential)
        ? {}
        : credentialAuditListFilter(actor, requestedGroupId);
    } else {
      accessFilter = credentialAuditListFilter(actor, requestedGroupId);
      if (!isAdmin(actor)) {
        const ownerGroupIds = requestedGroupId ? [requestedGroupId] : managerGroupIds(actor);
        const ownedCredentials = await this.credentials
          .find({ group_id: { $in: ownerGroupIds } }, { projection: { _id: 1 } })
          .toArray();
        accessFilter = {
          $or: [
            accessFilter,
            { credential_id: { $in: ownedCredentials.map((credential) => credential._id) } },
          ],
        };
      }
    }
    const docs = await this.auditLogs
      .find({ ...accessFilter, ...(id ? { credential_id: id } : {}) })
      .sort({ created_at: -1 })
      .limit(100)
      .toArray();
    return docs.map((doc) => ({
      id: doc._id,
      credential_id: doc.credential_id,
      group_id: doc.group_id || null,
      action: doc.action,
      actor: doc.actor,
      node_id: doc.node_id || null,
      workflow_id: doc.workflow_id || null,
      details: doc.details || null,
      created_at: doc.created_at,
    }));
  }

  private get credentials() {
    return this.db.collection<CredentialDocument>('credential_profiles');
  }

  private get auditLogs() {
    return this.db.collection<AuditDocument>('credential_audit_logs');
  }

  private async findDocument(id: string): Promise<CredentialDocument> {
    const doc = await this.credentials.findOne({ _id: id });
    if (!doc) {
      throw new NotFoundException('Credential not found');
    }
    return doc;
  }

  private async appendAudit(
    credential: CredentialDocument,
    action: string,
    usage?: {
      actor?: string;
      node_id?: string;
      workflow_id?: string;
      usage_group_id?: string | null;
      details?: Record<string, unknown>;
    },
  ) {
    await this.auditLogs.insertOne({
      _id: randomUUID(),
      credential_id: credential._id,
      group_id: usage?.usage_group_id || credential.group_id || null,
      action,
      actor: usage?.actor || 'system',
      node_id: usage?.node_id || null,
      workflow_id: usage?.workflow_id || null,
      details: usage?.details || null,
      created_at: new Date().toISOString(),
    });
  }

  private async assertShareTargetsManageable(actor: WorkflowHistoryActor, groupIds: string[]) {
    for (const groupId of groupIds) {
      assertCanManageGroup(actor, groupId);
      const group = await this.db.collection<any>('pxm_groups').findOne({ _id: groupId, status: 'active' });
      if (!group) throw new BadRequestException(`shared group not found or inactive: ${groupId}`);
    }
  }
}

function normalizeCreateDto(dto: CreateCredentialDto): Required<CreateCredentialDto> {
  if (!dto || typeof dto !== 'object') {
    throw new BadRequestException('Credential payload is required');
  }
  if (!dto.name?.trim()) {
    throw new BadRequestException('name is required');
  }
  if (!dto.group_id?.trim()) {
    throw new BadRequestException('group_id is required');
  }
  if (!isCredentialType(dto.type)) {
    throw new BadRequestException('type is invalid');
  }
  if (!dto.secret_value) {
    throw new BadRequestException('secret_value is required');
  }

  return {
    group_id: dto.group_id.trim(),
    shared_group_ids: normalizeGroupIds(dto.shared_group_ids).filter((groupId) => groupId !== dto.group_id.trim()),
    name: dto.name.trim(),
    type: dto.type,
    description: typeof dto.description === 'string' ? dto.description : '',
    scopes: normalizeScopes(dto.scopes),
    secret_value: dto.secret_value,
    metadata: normalizeMetadata(dto.metadata),
  };
}

function normalizeUpdateDto(dto: UpdateCredentialDto): {
  profile: Partial<Omit<CredentialDocument, '_id' | 'secret' | 'created_at' | 'updated_at'>>;
  secret_value?: string;
} {
  if (!dto || typeof dto !== 'object') {
    throw new BadRequestException('Credential payload is required');
  }

  const profile: Partial<Omit<CredentialDocument, '_id' | 'secret' | 'created_at' | 'updated_at'>> = {};
  if (dto.name !== undefined) {
    if (!dto.name.trim()) throw new BadRequestException('name cannot be empty');
    profile.name = dto.name.trim();
  }
  if (dto.group_id !== undefined) {
    if (!dto.group_id.trim()) throw new BadRequestException('group_id cannot be empty');
    profile.group_id = dto.group_id.trim();
  }
  if (dto.shared_group_ids !== undefined) {
    profile.shared_group_ids = normalizeGroupIds(dto.shared_group_ids);
  }
  if (dto.type !== undefined) {
    if (!isCredentialType(dto.type)) throw new BadRequestException('type is invalid');
    profile.type = dto.type;
  }
  if (dto.description !== undefined) {
    profile.description = String(dto.description);
  }
  if (dto.scopes !== undefined) {
    profile.scopes = normalizeScopes(dto.scopes);
  }
  if (dto.metadata !== undefined) {
    profile.metadata = normalizeMetadata(dto.metadata);
  }
  if (dto.active !== undefined) {
    profile.active = Boolean(dto.active);
  }

  return {
    profile,
    ...(dto.secret_value !== undefined ? { secret_value: dto.secret_value } : {}),
  };
}

function isCredentialType(value: unknown): value is CredentialType {
  return ['api_key', 'basic_auth', 'bearer_token', 'connection_string', 'custom'].includes(String(value));
}

function normalizeScopes(scopes: unknown): string[] {
  if (!Array.isArray(scopes)) return [];
  return scopes.map((scope) => String(scope).trim()).filter(Boolean);
}

function normalizeMetadata(metadata: unknown): Record<string, any> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  assertMetadataContainsNoSecrets(metadata, 'metadata');
  return metadata as Record<string, any>;
}

function mapCredential(doc: CredentialDocument, actor?: WorkflowHistoryActor): CredentialResponseDto {
  return {
    id: doc._id,
    group_id: doc.group_id || null,
    shared_group_ids: doc.shared_group_ids || [],
    access_level: actor && !hasCredentialOwnerAccess(actor, doc) ? 'shared' : 'owner',
    name: doc.name,
    type: doc.type,
    description: doc.description || '',
    scopes: doc.scopes || [],
    metadata: doc.metadata || {},
    active: doc.active !== false,
    has_secret: Boolean(doc.secret?.ciphertext),
    created_at: doc.created_at,
    updated_at: doc.updated_at,
    last_used_at: doc.last_used_at || null,
    created_by: doc.created_by || null,
    updated_by: doc.updated_by || null,
  };
}

function encryptSecret(secret: string): EncryptedSecret {
  const key = getCredentialKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decryptSecret(secret: EncryptedSecret): string {
  const key = getCredentialKey();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(secret.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(secret.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(secret.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function getCredentialKey(): Buffer {
  const configured = process.env.CREDENTIAL_SECRET_KEY;
  if (process.env.NODE_ENV === 'production' && (!configured || configured.length < 32)) {
    throw new Error('CREDENTIAL_SECRET_KEY must be configured with at least 32 characters in production');
  }
  const source = configured || 'pxm-local-development-credential-key';
  return createHash('sha256').update(source).digest();
}

function credentialListFilter(
  actor: WorkflowHistoryActor,
  requestedGroupId?: string,
): Record<string, any> {
  if (actor.api_key_id) {
    throw new ForbiddenException('API key cannot manage credentials');
  }
  if (isAdmin(actor)) {
    return requestedGroupId
      ? { $or: [{ group_id: requestedGroupId }, { shared_group_ids: requestedGroupId }] }
      : {};
  }
  const manageableGroups = managerGroupIds(actor);
  if (!manageableGroups.length) {
    throw new ForbiddenException('credential management role is required');
  }
  if (requestedGroupId) {
    assertCanManageGroup(actor, requestedGroupId);
    return { $or: [{ group_id: requestedGroupId }, { shared_group_ids: requestedGroupId }] };
  }
  return {
    $or: [
      { group_id: { $in: manageableGroups } },
      { shared_group_ids: { $in: manageableGroups } },
    ],
  };
}

function credentialAuditListFilter(
  actor: WorkflowHistoryActor,
  requestedGroupId?: string,
): Record<string, any> {
  if (actor.api_key_id) throw new ForbiddenException('API key cannot read credential audit');
  if (isAdmin(actor)) return requestedGroupId ? { group_id: requestedGroupId } : {};
  const manageableGroups = managerGroupIds(actor);
  if (!manageableGroups.length) throw new ForbiddenException('credential management role is required');
  if (requestedGroupId) {
    assertCanManageGroup(actor, requestedGroupId);
    return { group_id: requestedGroupId };
  }
  return { group_id: { $in: manageableGroups } };
}

function assertCredentialOwnerAccess(actor: WorkflowHistoryActor, credential: CredentialDocument): void {
  if (!hasCredentialOwnerAccess(actor, credential)) {
    throw new ForbiddenException('Only the credential owner group can manage this credential');
  }
}

function hasCredentialOwnerAccess(actor: WorkflowHistoryActor, credential: CredentialDocument): boolean {
  if (isAdmin(actor)) return true;
  return Boolean(credential.group_id && managerGroupIds(actor).includes(credential.group_id));
}

function assertCredentialUseAccess(actor: WorkflowHistoryActor, credential: CredentialDocument): void {
  if (hasCredentialOwnerAccess(actor, credential)) return;
  if ((credential.shared_group_ids || []).some((groupId) => (actor.group_ids || []).includes(groupId))) return;
  throw new ForbiddenException('Credential is not available to this actor');
}

function credentialAvailableToGroup(credential: CredentialDocument, groupId: string): boolean {
  return credential.group_id === groupId || (credential.shared_group_ids || []).includes(groupId);
}

function actorPrimaryCredentialGroup(
  actor: WorkflowHistoryActor | undefined,
  credential: CredentialDocument,
): string | null {
  if (!actor) return null;
  if (credential.group_id && (actor.group_ids || []).includes(credential.group_id)) return credential.group_id;
  return (credential.shared_group_ids || []).find((groupId) => (actor.group_ids || []).includes(groupId)) || null;
}

function normalizeGroupIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => String(item).trim()).filter(Boolean)));
}

const SECRET_METADATA_KEY = /(password|passwd|secret|token|api[_-]?key|authorization|private[_-]?key|connection[_-]?(uri|string)|passphrase)/i;

function assertMetadataContainsNoSecrets(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertMetadataContainsNoSecrets(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_METADATA_KEY.test(key)) {
      throw new BadRequestException(`${path}.${key} cannot contain secret data; use secret_value`);
    }
    assertMetadataContainsNoSecrets(child, `${path}.${key}`);
  }
}
