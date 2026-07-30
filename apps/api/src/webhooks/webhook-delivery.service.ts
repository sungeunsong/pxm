import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { createHmac, randomUUID } from 'crypto';
import { Db } from 'mongodb';
import { assertAdmin } from '../authz/management-auth';
import { MONGO_DB } from '../db/mongo.provider';
import {
  OutboxRepositoryPort,
  type WebhookOutboxEvent,
  type WorkflowHistoryActor,
} from '../db/ports/db.ports';
import {
  assertConfiguredSecretKey,
  decryptSecret,
  encryptSecret,
  type EncryptedSecret,
} from '../security/encrypted-secret';
import { ManagementAuditService } from '../audit/management-audit.service';
import {
  CreateWebhookEndpointDto,
  UpdateWebhookEndpointDto,
  WebhookDeliveryQueryDto,
} from './dto/webhook.dto';

const FINAL_APPROVAL_EVENTS = new Set([
  'APPROVAL_REQUEST_APPROVED',
  'APPROVAL_REQUEST_REJECTED',
  'APPROVAL_REQUEST_CANCELED',
]);

export type WebhookEndpointDocument = {
  _id: string;
  name: string;
  source_provider: string;
  url: string;
  secret: EncryptedSecret;
  secret_hint: string;
  active: boolean;
  timeout_ms: number;
  max_attempts: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
};

export type WebhookDeliveryDocument = {
  _id: string;
  event_key: string;
  source_db: string;
  source_event_id: string;
  endpoint_id: string;
  endpoint_name: string;
  instance_id: string;
  event_type: string;
  event_payload: Record<string, any>;
  occurred_at: string;
  status:
    | 'PENDING'
    | 'RUNNING'
    | 'SENT'
    | 'FAILED'
    | 'DEAD_LETTER'
    | 'CANCELED';
  attempt_count: number;
  total_attempt_count: number;
  manual_retry_count: number;
  max_attempts: number;
  next_attempt_at: string;
  locked_by: string | null;
  locked_until: string | null;
  response_status: number | null;
  last_error: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
};

@Injectable()
export class WebhookDeliveryService implements OnModuleInit {
  constructor(
    @Inject(MONGO_DB) private readonly db: Db,
    private readonly outbox: OutboxRepositoryPort,
    private readonly audit: ManagementAuditService,
  ) {}

  async onModuleInit() {
    assertConfiguredSecretKey();
    await Promise.all([
      this.endpoints.createIndex(
        { source_provider: 1, active: 1, created_at: 1 },
        { name: 'idx_webhook_endpoints_provider' },
      ),
      this.deliveries.createIndex(
        { endpoint_id: 1, event_key: 1 },
        { unique: true, name: 'ux_webhook_delivery_endpoint_event' },
      ),
      this.deliveries.createIndex(
        { status: 1, next_attempt_at: 1, locked_until: 1 },
        { name: 'idx_webhook_delivery_claim' },
      ),
      this.deliveries.createIndex(
        { created_at: -1 },
        { name: 'idx_webhook_delivery_history' },
      ),
      this.attempts.createIndex(
        { delivery_id: 1, started_at: -1 },
        { name: 'idx_webhook_attempt_delivery' },
      ),
    ]);
  }

  async createEndpoint(
    dto: CreateWebhookEndpointDto,
    actor: WorkflowHistoryActor,
  ) {
    assertWebhookAdmin(actor);
    const now = new Date().toISOString();
    const normalized = normalizeEndpointInput(dto);
    const document: WebhookEndpointDocument = {
      _id: randomUUID(),
      ...normalized,
      secret: encryptSecret(dto.secret),
      secret_hint: secretHint(dto.secret),
      active: true,
      timeout_ms: dto.timeout_ms || 5_000,
      max_attempts: dto.max_attempts || 8,
      created_by: actor.actor_id!,
      updated_by: actor.actor_id!,
      created_at: now,
      updated_at: now,
    };
    await this.endpoints.insertOne(document);
    await this.audit.append({
      action: 'webhook.endpoint.created',
      resource_type: 'webhook_endpoint',
      resource_id: document._id,
      actor_id: actor.actor_id,
      details: {
        name: document.name,
        source_provider: document.source_provider,
        url: maskWebhookUrl(document.url),
        has_secret: true,
      },
    });
    return mapEndpoint(document);
  }

