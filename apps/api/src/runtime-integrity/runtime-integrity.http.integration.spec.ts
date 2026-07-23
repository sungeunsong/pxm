import {
  MiddlewareConsumer,
  Module,
  NestModule,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { Db, MongoClient } from 'mongodb';
import request from 'supertest';
import { ManagementAuditService } from '../audit/management-audit.service';
import { MONGO_DB } from '../db/mongo.provider';
import { RuntimeIntegrityController } from './runtime-integrity.controller';
import { RuntimeIntegrityService } from './runtime-integrity.service';

const describeMongo =
  process.env.RUN_MONGO_INTEGRATION === 'true' ? describe : describe.skip;
let testDb: Db;

@Module({
  controllers: [RuntimeIntegrityController],
  providers: [
    { provide: MONGO_DB, useFactory: () => testDb },
    ManagementAuditService,
    RuntimeIntegrityService,
  ],
})
class RuntimeIntegrityHttpTestModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((req: Request, _res: Response, next: NextFunction) => {
        const role = String(req.headers['x-test-role'] || 'user');
        (req as any).workflowActor = {
          actor_type: 'user',
          actor_id: role === 'admin' ? 'runtime-admin' : 'runtime-user',
          roles: [role],
          scopes: [],
          workspace_ids: ['default'],
          group_ids: [],
          owned_workflow_ids: [],
          allowed_workflow_ids: [],
          allowed_instance_ids: [],
          api_key_id: null,
          business_actor: null,
        };
        next();
      })
      .forRoutes('*');
  }
}

