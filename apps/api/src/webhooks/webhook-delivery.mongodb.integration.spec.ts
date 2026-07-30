import { createHmac } from 'crypto';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { Db, MongoClient } from 'mongodb';
import { MongodbAdapter } from '../db/adapters/mongodb.adapter';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { WebhookDispatcher } from './webhook-dispatcher';

const describeMongo =
  process.env.RUN_MONGO_INTEGRATION === 'true' ? describe : describe.skip;

describeMongo('Webhook delivery HTTP integration', () => {
  let client: MongoClient;
  let db: Db;
  let server: Server;
  let endpointUrl: string;
  let allowCanceled = false;
  const requests: Array<{
    eventId: string;
    signature: string;
    timestamp: string;
    body: string;
  }> = [];
  const secret = 'pxm-webhook-integration-secret-0001';
  const originalDbType = process.env.DB_TYPE;
  const originalDelay = process.env.WEBHOOK_INITIAL_RETRY_DELAY_MS;

  beforeAll(async () => {
    process.env.DB_TYPE = 'mongodb';
    process.env.WEBHOOK_INITIAL_RETRY_DELAY_MS = '1';
    client = new MongoClient(
      process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017',
    );
    await client.connect();
    db = client.db(`pxm_webhook_test_${process.pid}_${Date.now()}`);
    server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        const eventId = String(request.headers['x-pxm-event-id'] || '');
        const signature = String(request.headers['x-pxm-signature'] || '');
        const timestamp = String(request.headers['x-pxm-timestamp'] || '');
        requests.push({ eventId, signature, timestamp, body });
        const type = JSON.parse(body).type;
        const expected = `v1=${createHmac('sha256', secret)
          .update(`${timestamp}.${body}`)
          .digest('hex')}`;
        if (
          request.headers['idempotency-key'] !== eventId ||
          signature !== expected
        ) {
          response.statusCode = 401;
          response.end('invalid signature');
          return;
        }
        if (
          type === 'APPROVAL_REQUEST_APPROVED' &&
          requests.filter((item) => item.eventId === eventId).length === 1
        ) {
          response.statusCode = 503;
          response.end('temporary failure');
          return;
        }
        if (type === 'APPROVAL_REQUEST_REJECTED') {
          response.statusCode = 409;
          response.end('already processed');
          return;
        }
        if (type === 'APPROVAL_REQUEST_CANCELED' && !allowCanceled) {
          response.statusCode = 400;
          response.end('invalid request');
          return;
        }
        response.statusCode = 204;
        response.end();
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    endpointUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/pxm`;
  }, 30_000);

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    if (db) await db.dropDatabase();
    if (client) await client.close();
    if (originalDbType === undefined) delete process.env.DB_TYPE;
    else process.env.DB_TYPE = originalDbType;
    if (originalDelay === undefined)
      delete process.env.WEBHOOK_INITIAL_RETRY_DELAY_MS;
    else process.env.WEBHOOK_INITIAL_RETRY_DELAY_MS = originalDelay;
  }, 30_000);

  it('delivers signed final events with retry, duplicate handling, DLQ, and manual replay', async () => {
    const events = [
      event('1', 'APPROVAL_REQUEST_APPROVED'),
      event('2', 'APPROVAL_REQUEST_REJECTED'),
      event('3', 'APPROVAL_REQUEST_CANCELED'),
    ];
    const outbox = {
      fetchWebhookEvents: jest.fn(async (afterId: string | null) =>
        events.filter((item) => !afterId || Number(item.id) > Number(afterId)),
      ),
    };
    const audit = { append: jest.fn().mockResolvedValue(undefined) };
    const service = new WebhookDeliveryService(
      db,
      outbox as any,
      audit as any,
    );
    await service.onModuleInit();
    const admin = {
      actor_type: 'user',
      actor_id: 'admin',
      roles: ['admin'],
      group_ids: [],
      group_roles: {},
      allowed_workflow_ids: [],
      owned_workflow_ids: [],
    } as any;
    const endpoint = await service.createEndpoint(
      {
        name: 'AcraPoint test',
        source_provider: 'acrapoint',
        url: endpointUrl,
        secret,
        timeout_ms: 1_000,
        max_attempts: 3,
      },
      admin,
    );
    expect(endpoint).toMatchObject({
      url: expect.stringContaining('/…'),
      secret_hint: '••••0001',
      has_secret: true,
    });
    expect(JSON.stringify(endpoint)).not.toContain(secret);

    const dispatcher = new WebhookDispatcher(service);
    await dispatcher.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await dispatcher.tick();
    await dispatcher.tick();

    const deliveries = await service.listDeliveries({ limit: 20 }, admin);
    expect(
      deliveries.map((item) => [item.event_type, item.status]),
    ).toEqual(
      expect.arrayContaining([
        ['APPROVAL_REQUEST_APPROVED', 'SENT'],
        ['APPROVAL_REQUEST_REJECTED', 'SENT'],
        ['APPROVAL_REQUEST_CANCELED', 'DEAD_LETTER'],
      ]),
    );
    const approved = deliveries.find((item) =>
      item.event_type.endsWith('APPROVED'),
    )!;
    const rejected = deliveries.find((item) =>
      item.event_type.endsWith('REJECTED'),
    )!;
    const canceled = deliveries.find((item) =>
      item.event_type.endsWith('CANCELED'),
    )!;
    expect(approved.total_attempt_count).toBe(2);
    expect(rejected.response_status).toBe(409);
    expect(requests.filter((item) => item.eventId === approved.event_key)).toHaveLength(
      2,
    );

    allowCanceled = true;
    await service.retryDelivery(canceled.id, admin);
    await dispatcher.tick();
    expect((await service.getDelivery(canceled.id, admin)).status).toBe('SENT');
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'webhook.delivery.retried' }),
    );

    await dispatcher.tick();
    expect(requests).toHaveLength(5);
    await expect(
      service.listEndpoints({
        ...admin,
        actor_id: 'ordinary-user',
        roles: ['user'],
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('reads only final approval events from the Mongo outbox with a stable cursor', async () => {
    const instanceId = `webhook-outbox-${Date.now()}`;
    await db.collection('v2_event_outbox').insertMany([
      {
        instance_id: instanceId,
        event_type: 'TASK_APPROVED',
        payload: {},
        created_at: new Date().toISOString(),
      },
      {
        instance_id: instanceId,
        event_type: 'APPROVAL_REQUEST_APPROVED',
        payload: { source: { provider: 'acrapoint' } },
        created_at: new Date().toISOString(),
      },
      {
        instance_id: instanceId,
        event_type: 'APPROVAL_REQUEST_CANCELED',
        payload: { source: { provider: 'acrapoint' } },
        created_at: new Date().toISOString(),
      },
    ]);
    try {
      const adapter = new MongodbAdapter(db);
      const first = await adapter.fetchWebhookEvents(null, 1);
      expect(first).toHaveLength(1);
      expect(first[0].event_type).toBe('APPROVAL_REQUEST_APPROVED');
      const next = await adapter.fetchWebhookEvents(first[0].id, 10);
      expect(next.map((item) => item.event_type)).toEqual([
        'APPROVAL_REQUEST_CANCELED',
      ]);
    } finally {
      await db
        .collection('v2_event_outbox')
        .deleteMany({ instance_id: instanceId });
    }
  });

  it('reclaims an expired in-flight delivery even after its last configured attempt', async () => {
    const id = `expired-delivery-${Date.now()}`;
    await db.collection('webhook_deliveries').insertOne({
      _id: id,
      status: 'RUNNING',
      attempt_count: 3,
      total_attempt_count: 3,
      max_attempts: 3,
      next_attempt_at: new Date(Date.now() - 60_000).toISOString(),
      locked_by: 'dead-worker',
      locked_until: new Date(Date.now() - 1_000).toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const service = new WebhookDeliveryService(
      db,
      {} as any,
      { append: jest.fn() } as any,
    );
    try {
      const claimed = await service.claimDeliveries(
        'recovery-worker',
        new Date(),
        new Date(Date.now() + 60_000),
        1,
      );
      expect(claimed[0]).toMatchObject({
        _id: id,
        locked_by: 'recovery-worker',
        attempt_count: 4,
      });
    } finally {
      await db.collection('webhook_deliveries').deleteOne({ _id: id });
    }
  });
});

function event(id: string, eventType: string) {
  return {
    id,
    instance_id: `00000000-0000-0000-0000-00000000000${id}`,
    token_id: null,
    node_id: 'approval',
    event_type: eventType,
    payload: {
      approval_request_id: `request-${id}`,
      status: eventType.split('_').at(-1),
      source: {
        provider: 'acrapoint',
        request_id: `ACRA-${id}`,
        revision: 1,
      },
    },
    created_at: new Date(Date.now() + 1_000 + Number(id)).toISOString(),
  };
}