  async listEndpoints(actor: WorkflowHistoryActor) {
    assertWebhookAdmin(actor);
    return (
      await this.endpoints.find({}).sort({ updated_at: -1 }).toArray()
    ).map(mapEndpoint);
  }

  async updateEndpoint(
    id: string,
    dto: UpdateWebhookEndpointDto,
    actor: WorkflowHistoryActor,
  ) {
    assertWebhookAdmin(actor);
    const current = await this.endpoints.findOne({ _id: id });
    if (!current) throw new NotFoundException('Webhook endpoint not found');
    const patch: Partial<WebhookEndpointDocument> = {
      updated_by: actor.actor_id!,
      updated_at: new Date().toISOString(),
    };
    if (dto.name !== undefined) patch.name = dto.name.trim();
    if (dto.source_provider !== undefined)
      patch.source_provider = normalizeProvider(dto.source_provider);
    if (dto.url !== undefined) patch.url = validateWebhookUrl(dto.url);
    if (dto.timeout_ms !== undefined) patch.timeout_ms = dto.timeout_ms;
    if (dto.max_attempts !== undefined) patch.max_attempts = dto.max_attempts;
    if (dto.active !== undefined) patch.active = dto.active;
    if (dto.secret !== undefined) {
      patch.secret = encryptSecret(dto.secret);
      patch.secret_hint = secretHint(dto.secret);
    }
    await this.endpoints.updateOne({ _id: id }, { $set: patch });
    if (dto.active === false) {
      await this.deliveries.updateMany(
        {
          endpoint_id: id,
          status: { $in: ['PENDING', 'FAILED'] },
        },
        {
          $set: {
            status: 'CANCELED',
            last_error: 'endpoint deactivated',
            updated_at: new Date().toISOString(),
          },
        },
      );
    }
    const updated = await this.endpoints.findOne({ _id: id });
    await this.audit.append({
      action:
        dto.active === false
          ? 'webhook.endpoint.deactivated'
          : 'webhook.endpoint.updated',
      resource_type: 'webhook_endpoint',
      resource_id: id,
      actor_id: actor.actor_id,
      details: {
        changed_fields: Object.keys(dto),
        url: updated?.url ? maskWebhookUrl(updated.url) : null,
        source_provider: updated?.source_provider,
      },
    });
    return mapEndpoint(updated!);
  }

  async listDeliveries(
    query: WebhookDeliveryQueryDto,
    actor: WorkflowHistoryActor,
  ) {
    assertWebhookAdmin(actor);
    const filter: Record<string, any> = {};
    if (query.endpoint_id) filter.endpoint_id = query.endpoint_id;
    if (query.status) filter.status = query.status;
    const docs = await this.deliveries
      .find(filter)
      .sort({ created_at: -1 })
      .limit(query.limit || 100)
      .toArray();
    return docs.map(mapDelivery);
  }

  async getDelivery(id: string, actor: WorkflowHistoryActor) {
    assertWebhookAdmin(actor);
    const delivery = await this.deliveries.findOne({ _id: id });
    if (!delivery) throw new NotFoundException('Webhook delivery not found');
    const attempts = await this.attempts
      .find({ delivery_id: id })
      .sort({ started_at: -1 })
      .limit(100)
      .toArray();
    return { ...mapDelivery(delivery), attempts: attempts.map(mapAttempt) };
  }

