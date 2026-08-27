import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, getSchemaPath, type OpenAPIObject } from '@nestjs/swagger';
import { WorkflowResultWebhookDto } from './public-api.dto';

export const PUBLIC_OPENAPI_JSON_PATH = '/api/docs/openapi.json';

export function createPublicOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('PXM Public API')
    .setDescription('워크플로우 실행, 인스턴스 조회, 결재 처리를 위한 PXM 공개 API입니다.')
    .setVersion('1.0.0-beta')
    .addBearerAuth({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'PXM API Key',
      description: 'Authorization: Bearer pxm_live_...',
    }, 'api-key')
    .build();
  const document = SwaggerModule.createDocument(app, config, {
    extraModels: [WorkflowResultWebhookDto],
    operationIdFactory: (controllerKey, methodKey) => `${controllerKey.replace(/Controller$/, '')}_${methodKey.replace(/\[\d+\]$/, '')}`,
  });

  document.paths = Object.fromEntries(
    Object.entries(document.paths).filter(([path]) => path.startsWith('/api/v1/')),
  );
  document.openapi = '3.1.0';
  (document as any).webhooks = {
    workflowResult: {
      post: {
        tags: ['Webhooks'],
        summary: 'PXM이 외부 시스템으로 전송하는 최종 결재 결과',
        description: [
          '서명 입력은 `${X-PXM-Timestamp}.${raw_request_body}`이며 HMAC-SHA256으로 검증합니다. 동일 Idempotency-Key는 중복 처리하지 않습니다.',
          '',
          '```js',
          "const expected = 'v1=' + createHmac('sha256', secret)",
          "  .update(`${timestamp}.${rawBody}`)",
          "  .digest('hex');",
          'const valid = timingSafeEqual(Buffer.from(signature), Buffer.from(expected));',
          '```',
        ].join('\n'),
        parameters: [
          { in: 'header', name: 'X-PXM-Event-Id', required: true, schema: { type: 'string' } },
          { in: 'header', name: 'X-PXM-Timestamp', required: true, schema: { type: 'string', example: '1785373200' } },
          { in: 'header', name: 'X-PXM-Signature', required: true, schema: { type: 'string', example: 'v1=<hex hmac sha256>' } },
          { in: 'header', name: 'Idempotency-Key', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: getSchemaPath(WorkflowResultWebhookDto) } } },
        },
        responses: {
          '200': { description: '처리 성공' },
          '409': { description: '이미 처리한 이벤트' },
        },
      },
    },
  };
  pruneUnusedSchemas(document);
  return document;
}

export function setupPublicApiDocs(app: INestApplication): OpenAPIObject {
  const document = createPublicOpenApiDocument(app);
  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: PUBLIC_OPENAPI_JSON_PATH,
    customSiteTitle: 'PXM Public API Docs',
    swaggerOptions: { persistAuthorization: false, displayRequestDuration: true },
  });
  return document;
}

function pruneUnusedSchemas(document: OpenAPIObject) {
  const schemas = document.components?.schemas || {};
  const used = new Set<string>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    for (const [key, nested] of Object.entries(value)) {
      if (key === '$ref' && typeof nested === 'string' && nested.startsWith('#/components/schemas/')) {
        const name = nested.slice('#/components/schemas/'.length);
        if (!used.has(name)) {
          used.add(name);
          visit(schemas[name]);
        }
      } else {
        visit(nested);
      }
    }
  };
  visit(document.paths);
  visit((document as any).webhooks);
  if (document.components) {
    document.components.schemas = Object.fromEntries(
      Object.entries(schemas).filter(([name]) => used.has(name)),
    );
  }
}
