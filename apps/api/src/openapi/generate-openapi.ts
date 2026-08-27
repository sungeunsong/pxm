import { NestFactory } from '@nestjs/core';
import { writeFile } from 'fs/promises';
import { resolve } from 'path';
import { PublicApiDocsModule } from './public-api-docs.module';
import { createPublicOpenApiDocument } from './public-openapi';
import { enablePublicApiVersioning } from '../public-api-version';

async function generate() {
  const app = await NestFactory.create(PublicApiDocsModule, { logger: false });
  app.setGlobalPrefix('api');
  enablePublicApiVersioning(app);
  await app.init();
  try {
    const outputPath = resolve(process.cwd(), 'openapi.json');
    const document = createPublicOpenApiDocument(app);
    await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    process.stdout.write(`Generated ${outputPath}\n`);
  } finally {
    await app.close();
  }
}

generate().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
