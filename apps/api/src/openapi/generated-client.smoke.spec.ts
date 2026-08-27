import { Test } from '@nestjs/testing';
import createClient from 'openapi-fetch';
import type { paths } from './openapi.generated';
import { PublicApiDocsModule } from './public-api-docs.module';
import { enablePublicApiVersioning } from '../public-api-version';
import { TemplatesService } from '../templates/templates.service';
import { InstancesService } from '../instances/instances.service';
import { OutboxService } from '../outbox/outbox.service';
import { WorkflowInstanceRepositoryPort } from '../db/ports/db.ports';
import { AuthzService } from '../authz/authz.service';

describe('generated OpenAPI client smoke flow', () => {
  it('lists and executes a workflow, then reads its trace', async () => {
    const previousBypass = process.env.AUTHZ_ALLOW_DEVELOPMENT_BYPASS;
    process.env.AUTHZ_ALLOW_DEVELOPMENT_BYPASS = 'true';
    const workflow = {
      id: 'workflow-1', name: 'Purchase approval', description: 'Purchase request',
      group_id: 'group-a', group: 'Finance', tags: ['approval'], version: 1,
      lifecycle_status: 'PUBLISHED', active_published_version: 1, has_unpublished_changes: false,
      is_active: true, nodes: [{ id: 'start', data: { nodeType: 'start' } }], edges: [],
      created_at: new Date(), updated_at: new Date(),
    };
    const templates = {
      findAll: jest.fn().mockResolvedValue([workflow]),
      findPublishedAll: jest.fn().mockResolvedValue([workflow]),
      findOne: jest.fn().mockResolvedValue(workflow),
      findPublished: jest.fn().mockResolvedValue(workflow),
    };
    const instances = {
      findAll: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue({ id: 'instance-1', state: 'RUNNING' }),
      ensureReadableInstance: jest.fn().mockResolvedValue(undefined),
    };
    const outbox = {
      fetchTrace: jest.fn().mockResolvedValue([{ id: 1, event_type: 'STARTED', created_at: '2026-08-27T00:00:00.000Z' }]),
    };
    const instanceRepo = {
      executeInstanceMutation: jest.fn().mockResolvedValue(undefined),
      createIdempotentStart: jest.fn().mockImplementation(async (request) => ({
        outcome: 'created', instance_id: request.instance.id,
      })),
    };
    const moduleBuilder = Test.createTestingModule({ imports: [PublicApiDocsModule] })
      .overrideProvider(TemplatesService).useValue(templates)
      .overrideProvider(InstancesService).useValue(instances)
      .overrideProvider(OutboxService).useValue(outbox)
      .overrideProvider(AuthzService).useValue({ getGroup: jest.fn().mockResolvedValue({ id: 'group-a', name: 'Finance' }) })
      .overrideProvider(WorkflowInstanceRepositoryPort).useValue(instanceRepo);
    const moduleRef = await moduleBuilder.compile();
    const app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    enablePublicApiVersioning(app);
    await app.listen(0);

    try {
      const client = createClient<paths>({ baseUrl: await app.getUrl() });
      const listed = await client.GET('/api/v1/templates', { params: { query: { activeOnly: true } } });
      expect(listed.error).toBeUndefined();
      expect(listed.data?.[0]?.id).toBe('workflow-1');

      const started = await client.POST('/api/v1/templates/{id}/execute', {
        params: { path: { id: 'workflow-1' }, header: { 'Idempotency-Key': 'generated-client-smoke' } },
        body: { mode: 'async', formData: { amount: 125000 } },
      });
      expect(started.error).toBeUndefined();
      expect(started.response.status).toBe(202);
      expect(started.data?.instance_id).toEqual(expect.any(String));

      const trace = await client.GET('/api/v1/instances/{id}/trace', {
        params: { path: { id: started.data!.instance_id } },
      });
      expect(trace.error).toBeUndefined();
      expect(trace.data?.[0]?.event_type).toBe('STARTED');
    } finally {
      await app.close();
      if (previousBypass === undefined) delete process.env.AUTHZ_ALLOW_DEVELOPMENT_BYPASS;
      else process.env.AUTHZ_ALLOW_DEVELOPMENT_BYPASS = previousBypass;
    }
  });
});
