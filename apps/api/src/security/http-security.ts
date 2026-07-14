import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

const DEVELOPMENT_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
];

export function corsOptions(env: NodeJS.ProcessEnv = process.env): CorsOptions {
  const allowedOrigins = parseCsv(env.PXM_CORS_ORIGINS);
  const effectiveOrigins = allowedOrigins.length > 0
    ? allowedOrigins
    : env.NODE_ENV === 'production'
      ? []
      : DEVELOPMENT_ORIGINS;

  return {
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Request-ID', 'X-Business-Actor'],
    exposedHeaders: ['X-Request-ID'],
    maxAge: 600,
    origin(origin, callback) {
      // Server-to-server and same-origin requests do not include Origin.
      if (!origin || effectiveOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      // Return the response without CORS headers; browsers then block access.
      // Avoid turning an untrusted Origin header into noisy application 500s.
      callback(null, false);
    },
  };
}

export function trustProxySetting(env: NodeJS.ProcessEnv = process.env): false | number | string[] {
  const raw = env.PXM_TRUST_PROXY?.trim();
  if (!raw || raw === 'false' || raw === '0') return false;
  if (/^[1-9]\d*$/.test(raw)) return Number(raw);
  return parseCsv(raw);
}

function parseCsv(value?: string): string[] {
  return [...new Set((value || '').split(',').map((item) => item.trim()).filter(Boolean))];
}
