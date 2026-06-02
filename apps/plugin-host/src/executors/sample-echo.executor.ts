import type {
  HostedPluginExecutor,
  PluginInvokeRequest,
  PluginInvokeResponse,
} from '../plugin-host.types';

export const SAMPLE_ECHO_PLUGIN_ID = 'connector.sample_echo';

export const sampleEchoExecutor: HostedPluginExecutor = (
  request: PluginInvokeRequest,
): PluginInvokeResponse => ({
  success: true,
  output: {
    connector: 'sample_echo',
    message: request.config.message ?? null,
    instance_id: request.instance.id,
    node_id: request.node.id,
    token_id: request.node.token_id ?? null,
    attempt: request.attempt,
    context_keys: Object.keys(request.context ?? {}).sort(),
  },
});
