import { Injectable } from '@nestjs/common';
import {
  HostedPluginExecutor,
  PluginInvokeRequest,
  PluginInvokeResponse,
} from './plugin-host.types';

@Injectable()
export class PluginHostService {
  private readonly executors = new Map<string, HostedPluginExecutor>();
  private readonly policies = new Map<string, HostedPluginPolicy>();
  private readonly allowedPluginIds = new Set(
    (process.env.PXM_PLUGIN_HOST_ALLOWLIST || '*')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

  constructor() {}

  health() {
    return {
      status: 'ok',
      executors: [...this.executors.keys()].sort(),
      policies: Object.fromEntries([...this.policies.entries()].sort()),
    };
  }

  async invoke(request: PluginInvokeRequest): Promise<PluginInvokeResponse> {
    if (!this.isAllowed(request.plugin_id)) {
      return {
        success: false,
        retryable: false,
        error: {
          code: 'PLUGIN_NOT_ALLOWED',
          message: `Hosted plugin ${request.plugin_id} is not allowed by this plugin host`,
        },
      };
    }

    const executor = this.executors.get(request.plugin_id);
    if (!executor) {
      return {
        success: false,
        retryable: false,
        error: {
          code: 'PLUGIN_NOT_REGISTERED',
          message: `No hosted executor registered for ${request.plugin_id}`,
        },
      };
    }

    const policy = this.resolvePolicy(request);
    if (policy.isolation_mode !== 'shared_process') {
      return {
        success: false,
        retryable: false,
        error: {
          code: 'PLUGIN_ISOLATION_UNSUPPORTED',
          message: `Hosted plugin ${request.plugin_id} must use shared_process isolation`,
        },
      };
    }

    const payloadBytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
    if (payloadBytes > policy.max_payload_bytes) {
      return {
        success: false,
        retryable: false,
        error: {
          code: 'PLUGIN_PAYLOAD_TOO_LARGE',
          message: `Plugin payload is ${payloadBytes} bytes; limit is ${policy.max_payload_bytes}`,
        },
      };
    }

    try {
      return await withTimeout(executor(request), policy.timeout_ms);
    } catch (error) {
      return {
        success: false,
        retryable: true,
        error: {
          code: 'PLUGIN_EXECUTION_ERROR',
          message: error instanceof Error ? error.message : 'Unknown plugin execution error',
        },
      };
    }
  }

  private register(
    pluginId: string,
    executor: HostedPluginExecutor,
    policy: HostedPluginPolicy = {},
  ) {
    this.executors.set(pluginId, executor);
    this.policies.set(pluginId, {
      isolation_mode: 'shared_process',
      timeout_ms: 5000,
      max_payload_bytes: 262144,
      ...policy,
    });
  }

  private isAllowed(pluginId: string): boolean {
    return this.allowedPluginIds.has('*') || this.allowedPluginIds.has(pluginId);
  }

  private resolvePolicy(request: PluginInvokeRequest): Required<HostedPluginPolicy> {
    const registeredPolicy = this.policies.get(request.plugin_id) ?? {};
    return {
      isolation_mode: request.isolation?.mode ?? registeredPolicy.isolation_mode ?? 'shared_process',
      timeout_ms:
        request.resource_limits?.timeout_ms ??
        registeredPolicy.timeout_ms ??
        5000,
      max_payload_bytes:
        request.resource_limits?.max_payload_bytes ??
        registeredPolicy.max_payload_bytes ??
        262144,
    };
  }
}

export interface HostedPluginPolicy {
  isolation_mode?: 'shared_process' | 'external_process';
  timeout_ms?: number;
  max_payload_bytes?: number;
}

function withTimeout<T>(
  result: Promise<T> | T,
  timeoutMs: number,
): Promise<T> {
  let timeout: NodeJS.Timeout;
  return Promise.race([
    Promise.resolve(result),
    new Promise<T>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`Plugin execution timed out after ${timeoutMs}ms`));
      }, Math.max(1, timeoutMs));
    }),
  ]).finally(() => clearTimeout(timeout));
}