  async retryDelivery(id: string, actor: WorkflowHistoryActor, reason?: string) {
    assertWebhookAdmin(actor);
    const delivery = await this.deliveries.findOne(
      { _id: id },
      { projection: { endpoint_id: 1 } },
    );
    if (!delivery) throw new NotFoundException('Webhook delivery not found');
    const endpoint = await this.endpoints.findOne({
      _id: delivery.endpoint_id,
    });
    if (!endpoint) throw new NotFoundException('Webhook endpoint not found');
    if (!endpoint.active) {
      throw new ConflictException('Webhook endpoint is inactive');
    }
    const now = new Date().toISOString();
    const result = await this.deliveries.updateOne(
      {
        _id: id,
        status: { $in: ['FAILED', 'DEAD_LETTER', 'CANCELED'] },
      },
      {
        $set: {
          status: 'PENDING',
          attempt_count: 0,
          max_attempts: endpoint.max_attempts,
          next_attempt_at: now,
          locked_by: null,
          locked_until: null,
          response_status: null,
          last_error: null,
          updated_at: now,
        },
        $inc: { manual_retry_count: 1 },
      },
    );
    if (!result.modifiedCount) {
      throw new ConflictException(
        'Only failed, dead-letter, or canceled deliveries can be retried',
      );
    }
    await this.audit.append({
      action: 'webhook.delivery.retried',
      resource_type: 'webhook_delivery',
      resource_id: id,
      actor_id: actor.actor_id,
      details: { endpoint_id: endpoint._id, reason: reason || null },
    });
    return mapDelivery((await this.deliveries.findOne({ _id: id }))!);
  }

  async getOperationalSnapshot(actor: WorkflowHistoryActor, limit = 100) {
    assertWebhookAdmin(actor);
    const [statusRows, deliveries] = await Promise.all([
      this.deliveries.aggregate<{ _id: string; count: number }>([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]).toArray(),
      this.deliveries.find({
        status: { $in: ['PENDING', 'RUNNING', 'FAILED', 'DEAD_LETTER'] },
      }).sort({ updated_at: 1 }).limit(limit).toArray(),
    ]);
    const byStatus = Object.fromEntries(statusRows.map((row) => [row._id, row.count]));
    const pending = deliveries.filter((item) => item.status === 'PENDING');
    return {
      by_status: byStatus,
      pending: byStatus.PENDING || 0,
      running: byStatus.RUNNING || 0,
      failed: byStatus.FAILED || 0,
      dead_letter: byStatus.DEAD_LETTER || 0,
      oldest_pending_at: pending[0]?.created_at || null,
      deliveries: deliveries.map(mapDelivery),
    };
  }

  async discoverEvents(limit = 200): Promise<number> {
    const sourceDb = runtimeDbType();
    const cursor = await this.cursors.findOne({ _id: sourceDb });
    const events = await this.outbox.fetchWebhookEvents(
      cursor?.last_event_id || null,
      limit,
    );
    if (!events.length) return 0;
    const endpoints = await this.endpoints.find({ active: true }).toArray();
    for (const event of events) {
      if (!FINAL_APPROVAL_EVENTS.has(event.event_type)) continue;
      const provider = String(event.payload?.source?.provider || '')
        .trim()
        .toLowerCase();
      if (!provider) continue;
      const matching = endpoints.filter(
        (endpoint) =>
          endpoint.source_provider === provider &&
          endpoint.created_at <= event.created_at,
      );
      for (const endpoint of matching) {
        await this.enqueueDelivery(sourceDb, endpoint, event);
      }
    }
    const last = events.at(-1)!;
    try {
      await this.cursors.updateOne(
        {
          _id: sourceDb,
          ...(cursor
            ? { last_event_id: cursor.last_event_id }
            : { last_event_id: { $exists: false } }),
        },
        {
          $set: {
            last_event_id: last.id,
            updated_at: new Date().toISOString(),
          },
          $setOnInsert: { created_at: new Date().toISOString() },
        },
        { upsert: !cursor },
      );
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
    }
    return events.length;
  }

