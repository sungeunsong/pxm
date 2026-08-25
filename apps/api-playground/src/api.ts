export type ApiConfig = {
  baseUrl: string;
  apiKey: string;
  businessActor?: Record<string, unknown> | null;
};

export type RequestLog = {
  id: string;
  method: string;
  path: string;
  status: number | null;
  durationMs: number;
  requestBody?: unknown;
  responseBody?: unknown;
  error?: string;
  at: string;
};

export class PxmApi {
  private readonly config: ApiConfig;
  private readonly onLog: (entry: RequestLog) => void;

  constructor(config: ApiConfig, onLog: (entry: RequestLog) => void) {
    this.config = config;
    this.onLog = onLog;
  }

  get<T>(path: string) { return this.request<T>('GET', path); }
  post<T>(path: string, body?: unknown, headers?: Record<string, string>) {
    return this.request<T>('POST', path, body, headers);
  }

  private async request<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    const started = performance.now();
    const id = crypto.randomUUID();
    let status: number | null = null;
    try {
      const response = await fetch(`${normalizeBase(this.config.baseUrl)}${path}`, {
        method,
        // This client represents an external API consumer. Never mix a PXM
        // Console session cookie into Bearer API-key authentication.
        credentials: 'omit',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
          'X-Request-ID': id,
          ...(this.config.businessActor
            ? { 'X-Business-Actor': JSON.stringify(this.config.businessActor) }
            : {}),
          ...extraHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      status = response.status;
      const responseBody: unknown = await response.json().catch(() => null);
      this.onLog({ id, method, path, status, durationMs: Math.round(performance.now() - started), requestBody: body, responseBody, at: new Date().toISOString() });
      if (!response.ok) throw new ApiError(response.status, messageOf(responseBody), responseBody);
      return responseBody as T;
    } catch (cause) {
      if (!(cause instanceof ApiError)) {
        this.onLog({ id, method, path, status, durationMs: Math.round(performance.now() - started), requestBody: body, error: cause instanceof Error ? cause.message : String(cause), at: new Date().toISOString() });
      }
      throw cause;
    }
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function normalizeBase(value: string) {
  const trimmed = value.trim() || '/api/v1';
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

function messageOf(body: unknown): string {
  if (body && typeof body === 'object' && 'message' in body) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.join(', ');
  }
  return 'API request failed';
}
