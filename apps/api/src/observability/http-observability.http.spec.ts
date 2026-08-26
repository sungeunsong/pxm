import { BadRequestException, Controller, ForbiddenException, Get, Injectable, Logger, MiddlewareConsumer, Module, NotFoundException, UnauthorizedException, Version, type NestMiddleware, type NestModule } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { HttpObservabilityModule } from './http-observability.module';
import { enablePublicApiVersioning, PUBLIC_API_VERSIONS } from '../public-api-version';

@Controller('probe')
class ObservabilityProbeController {
  @Get('bad-request')
  @Version(PUBLIC_API_VERSIONS)
  badRequest() {
    throw new BadRequestException(['name is required', 'name must be a string']);
  }

  @Get('unauthorized')
  @Version(PUBLIC_API_VERSIONS)
  unauthorized() {
    throw new UnauthorizedException('API key is invalid');
  }

  @Get('forbidden')
  @Version(PUBLIC_API_VERSIONS)
  forbidden() {
    throw new ForbiddenException({
      statusCode: 403,
      error: 'Forbidden',
      code: 'MISSING_SCOPE',
      message: 'workflow:execute scope is required',
      required_scope: 'workflow:execute',
    });
  }

  @Get('missing')
  @Version(PUBLIC_API_VERSIONS)
  missing() {
    throw new NotFoundException('Template not found');
  }

  @Get('boom')
  @Version(PUBLIC_API_VERSIONS)
  boom() {
    throw new Error('database password=do-not-expose');
  }

  @Get('internal')
  internal() {
    throw new NotFoundException('Internal route missing');
  }
}

@Injectable()
class EarlyAuthFailureMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    if (req.header('x-reject-before-observability')) return next(new UnauthorizedException('Early auth failed'));
    next();
  }
}

@Module({ providers: [EarlyAuthFailureMiddleware] })
class EarlyAuthFailureModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(EarlyAuthFailureMiddleware).forRoutes('*');
  }
}

describe('HTTP observability', () => {
  let warnLog: jest.SpyInstance;

  beforeEach(() => {
    warnLog = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnLog.mockRestore();
  });

  async function createApp() {
    const moduleRef = await Test.createTestingModule({
      imports: [EarlyAuthFailureModule, HttpObservabilityModule],
      controllers: [ObservabilityProbeController],
    }).compile();
    const app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    enablePublicApiVersioning(app);
    await app.init();
    return app;
  }

  it.each([
    ['bad-request', 400, 'BAD_REQUEST'],
    ['unauthorized', 401, 'UNAUTHORIZED'],
    ['missing', 404, 'NOT_FOUND'],
  ])('uses the common public error schema for %s', async (route, status, code) => {
    const app = await createApp();
    try {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/probe/${route}`)
        .set('x-request-id', `client-${status}`)
        .expect(status);
      expect(response.headers['x-request-id']).toBe(`client-${status}`);
      expect(response.body).toEqual(expect.objectContaining({
        statusCode: status,
        code,
        request_id: `client-${status}`,
        path: `/api/v1/probe/${route}`,
        timestamp: expect.any(String),
      }));
    } finally {
      await app.close();
    }
  });

  it('preserves a specific error code and safe metadata', async () => {
    const app = await createApp();
    try {
      const response = await request(app.getHttpServer()).get('/api/v1/probe/forbidden').expect(403);
      expect(response.body).toEqual(expect.objectContaining({
        code: 'MISSING_SCOPE',
        required_scope: 'workflow:execute',
        request_id: response.headers['x-request-id'],
      }));
    } finally {
      await app.close();
    }
  });

  it('generates a safe request id when the supplied value is invalid', async () => {
    const app = await createApp();
    try {
      const response = await request(app.getHttpServer())
        .get('/api/v1/probe/missing')
        .set('x-request-id', 'contains spaces')
        .expect(404);
      expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(response.body.request_id).toBe(response.headers['x-request-id']);
    } finally {
      await app.close();
    }
  });

  it('does not expose an internal error message or stack trace', async () => {
    const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const app = await createApp();
    try {
      const response = await request(app.getHttpServer()).get('/api/v1/probe/boom').expect(500);
      expect(response.body).toEqual(expect.objectContaining({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error',
        request_id: response.headers['x-request-id'],
      }));
      expect(JSON.stringify(response.body)).not.toContain('password');
      expect(JSON.stringify(response.body)).not.toContain('stack');
    } finally {
      errorLog.mockRestore();
      await app.close();
    }
  });

  it('standardizes public API route-not-found errors', async () => {
    const app = await createApp();
    try {
      const response = await request(app.getHttpServer()).get('/api/v1/does-not-exist').expect(404);
      expect(response.headers['x-request-id']).toBeTruthy();
      expect(response.body).toEqual(expect.objectContaining({
        statusCode: 404,
        code: 'NOT_FOUND',
        request_id: response.headers['x-request-id'],
        path: '/api/v1/does-not-exist',
      }));
    } finally {
      await app.close();
    }
  });

  it('keeps the legacy error body for internal console APIs', async () => {
    const app = await createApp();
    try {
      const response = await request(app.getHttpServer()).get('/api/probe/internal').expect(404);
      expect(response.headers['x-request-id']).toBeTruthy();
      expect(response.body).toEqual({
        statusCode: 404,
        error: 'Not Found',
        message: 'Internal route missing',
      });
    } finally {
      await app.close();
    }
  });

  it('writes the response request id into the request log', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const app = await createApp();
    try {
      await request(app.getHttpServer())
        .get('/api/v1/probe/missing')
        .set('x-request-id', 'searchable-request-1')
        .expect(404);
      expect(log.mock.calls.some(([message]) => String(message).includes('searchable-request-1'))).toBe(true);
    } finally {
      log.mockRestore();
      await app.close();
    }
  });

  it('standardizes authentication errors raised before correlation middleware', async () => {
    const app = await createApp();
    try {
      const response = await request(app.getHttpServer())
        .get('/api/v1/probe/missing')
        .set('x-request-id', 'early-auth-request')
        .set('x-reject-before-observability', 'true')
        .expect(401);
      expect(response.headers['x-request-id']).toBe('early-auth-request');
      expect(response.body).toEqual(expect.objectContaining({
        code: 'UNAUTHORIZED',
        request_id: 'early-auth-request',
        path: '/api/v1/probe/missing',
      }));
      expect(warnLog.mock.calls.some(([message]) => String(message).includes('early-auth-request'))).toBe(true);
    } finally {
      await app.close();
    }
  });
});