  async claimDeliveries(
    owner: string,
    now: Date,
    lockUntil: Date,
    limit: number,
  ): Promise<WebhookDeliveryDocument[]> {
    const claimed: WebhookDeliveryDocument[] = [];
    const nowIso = now.toISOString();
    for (let index = 0; index < limit; index += 1) {
      const result = await this.deliveries.findOneAndUpdate(
        {
          $or: [
            {
              status: { $in: ['PENDING', 'FAILED'] },
              next_attempt_at: { $lte: nowIso },
              $expr: { $lt: ['$attempt_count', '$max_attempts'] },
            },
            { status: 'RUNNING', locked_until: { $lte: nowIso } },
          ],
        },
        {
          $set: {
            status: 'RUNNING',
            locked_by: owner,
            locked_until: lockUntil.toISOString(),
            updated_at: nowIso,
          },
          $inc: { attempt_count: 1, total_attempt_count: 1 },
        },
        { sort: { next_attempt_at: 1, created_at: 1 }, returnDocument: 'after' },
      );
      const delivery = ((result as any)?.value || result) as
        | WebhookDeliveryDocument
        | null;
      if (!delivery?._id) break;
      claimed.push(delivery);
    }
    return claimed;
  }

  async deliveryRuntime(id: string, owner: string) {
    const delivery = await this.deliveries.findOne({
      _id: id,
      status: 'RUNNING',
      locked_by: owner,
    });
    if (!delivery) return null;
    const endpoint = await this.endpoints.findOne({
      _id: delivery.endpoint_id,
      active: true,
    });
    if (!endpoint) {
      await this.finishDelivery(id, owner, {
        status: 'CANCELED',
        error: 'endpoint not found or inactive',
      });
      return null;
    }
    return {
      delivery,
      endpoint,
      secret: decryptSecret(endpoint.secret),
      body: buildWebhookPayload(delivery),
    };
  }

  async finishDelivery(
    id: string,
    owner: string,
    result:
      | { status: 'SENT'; response_status: number; duplicate?: boolean }
      | {
          status: 'FAILED' | 'DEAD_LETTER' | 'CANCELED';
          response_status?: number;
          error: string;
          next_attempt_at?: string;
        },
    attempt?: {
      started_at: string;
      completed_at: string;
      duration_ms: number;
    },
  ) {
    const now = new Date().toISOString();
    const delivery = await this.deliveries.findOne({
      _id: id,
      status: 'RUNNING',
      locked_by: owner,
    });
    if (!delivery) return false;
    await this.deliveries.updateOne(
      { _id: id, status: 'RUNNING', locked_by: owner },
      {
        $set: {
          status: result.status,
          response_status:
            'response_status' in result ? result.response_status || null : null,
          last_error: result.status === 'SENT' ? null : result.error.slice(0, 1000),
          next_attempt_at:
            result.status === 'FAILED'
              ? result.next_attempt_at || now
              : delivery.next_attempt_at,
          delivered_at: result.status === 'SENT' ? now : null,
          locked_by: null,
          locked_until: null,
          updated_at: now,
        },
      },
    );
    if (attempt) {
      await this.attempts.insertOne({
        _id: randomUUID(),
        delivery_id: id,
        endpoint_id: delivery.endpoint_id,
        attempt_number: delivery.total_attempt_count,
        status: result.status,
        response_status:
          'response_status' in result ? result.response_status || null : null,
        error: result.status === 'SENT' ? null : result.error.slice(0, 1000),
        duplicate:
          result.status === 'SENT' && 'duplicate' in result
            ? Boolean(result.duplicate)
            : false,
        ...attempt,
      });
    }
    return true;
  }

  sign(secret: string, timestamp: string, body: string): string {
    return `v1=${createHmac('sha256', secret)
      .update(`${timestamp}.${body}`)
      .digest('hex')}`;
  }

