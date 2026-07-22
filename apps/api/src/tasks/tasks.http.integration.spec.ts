import { MiddlewareConsumer, Module, NestModule, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { createHash, randomUUID } from 'crypto';
import { Db, MongoClient } from 'mongodb';
import request from 'supertest';
import { AuthenticatedGuard } from '../authz/authenticated.guard';
import { ApiKeyAuthMiddleware } from '../authz/api-key-auth.middleware';
import { AuthzService } from '../authz/authz.service';
import { ManagementAuditService } from '../audit/management-audit.service';
import { MongodbAdapter } from '../db/adapters/mongodb.adapter';
import { MONGO_DB } from '../db/mongo.provider';
import {
  AuthzRepositoryPort,
  WorkflowInstanceRepositoryPort,
  WorkflowRepositoryPort,
  WorkflowTaskRepositoryPort,
} from '../db/ports/db.ports';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

const describeHttp = process.env.RUN_TASK_HTTP_INTEGRATION === 'true' ? describe : describe.skip;
let testDb: Db;

@Module({
  controllers: [TasksController],
  providers: [
    { provide: MONGO_DB, useFactory: () => testDb },
    MongodbAdapter,
    { provide: AuthzRepositoryPort, useExisting: MongodbAdapter },
    { provide: WorkflowRepositoryPort, useExisting: MongodbAdapter },
    { provide: WorkflowInstanceRepositoryPort, useExisting: MongodbAdapter },
    { provide: WorkflowTaskRepositoryPort, useExisting: MongodbAdapter },
    AuthzService,
    ApiKeyAuthMiddleware,
    ManagementAuditService,
    TasksService,
    { provide: APP_GUARD, useClass: AuthenticatedGuard },
  ],
})
class TaskHttpTestModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(ApiKeyAuthMiddleware).forRoutes('*');
  }
}

describeHttp('Approval task USER API key HTTP authorization', () => {
  let client: MongoClient;
  let app: any;
  const groupId = randomUUID();
  const workflowId = randomUUID();
  const otherWorkflowId = randomUUID();
  const instanceId = randomUUID();
  const taskId = randomUUID();
  const allowedKeyId = randomUUID();
  const missingScopeKeyId = randomUUID();
  const wrongWorkflowKeyId = randomUUID();
  const allowedKey = `pxm_live_${randomUUID().replaceAll('-', '')}`;
  const missingScopeKey = `pxm_live_${randomUUID().replaceAll('-', '')}`;
  const wrongWorkflowKey = `pxm_live_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    client = new MongoClient(process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017');
    await client.connect();
    testDb = client.db(process.env.MONGO_DB_NAME || 'pxm_db');
    const now = new Date().toISOString();
    await testDb.collection('pxm_groups').insertOne({ _id: groupId, name: 'Task HTTP test', status: 'active', created_at: now, updated_at: now });
    await testDb.collection('v2_process_instances').insertOne({
      _id: instanceId,
      process_definition_id: workflowId,
      state: 'WAITING',
      status: 'WAITING',
      group_id: groupId,
      context: { runtime: { access: { group_id: groupId } } },
      created_at: now,
      updated_at: now,
    });
    await testDb.collection('v2_tasks').insertOne({
      _id: taskId,
      instance_id: instanceId,
      token_id: null,
      node_id: 'approval',
      assignee: 'alice',
      status: 'OPEN',
      payload: {},
      created_at: now,
      updated_at: now,
    });
    await testDb.collection('pxm_api_keys').insertMany([
      apiKeyDoc(allowedKeyId, allowedKey, groupId, ['task:approve'], [workflowId], now),
      apiKeyDoc(missingScopeKeyId, missingScopeKey, groupId, ['workflow:read'], [workflowId], now),
      apiKeyDoc(wrongWorkflowKeyId, wrongWorkflowKey, groupId, ['task:approve'], [otherWorkflowId], now),
    ]);

    const moduleRef = await Test.createTestingModule({ imports: [TaskHttpTestModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
    await Promise.all([
      testDb.collection('pxm_api_key_usage_logs').deleteMany({ api_key_id: { $in: [allowedKeyId, missingScopeKeyId, wrongWorkflowKeyId] } }),
      testDb.collection('management_audit_logs').deleteMany({ _id: `task:${taskId}:completion` }),
      testDb.collection('pxm_api_keys').deleteMany({ _id: { $in: [allowedKeyId, missingScopeKeyId, wrongWorkflowKeyId] } }),
      testDb.collection('v2_engine_jobs').deleteMany({ instance_id: instanceId }),
      testDb.collection('v2_tasks').deleteMany({ _id: taskId }),
      testDb.collection('v2_process_instances').deleteMany({ _id: instanceId }),
      testDb.collection('pxm_groups').deleteMany({ _id: groupId }),
    ]);
    await client.close();
  });

  it('rejects a key without task:approve scope', async () => {
    await request(app.getHttpServer())
      .get('/api/tasks')
      .set('Authorization', `Bearer ${missingScopeKey}`)
      .expect(403);
  });

  it('hides tasks outside allowed_workflow_ids', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/tasks')
      .set('Authorization', `Bearer ${wrongWorkflowKey}`)
      .expect(200);
    expect(response.body).toEqual([]);
  });

  it('allows a USER owner key once and reuses the idempotent result', async () => {
    const list = await request(app.getHttpServer())
      .get('/api/tasks')
      .set('Authorization', `Bearer ${allowedKey}`)
      .expect(200);
    expect(list.body).toEqual([expect.objectContaining({ id: taskId, assignee: 'alice' })]);

    const perform = () => request(app.getHttpServer())
      .post(`/api/tasks/${taskId}/complete`)
      .set('Authorization', `Bearer ${allowedKey}`)
      .set('Idempotency-Key', 'api-key-http-1')
      .set('x-business-actor', JSON.stringify({ employee_id: 'E-100' }))
      .send({ action: 'approve', comment: 'API key HTTP E2E' })
      .expect(201);
    expect((await perform()).body.already_processed).toBe(false);
    expect((await perform()).body.already_processed).toBe(true);

    expect(await testDb.collection('v2_engine_jobs').countDocuments({ instance_id: instanceId, job_type: 'RESUME' })).toBe(1);
    expect(await testDb.collection('management_audit_logs').countDocuments({ _id: `task:${taskId}:completion`, api_key_id: allowedKeyId })).toBe(1);
  });
});

function apiKeyDoc(id: string, rawKey: string, groupId: string, scopes: string[], workflowIds: string[], now: string) {
  return {
    _id: id,
    name: 'Task HTTP test key',
    owner_type: 'USER',
    owner_id: 'alice',
    group_id: groupId,
    key_prefix: rawKey.slice(0, 18),
    key_hash: createHash('sha256').update(rawKey).digest('hex'),
    scopes,
    allowed_workflow_ids: workflowIds,
    ip_allowlist: [],
    rate_limit_per_minute: null,
    status: 'active',
    expires_at: null,
    created_at: now,
    updated_at: now,
  };
}
