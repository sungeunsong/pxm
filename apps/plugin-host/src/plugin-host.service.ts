import { Injectable } from '@nestjs/common';
import {
  HostedPluginExecutor,
  PluginInvokeRequest,
  PluginInvokeResponse,
} from './plugin-host.types';

@Injectable()
export class PluginHostService {
  private readonly executors = new Map<string, HostedPluginExecutor>();

  constructor() {
    this.register('connector.slack.send_message', this.slackSendMessage);
    this.register('connector.acra.grant_permission', this.acraGrantPermission);
    this.register('connector.nit.create_issue', this.nitCreateIssue);
    this.register('connector.jira.create_issue', this.jiraCreateIssue);
    this.register('connector.hr.lookup_user', this.hrLookupUser);
    this.register('connector.ad.grant_group', this.adGrantGroup);
  }

  health() {
    return {
      status: 'ok',
      executors: [...this.executors.keys()].sort(),
    };
  }

  async invoke(request: PluginInvokeRequest): Promise<PluginInvokeResponse> {
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

    try {
      return await executor(request);
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

  private register(pluginId: string, executor: HostedPluginExecutor) {
    this.executors.set(pluginId, executor);
  }

  private readonly slackSendMessage: HostedPluginExecutor = (request) => ({
    success: true,
    output: {
      connector: 'slack',
      message_ts: `mock-${Date.now()}`,
      channel: request.config.channel ?? null,
      message: request.config.message ?? null,
      instance_id: request.instance.id,
      token_id: request.node.token_id,
      attempt: request.attempt,
    },
  });

  private readonly acraGrantPermission: HostedPluginExecutor = (request) => ({
    success: true,
    output: {
      connector: 'acra',
      decision: 'approved',
      targetSystem: request.config.targetSystem ?? null,
      permissionCode: request.config.permissionCode ?? null,
      instance_id: request.instance.id,
      token_id: request.node.token_id,
      has_api_token: Boolean(request.secrets?.api_token),
    },
  });

  private readonly nitCreateIssue: HostedPluginExecutor = (request) => ({
    success: true,
    output: {
      connector: 'nit',
      ticket: `NIT-${request.node.token_id?.slice(0, 8) ?? Date.now()}`,
      projectKey: request.config.projectKey ?? null,
      priority: request.config.priority ?? 'MEDIUM',
      instance_id: request.instance.id,
      token_id: request.node.token_id,
    },
  });

  private readonly jiraCreateIssue: HostedPluginExecutor = (request) => ({
    success: true,
    output: {
      connector: 'jira',
      issueKey: `${request.config.projectKey ?? 'PXM'}-${Math.floor(Math.random() * 9000) + 1000}`,
      issueType: request.config.issueType ?? 'Task',
      instance_id: request.instance.id,
      token_id: request.node.token_id,
      has_api_token: Boolean(request.secrets?.api_token),
    },
  });

  private readonly hrLookupUser: HostedPluginExecutor = (request) => ({
    success: true,
    output: {
      connector: 'hr',
      user: request.config.userTemplate ?? null,
      department: 'Platform',
      manager: request.config.includeManager === false ? null : 'manager@example.com',
      instance_id: request.instance.id,
      token_id: request.node.token_id,
      has_api_token: Boolean(request.secrets?.api_token),
    },
  });

  private readonly adGrantGroup: HostedPluginExecutor = (request) => ({
    success: true,
    output: {
      connector: 'ad',
      group: request.config.groupDn ?? null,
      user: request.config.userTemplate ?? null,
      instance_id: request.instance.id,
      token_id: request.node.token_id,
      has_bind_password: Boolean(request.secrets?.bind_password),
    },
  });
}
