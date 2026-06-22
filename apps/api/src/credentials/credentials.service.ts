import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'crypto';
import { Db } from 'mongodb';
import { MONGO_DB } from '../db/mongo.provider';
import {
  CreateCredentialDto,
  CredentialAuditResponseDto,
  CredentialResponseDto,
  CredentialType,
  UpdateCredentialDto,
} from './dto/credential.dto';

type CredentialDocument = {
  _id: string;
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
  action: string;
  actor: string;
  node_id?: string | null;
  workflow_id?: string | null;
  created_at: string;
};

@Injectable()
export class CredentialsService {
  constructor(@Inject(MONGO_DB) private readonly db: Db) {}

  async create(dto: CreateCredentialDto): Promise<CredentialResponseDto> {
    const normalized = normalizeCreateDto(dto);
    const now = new Date().toISOString();
    const doc: CredentialDocument = {
      _id: randomUUID(),
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
    };

    await this.credentials.insertOne(doc);
    await this.appendAudit(doc._id, 'created');
    return mapCredential(doc);
  }

  async list(activeOnly = false): Promise<CredentialResponseDto[]> {
    const docs = await this.credentials
      .find(activeOnly ? { active: true } : {})
      .sort({ updated_at: -1 })
      .toArray();
    return docs.map(mapCredential);
  }

  async get(id: string): Promise<CredentialResponseDto> {
    const doc = await this.findDocument(id);
    return mapCredential(doc);
  }

  async update(id: string, dto: UpdateCredentialDto): Promise<CredentialResponseDto> {
    const current = await this.findDocument(id);
    const patch = normalizeUpdateDto(dto);
    const next: Partial<CredentialDocument> = {
      ...patch.profile,
      updated_at: new Date().toISOString(),
    };

    if (patch.secret_value !== undefined) {
      next.secret = encryptSecret(patch.secret_value);
    }

    await this.credentials.updateOne({ _id: id }, { $set: next });
    await this.appendAudit(id, patch.secret_value !== undefined ? 'updated_with_secret' : 'updated');

    const updated = await this.findDocument(id);
    return mapCredential(updated);
  }

  async delete(id: string): Promise<{ success: true }> {
    await this.findDocument(id);
    await this.credentials.updateOne(
      { _id: id },
      {
        $set: {
          active: false,
          updated_at: new Date().toISOString(),
        },
      },
    );
    await this.appendAudit(id, 'deactivated');
    return { success: true };
  }

  async resolveSecret(
    id: string,
    usage?: { actor?: string; node_id?: string; workflow_id?: string },
  ): Promise<string> {
    const doc = await this.findDocument(id);
    if (!doc.active) {
      throw new BadRequestException('Credential is inactive');
    }

    await this.credentials.updateOne(
      { _id: id },
      { $set: { last_used_at: new Date().toISOString() } },
    );
    await this.appendAudit(id, 'used', usage);
    return decryptSecret(doc.secret);
  }

  async audit(id?: string): Promise<CredentialAuditResponseDto[]> {
    const docs = await this.auditLogs
      .find(id ? { credential_id: id } : {})
      .sort({ created_at: -1 })
      .limit(100)
      .toArray();
    return docs.map((doc) => ({
      id: doc._id,
      credential_id: doc.credential_id,
      action: doc.action,
      actor: doc.actor,
      node_id: doc.node_id || null,
      workflow_id: doc.workflow_id || null,
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
    credentialId: string,
    action: string,
    usage?: { actor?: string; node_id?: string; workflow_id?: string },
  ) {
    await this.auditLogs.insertOne({
      _id: randomUUID(),
      credential_id: credentialId,
      action,
      actor: usage?.actor || 'system',
      node_id: usage?.node_id || null,
      workflow_id: usage?.workflow_id || null,
      created_at: new Date().toISOString(),
    });
  }
}

function normalizeCreateDto(dto: CreateCredentialDto): Required<CreateCredentialDto> {
  if (!dto || typeof dto !== 'object') {
    throw new BadRequestException('Credential payload is required');
  }
  if (!dto.name?.trim()) {
    throw new BadRequestException('name is required');
  }
  if (!isCredentialType(dto.type)) {
    throw new BadRequestException('type is invalid');
  }
  if (!dto.secret_value) {
    throw new BadRequestException('secret_value is required');
  }

  return {
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
  return metadata as Record<string, any>;
}

function mapCredential(doc: CredentialDocument): CredentialResponseDto {
  return {
    id: doc._id,
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
  const source = process.env.CREDENTIAL_SECRET_KEY || 'pxm-local-development-credential-key';
  return createHash('sha256').update(source).digest();
}
