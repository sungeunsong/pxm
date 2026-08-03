import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { existsSync } from 'fs';
import helmet from 'helmet';
import { join, resolve } from 'path';
import { AppModule } from './app.module';
import { corsOptions, trustProxySetting } from './security/http-security';
import { validateProductionConfig } from './security/production-config';

async function bootstrap() {
  validateProductionConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Global prefix 설정 (/api/...)
  app.setGlobalPrefix('api');

  const trustProxy = trustProxySetting();
  if (trustProxy !== false) app.set('trust proxy', trustProxy);

  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'same-origin' },
  }));
  app.enableCors(corsOptions());
  app.useGlobalPipes(new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: false,
    stopAtFirstError: false,
  }));

  const webDistDir = resolveWebDistDir();
  if (webDistDir) {
    app.useStaticAssets(webDistDir, { index: false });
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) {
        return next();
      }
      return res.sendFile(join(webDistDir, 'index.html'));
    });
  }

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();

function resolveWebDistDir(): string | null {
  const candidates = [
    process.env.WEB_DIST_DIR,
    resolve(process.cwd(), '../web/dist'),
    resolve(process.cwd(), 'apps/web/dist'),
  ].filter(Boolean) as string[];

  return candidates.find((dir) => existsSync(join(dir, 'index.html'))) || null;
}
