import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Global prefix 설정 (/api/...)
  app.setGlobalPrefix('api');

  // CORS 활성화 (개발 환경)
  app.enableCors({
    origin: ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175'],
    credentials: true,
  });

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