describeMongo('Runtime integrity admin HTTP recovery', () => {
  let client: MongoClient;
  let app: any;
  const databaseName = `pxm_runtime_integrity_test_${process.pid}_${Date.now()}`;
  const definitionId = randomUUID();
  const stalledInstanceId = randomUUID();
  const waitingInstanceId = randomUUID();
  const missingDefinitionInstanceId = randomUUID();
  const orphanInstanceId = randomUUID();
  const recentOrphanInstanceId = randomUUID();
  const activeTokenId = randomUUID();
  const waitingTokenId = randomUUID();
  const orphanTokenId = randomUUID();
  const orphanTaskId = randomUUID();
  const recentOrphanTaskId = randomUUID();
  const orphanJobId = 91;
  const oldTimestamp = new Date(Date.now() - 120_000).toISOString();

  beforeAll(async () => {
    client = new MongoClient(
      process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017/?replicaSet=rs0',
    );
    await client.connect();
    testDb = client.db(databaseName);
    await seedFixture();

    const moduleRef = await Test.createTestingModule({
      imports: [RuntimeIntegrityHttpTestModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
    await testDb.dropDatabase();
    await client.close();
  });

  it('allows only admins to scan and does not report recent transient records', async () => {
    await request(app.getHttpServer())
      .post('/api/runtime-integrity/scan')
      .set('x-test-role', 'user')
      .send({ min_age_seconds: 60 })
      .expect(403);

    const response = await request(app.getHttpServer())
      .post('/api/runtime-integrity/scan')
      .set('x-test-role', 'admin')
      .send({ min_age_seconds: 60 })
      .expect(201);

    expect(response.body.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'ORPHAN_JOB',
          resource_id: String(orphanJobId),
          repair: expect.objectContaining({ supported: true }),
        }),
        expect.objectContaining({
          type: 'ORPHAN_TOKEN',
          resource_id: orphanTokenId,
        }),
        expect.objectContaining({
          type: 'ORPHAN_TASK',
          resource_id: orphanTaskId,
        }),
        expect.objectContaining({
          type: 'STALLED_INSTANCE',
          resource_id: stalledInstanceId,
        }),
        expect.objectContaining({
          type: 'WAITING_APPROVAL_WITHOUT_TASK',
          resource_id: waitingInstanceId,
          repair: expect.objectContaining({ supported: false }),
        }),
        expect.objectContaining({
          type: 'INSTANCE_MISSING_DEFINITION',
          resource_id: missingDefinitionInstanceId,
          repair: expect.objectContaining({ supported: false }),
        }),
      ]),
    );
    expect(response.body.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resource_id: recentOrphanTaskId }),
      ]),
    );
  });

  it('rechecks an orphan job, repairs it once, and records one audit event', async () => {
    const repair = () =>
      request(app.getHttpServer())
        .post('/api/runtime-integrity/repair')
        .set('x-test-role', 'admin')
        .set('Idempotency-Key', 'orphan-job-repair')
        .send({
          finding_type: 'ORPHAN_JOB',
          resource_id: String(orphanJobId),
          observed_updated_at: oldTimestamp,
          reason: '연결된 실행이 없어 운영자가 정리',
        })
        .expect(201);

    const first = await repair();
    expect(first.body).toEqual(
      expect.objectContaining({
        outcome: 'repaired',
        idempotent_replay: false,
      }),
    );
    const replay = await repair();
    expect(replay.body).toEqual(
      expect.objectContaining({ outcome: 'repaired', idempotent_replay: true }),
    );
    expect(replay.headers['idempotency-replayed']).toBe('true');

    expect(
      await testDb.collection('v2_engine_jobs').findOne({ _id: orphanJobId }),
    ).toEqual(expect.objectContaining({ status: 'FAILED' }));
    expect(
      await testDb.collection('management_audit_logs').countDocuments({
        action: 'runtime_integrity.repair',
        resource_id: String(orphanJobId),
      }),
    ).toBe(1);

    await request(app.getHttpServer())
      .post('/api/runtime-integrity/repair')
      .set('x-test-role', 'admin')
      .set('Idempotency-Key', 'orphan-job-repair')
      .send({
        finding_type: 'ORPHAN_TOKEN',
        resource_id: orphanTokenId,
        observed_updated_at: oldTimestamp,
        reason: '같은 키를 다른 대상에 사용할 수 없음',
      })
      .expect(409);
  });

  it('requeues a stalled instance once and refuses a stale second repair', async () => {
    const payload = {
      finding_type: 'STALLED_INSTANCE',
      resource_id: stalledInstanceId,
      observed_updated_at: oldTimestamp,
      reason: '활성 토큰은 있지만 처리 작업이 없어 재개',
    };
    const first = await request(app.getHttpServer())
      .post('/api/runtime-integrity/repair')
      .set('x-test-role', 'admin')
      .set('Idempotency-Key', 'stalled-instance-repair-1')
      .send(payload)
      .expect(201);
    expect(first.body.outcome).toBe('repaired');
    expect(
      await testDb.collection('v2_engine_jobs').countDocuments({
        instance_id: stalledInstanceId,
        status: 'QUEUED',
        job_type: 'RESUME',
      }),
    ).toBe(1);

    const stale = await request(app.getHttpServer())
      .post('/api/runtime-integrity/repair')
      .set('x-test-role', 'admin')
      .set('Idempotency-Key', 'stalled-instance-repair-2')
      .send(payload)
      .expect(201);
    expect(stale.body.outcome).toBe('no_longer_present');
    expect(
      await testDb
        .collection('v2_engine_jobs')
        .countDocuments({ instance_id: stalledInstanceId }),
    ).toBe(1);
  });

  it('safely closes orphan tokens and tasks but refuses automatic approval reconstruction', async () => {
    const repairs = [
      {
        finding_type: 'ORPHAN_TOKEN',
        resource_id: orphanTokenId,
        collection: 'v2_tokens',
        status: 'FAILED',
      },
      {
        finding_type: 'ORPHAN_TASK',
        resource_id: orphanTaskId,
        collection: 'v2_tasks',
        status: 'CANCELED',
      },
    ];
    for (const item of repairs) {
      const response = await request(app.getHttpServer())
        .post('/api/runtime-integrity/repair')
        .set('x-test-role', 'admin')
        .set('Idempotency-Key', `repair-${item.finding_type.toLowerCase()}`)
        .send({
          finding_type: item.finding_type,
          resource_id: item.resource_id,
          observed_updated_at: oldTimestamp,
          reason: '연결된 실행 정보가 없어 안전하게 정리',
        })
        .expect(201);
      expect(response.body.outcome).toBe('repaired');
      expect(
        await testDb.collection(item.collection).findOne({ _id: item.resource_id }),
      ).toEqual(expect.objectContaining({ status: item.status }));
    }

    await request(app.getHttpServer())
      .post('/api/runtime-integrity/repair')
      .set('x-test-role', 'admin')
      .set('Idempotency-Key', 'unsafe-approval-repair')
      .send({
        finding_type: 'WAITING_APPROVAL_WITHOUT_TASK',
        resource_id: waitingInstanceId,
        observed_updated_at: oldTimestamp,
        reason: '자동 재생성 시도 금지 확인',
      })
      .expect(400);
  });

  async function seedFixture() {
    const old = oldTimestamp;
    const recent = new Date().toISOString();
    await testDb
      .collection('v2_counters')
      .insertOne({ _id: 'v2_engine_jobs', seq: 1_000 });
    await testDb.collection('v2_process_definitions').insertOne({
      _id: definitionId,
      name: 'Integrity test workflow',
      nodes: [
        { node_id: 'start', node_type: 'start', config: { nodeType: 'start' } },
        {
          node_id: 'approval',
          node_type: 'approval',
          config: { nodeType: 'approval' },
        },
      ],
      edges: [],
      created_at: old,
      updated_at: old,
    });
    await testDb
      .collection('v2_process_instances')
      .insertMany([
        instance(stalledInstanceId, definitionId, 'RUNNING', old),
        instance(waitingInstanceId, definitionId, 'WAITING', old),
        instance(missingDefinitionInstanceId, randomUUID(), 'RUNNING', old),
      ]);
    await testDb
      .collection('v2_tokens')
      .insertMany([
        token(activeTokenId, stalledInstanceId, 'start', 'ACTIVE', old),
        token(waitingTokenId, waitingInstanceId, 'approval', 'WAITING', old),
        token(orphanTokenId, orphanInstanceId, 'start', 'ACTIVE', old),
      ]);
    await testDb
      .collection('v2_tasks')
      .insertMany([
        task(orphanTaskId, orphanInstanceId, old),
        task(recentOrphanTaskId, recentOrphanInstanceId, recent),
      ]);
    await testDb.collection('v2_engine_jobs').insertOne({
      _id: orphanJobId,
      instance_id: orphanInstanceId,
      token_id: null,
      job_type: 'START',
      run_at: old,
      attempt: 0,
      status: 'RUNNING',
      payload: {},
      created_at: old,
      updated_at: old,
    });
  }
});

function instance(
  id: string,
  definitionId: string,
  state: string,
  timestamp: string,
) {
  return {
    _id: id,
    process_definition_id: definitionId,
    state,
    status: state,
    context: {},
    lock_owner: null,
    lock_until: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function token(
  id: string,
  instanceId: string,
  nodeId: string,
  status: string,
  timestamp: string,
) {
  return {
    _id: id,
    instance_id: instanceId,
    node_id: nodeId,
    status,
    parent_token_id: null,
    scope_key: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function task(id: string, instanceId: string, timestamp: string) {
  return {
    _id: id,
    instance_id: instanceId,
    token_id: null,
    node_id: 'approval',
    assignee: 'admin',
    status: 'OPEN',
    payload: {},
    created_at: timestamp,
    updated_at: timestamp,
  };
}
