import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HttpRequest');

  use(req: Request, res: Response, next: NextFunction) {
    const startedAt = Date.now();
    const requestId = correlationIdFromRequest(req);
    res.setHeader(REQUEST_ID_HEADER, requestId);

    res.once('finish', () => {
      this.logger.log(JSON.stringify({
        request_id: requestId,
        method: req.method,
        path: req.originalUrl || req.url,
        status: res.statusCode,
        duration_ms: Date.now() - startedAt,
      }));
    });
    next();
  }
}

export function correlationIdFromRequest(req: Request): string {
  const existing = (req as any).correlationId;
  if (typeof existing === 'string' && REQUEST_ID_PATTERN.test(existing)) return existing;
  const supplied = req.header(REQUEST_ID_HEADER)?.trim() || '';
  const requestId = REQUEST_ID_PATTERN.test(supplied) ? supplied : randomUUID();
  (req as any).correlationId = requestId;
  return requestId;
}