  private async enqueueDelivery(
    sourceDb: string,
    endpoint: WebhookEndpointDocument,
    event: WebhookOutboxEvent,
  ) {
    const now = new Date().toISOString();
    const eventKey = `${sourceDb}:${event.id}`;
    const id = `${endpoint._id}:${eventKey}`;
    await this.deliveries.updateOne(
      { _id: id },
      {
        $setOnInsert: {
          _id: id,
          event_key: eventKey,
          source_db: sourceDb,
          source_event_id: event.id,
          endpoint_id: endpoint._id,
          endpoint_name: endpoint.name,
          instance_id: event.instance_id,
          event_type: event.event_type,
          event_payload: event.payload,
          occurred_at: event.created_at,
          status: 'PENDING',
          attempt_count: 0,
          total_attempt_count: 0,
          manual_retry_count: 0,
          max_attempts: endpoint.max_attempts,
          next_attempt_at: now,
          locked_by: null,
          locked_until: null,
          response_status: null,
          last_error: null,
          delivered_at: null,
          created_at: now,
          updated_at: now,
        },
      },
      { upsert: true },
    );
  }

  private get endpoints() {
    return this.db.collection<WebhookEndpointDocument>('webhook_endpoints');
  }

  private get deliveries() {
    return this.db.collection<WebhookDeliveryDocument>('webhook_deliveries');
  }

  private get attempts() {
    return this.db.collection<any>('webhook_delivery_attempts');
  }

  private get cursors() {
    return this.db.collection<any>('webhook_dispatch_cursors');
  }
}

function normalizeEndpointInput(dto: CreateWebhookEndpointDto) {
  return {
    name: dto.name.trim(),
    source_provider: normalizeProvider(dto.source_provider),
    url: validateWebhookUrl(dto.url),
  };
}

function normalizeProvider(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(normalized)) {
    throw new BadRequestException('source_provider is invalid');
  }
  return normalized;
}

function validateWebhookUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestException('Webhook URL is invalid');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new BadRequestException('Webhook URL must use HTTP or HTTPS');
  }
  if (url.username || url.password || url.hash) {
    throw new BadRequestException(
      'Webhook URL must not contain credentials or fragments',
    );
  }
  if (
    process.env.NODE_ENV === 'production' &&
    url.protocol !== 'https:' &&
    process.env.WEBHOOK_ALLOW_INSECURE_HTTP !== 'true'
  ) {
    throw new BadRequestException('Webhook URL must use HTTPS in production');
  }
  return url.toString();
}

function secretHint(secret: string): string {
  return `••••${secret.slice(-4)}`;
}

function maskWebhookUrl(value: string): string {
  const url = new URL(value);
  return `${url.origin}${url.pathname === '/' ? '/' : '/…'}`;
}

function mapEndpoint(endpoint: WebhookEndpointDocument) {
  return {
    id: endpoint._id,
    name: endpoint.name,
    source_provider: endpoint.source_provider,
    url: maskWebhookUrl(endpoint.url),
    active: endpoint.active,
    timeout_ms: endpoint.timeout_ms,
    max_attempts: endpoint.max_attempts,
    has_secret: Boolean(endpoint.secret?.ciphertext),
    secret_hint: endpoint.secret_hint,
    created_by: endpoint.created_by,
    updated_by: endpoint.updated_by,
    created_at: endpoint.created_at,
    updated_at: endpoint.updated_at,
  };
}

function mapDelivery(delivery: WebhookDeliveryDocument) {
  const {
    _id: _id,
    locked_by: _lockedBy,
    locked_until: _lockedUntil,
    event_payload: eventPayload,
    ...safe
  } = delivery;
  return {
    ...safe,
    id: delivery._id,
    event_payload: eventPayload,
  };
}

function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: number }).code === 11000,
  );
}

function mapAttempt(attempt: any) {
  const { _id, ...rest } = attempt;
  return { id: _id, ...rest };
}

function buildWebhookPayload(delivery: WebhookDeliveryDocument) {
  return {
    id: delivery.event_key,
    type: delivery.event_type,
    occurred_at: delivery.occurred_at,
    data: {
      instance_id: delivery.instance_id,
      ...delivery.event_payload,
    },
  };
}

function runtimeDbType(): string {
  return process.env.DB_TYPE === 'mongodb' ? 'mongodb' : 'postgres';
}

function assertWebhookAdmin(actor: WorkflowHistoryActor): void {
  if (actor.api_key_id) {
    throw new ForbiddenException('API key cannot manage webhooks');
  }
  assertAdmin(actor);
}
