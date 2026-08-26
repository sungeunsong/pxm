import { ArgumentsHost, Catch, HttpException, HttpStatus, Logger, type ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { STATUS_CODES } from 'http';
import { correlationIdFromRequest } from './correlation-id.middleware';

type ExceptionPayload = Record<string, any>;

@Catch()
export class PublicApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpException');

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const status = exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;
    const payload = exceptionPayload(exception, status);
    const requestId = correlationIdFromRequest(req);
    res.setHeader('x-request-id', requestId);

    const logContext = JSON.stringify({
      request_id: requestId,
      method: req.method,
      path: req.originalUrl || req.url,
      status,
      code: String(payload.code || defaultErrorCode(status)),
    });
    if (status >= 500) {
      this.logger.error(
        logContext,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else if (isPublicApiRequest(req)) {
      this.logger.warn(logContext);
    }

    if (!isPublicApiRequest(req)) {
      res.status(status).json(payload);
      return;
    }

    const messages = Array.isArray(payload.message)
      ? payload.message.map(String)
      : [String(payload.message || STATUS_CODES[status] || 'Request failed')];
    const extras = Object.fromEntries(
      Object.entries(payload).filter(([key]) => !['statusCode', 'status', 'error', 'code', 'message'].includes(key)),
    );
    res.status(status).json({
      statusCode: status,
      error: String(payload.error || STATUS_CODES[status] || 'Error'),
      code: String(payload.code || defaultErrorCode(status)),
      message: messages.join('; '),
      ...(messages.length > 1 ? { details: messages } : {}),
      ...extras,
      request_id: requestId,
      timestamp: new Date().toISOString(),
      path: req.path,
    });
  }
}

function isPublicApiRequest(req: Request): boolean {
  const path = (req.originalUrl || req.url || '').replace(/\?.*$/, '');
  return path === '/api/v1' || path.startsWith('/api/v1/');
}

function exceptionPayload(exception: unknown, status: number): ExceptionPayload {
  if (!(exception instanceof HttpException)) {
    return { statusCode: status, error: 'Internal Server Error', message: 'Internal server error' };
  }
  const response = exception.getResponse();
  if (typeof response === 'string') {
    return { statusCode: status, error: STATUS_CODES[status] || 'Error', message: response };
  }
  return response && typeof response === 'object'
    ? { statusCode: status, ...(response as ExceptionPayload) }
    : { statusCode: status, error: STATUS_CODES[status] || 'Error', message: exception.message };
}

function defaultErrorCode(status: number): string {
  return ({
    400: 'BAD_REQUEST',
    401: 'UNAUTHORIZED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    409: 'CONFLICT',
    429: 'RATE_LIMIT_EXCEEDED',
    500: 'INTERNAL_SERVER_ERROR',
  } as Record<number, string>)[status] || `HTTP_${status}`;
}
