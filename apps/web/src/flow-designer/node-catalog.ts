import type { PluginManifest } from '../api/plugins';
import type { CustomNodeData } from './form-types';

export interface NodeCatalogItem {
  id: string;
  name: string;
  source: 'basic' | 'plugin';
  sourceLabel: string;
  typeLabel: string;
  data: CustomNodeData;
  available: boolean;
  unavailableReason?: string;
  searchText: string;
}

export const BASIC_NODE_OPTIONS: Array<{ label: string; typeLabel: string; data: CustomNodeData }> = [
  { label: 'Start', typeLabel: '시작', data: { nodeType: 'start', label: 'Start' } },
  { label: 'Timer', typeLabel: '대기', data: { nodeType: 'timer', label: 'Timer' } },
  {
    label: 'JS Node',
    typeLabel: 'JavaScript',
    data: {
      nodeType: 'script', label: 'JS Node', scriptType: 'javascript',
      code: "return { message: 'hello from js node', formData: input.formData };",
      outputPath: 'scriptResults.jsNode', scriptTimeoutMs: 1000,
    },
  },
  {
    label: 'Command',
    typeLabel: '명령어',
    data: {
      nodeType: 'command', label: 'Command',
      commandId: 'builtin.echo', commandArgumentsJson: '{\n  "message": "hello from command node"\n}',
      outputPath: 'commandResults.echo', commandTimeoutMs: 1000,
    },
  },
  { label: 'Gateway', typeLabel: '조건 분기', data: { nodeType: 'gateway', label: 'Gateway' } },
  { label: 'Approval', typeLabel: '결재', data: { nodeType: 'approval', label: 'Approval' } },
  {
    label: 'Workflow Call',
    typeLabel: '워크플로우 호출',
    data: {
      nodeType: 'workflow_call', label: 'Workflow Call',
      workflowCallMode: 'async', workflowInputMode: 'inherit_form_data', outputPath: 'workflowCalls.child',
    },
  },
  { label: 'End', typeLabel: '종료', data: { nodeType: 'end', label: 'End' } },
];

export function buildNodeCatalog(plugins: PluginManifest[], forEdgeInsertion = false): NodeCatalogItem[] {
  const basicItems = BASIC_NODE_OPTIONS.map((option) => {
    const insertable = !forEdgeInsertion || canInsertBetweenEdges(option.data.nodeType);
    return makeCatalogItem({
      id: `basic:${option.data.nodeType}`,
      name: option.label,
      source: 'basic',
      sourceLabel: '기본 노드',
      typeLabel: option.typeLabel,
      data: option.data,
      available: insertable,
      unavailableReason: insertable ? undefined : '연결 사이에는 단일 입·출력 노드만 추가할 수 있습니다.',
    });
  });

  const pluginItems = plugins.map((plugin) => {
    const available = plugin.enabled !== false;
    const defaults: Record<string, unknown> = {};
    Object.entries(plugin.config_schema.properties || {}).forEach(([key, property]) => {
      if (property.default !== undefined) defaults[key] = property.default;
    });
    return makeCatalogItem({
      id: `plugin:${plugin.plugin_id}:${plugin.version}`,
      name: plugin.display_name,
      source: 'plugin',
      sourceLabel: plugin.category || 'Plugin',
      typeLabel: plugin.executor_type,
      data: {
        ...defaults,
        nodeType: 'service',
        label: plugin.display_name,
        description: plugin.description || plugin.category,
        plugin_id: plugin.plugin_id,
        plugin_version: plugin.version,
        icon: plugin.icon,
        category: plugin.category,
        timeout: plugin.timeout_ms,
        retryCount: plugin.retry_policy?.max_attempts,
        enableRetry: !!plugin.retry_policy?.max_attempts,
      } as CustomNodeData,
      available,
      unavailableReason: available ? undefined : '플러그인 제어에서 비활성화된 플러그인입니다.',
      extraSearchText: [plugin.plugin_id, plugin.description, ...(plugin.tags || [])].filter(Boolean).join(' '),
    });
  });

  return basicItems.concat(pluginItems);
}

function canInsertBetweenEdges(nodeType: CustomNodeData['nodeType']) {
  return !['start', 'gateway', 'approval', 'end'].includes(nodeType);
}

function makeCatalogItem(input: Omit<NodeCatalogItem, 'searchText'> & { extraSearchText?: string }): NodeCatalogItem {
  const { extraSearchText = '', ...item } = input;
  return {
    ...item,
    searchText: [item.name, item.typeLabel, item.sourceLabel, extraSearchText].join(' ').toLocaleLowerCase(),
  };
}
