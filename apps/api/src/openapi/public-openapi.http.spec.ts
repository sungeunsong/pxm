import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PublicApiDocsModule } from './public-api-docs.module';
import { createPublicOpenApiDocument, setupPublicApiDocs } from './public-openapi';
import { enablePublicApiVersioning } from '../public-api-version';

const EXPECTED_PUBLIC_PATHS = [
  '/api/v1/instances',
  '/api/v1/instances/{id}',
  '/api/v1/instances/{id}/result',
  '/api/v1/instances/{id}/stream',
  '/api/v1/instances/{id}/trace',
  '/api/v1/instances/{instanceId}/tasks',
  '/api/v1/tasks',
  '/api/v1/tasks/history',
  '/api/v1/tasks/{id}',
  '/api/v1/tasks/{id}/complete',
  '/api/v1/templates',
  '/api/v1/templates/{id}',
  '/api/v1/templates/{id}/execute',
  '/api/v1/templates/{id}/start',
].sort();

describe('PXM public OpenAPI', () => {
  async function createDocsApp() {
    const moduleRef = await Test.createTestingModule({ imports: [PublicApiDocsModule] }).compile();
    const app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    enablePublicApiVersioning(app);
    return app;
  }

  it('contains only the supported v1 public contract', async () => {
    const app = await createDocsApp();
    await app.init();
    try {
      const document = createPublicOpenApiDocument(app);
      expect(Object.keys(document.paths).sort()).toEqual(EXPECTED_PUBLIC_PATHS);
      expect(Object.keys(document.paths).every((path) => path.startsWith('/api/v1/'))).toBe(true);
      expect(JSON.stringify(document)).not.toContain('/api/authz');
      expect(JSON.stringify(document)).not.toContain('CreateTemplateDto');
      expect(JSON.stringify(document)).not.toMatch(/pxm_live_[A-Za-z0-9_-]{20,}/);
      expect((document as any).webhooks.workflowResult.post.requestBody).toBeDefined();

      for (const pathItem of Object.values(document.paths)) {
        for (const operation of Object.values(pathItem || {}) as any[]) {
          if (!operation || typeof operation !== 'object' || !operation.responses) continue;
          expect(operation.security).toContainEqual({ 'api-key': [] });
          expect(operation.parameters).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'X-Request-ID', in: 'header' }),
          ]));
        }
      }
    } finally {
      await app.close();
    }
  });

  it('serves Swagger UI and the generated JSON document', async () => {
    const app = await createDocsApp();
    const expected = setupPublicApiDocs(app);
    await app.init();
    try {
      await request(app.getHttpServer()).get('/api/docs').expect(200).expect('content-type', /text\/html/);
      const response = await request(app.getHttpServer()).get('/api/docs/openapi.json').expect(200);
      expect(response.body).toEqual(expected);
    } finally {
      await app.close();
    }
  });

  it('keeps the checked-in build artifact synchronized', async () => {
    const app = await createDocsApp();
    await app.init();
    try {
      const generated = createPublicOpenApiDocument(app);
      const artifact = JSON.parse(await readFile(resolve(process.cwd(), 'openapi.json'), 'utf8'));
      expect(artifact).toEqual(generated);
    } finally {
      await app.close();
    }
  });
});
