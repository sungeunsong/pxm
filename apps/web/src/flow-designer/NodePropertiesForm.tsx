import React from 'react';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import type { Node } from 'reactflow';
import type { Edge } from 'reactflow';
import { Button, Input, Select, Checkbox } from '../components';
import type { CustomNodeData, FormSchema } from './form-types';
import type { PluginManifest, PluginJsonSchemaProperty, PluginTestResponse } from '../api/plugins';
import { credentialsApi, type CredentialProfile } from '../api/credentials';
import { commandsApi, type CommandRegistryItem } from '../api/commands';
import { templatesApi, type TestDbWatchConnectionResponse } from '../api/templates';
import { authzApi, type PxmGroup, type PxmUser } from '../api/authz';
import { FormSchemaEditor } from './FormSchemaEditor';
import { PluginIcon } from './plugin-icons';
import { sanitizeTerminalText } from './terminal-output';
import './NodePropertiesForm.css';

export interface NodePropertiesFormProps {
  node: Node<CustomNodeData>;
  onUpdate: (nodeId: string, data: Partial<CustomNodeData>) => void;
  plugins?: PluginManifest[];
  gatewayEdges?: Edge[];
  pathSuggestions?: NodePathSuggestion[];
  onGatewayEdgeUpdate?: (edgeId: string, data: Partial<Edge>) => void;
  onTestRun?: () => void;
  testRunning?: boolean;
  testResult?: PluginTestResponse | null;
  testError?: string | null;
  credentialGroupId?: string;
  workflowGroups?: PxmGroup[];
  workflowGroupsLoading?: boolean;
  workflowGroupsError?: string | null;
  onWorkflowGroupChange?: (groupId: string) => void;
}

export interface NodePathSuggestion {
  label: string;
  path: string;
  sourceNodeId: string;
  sourceNodeLabel: string;
}

interface WorkflowOption {
  id: string;
  name: string;
}

const javascriptEditorExtensions = [
  javascript({ jsx: true }),
  EditorView.lineWrapping,
  EditorView.theme({
    '&': {
      color: 'var(--text-primary)',
      backgroundColor: 'var(--bg-tertiary)',
      fontSize: '12px',
    },
    '.cm-content': {
      minHeight: '260px',
      padding: '10px 0',
      fontFamily: 'var(--font-mono)',
      lineHeight: '1.6',
    },
    '.cm-gutters': {
      color: 'var(--text-tertiary)',
      backgroundColor: 'color-mix(in srgb, var(--bg-tertiary) 88%, var(--bg-secondary))',
      borderRight: '1px solid var(--border-subtle)',
    },
    '.cm-line': {
      padding: '0 12px',
    },
    '.cm-activeLine': {
      backgroundColor: 'color-mix(in srgb, var(--border-focus) 8%, transparent)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'color-mix(in srgb, var(--border-focus) 10%, transparent)',
      color: 'var(--text-secondary)',
    },
    '&.cm-focused': {
      outline: 'none',
    },
    '&.cm-focused .cm-cursor': {
      borderLeftColor: 'var(--text-primary)',
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: 'color-mix(in srgb, var(--border-focus) 24%, transparent)',
    },
  }),
  syntaxHighlighting(
    HighlightStyle.define([
      { tag: tags.keyword, color: '#2563eb', fontWeight: '600' },
      { tag: [tags.string, tags.special(tags.string)], color: '#15803d' },
      { tag: [tags.number, tags.bool, tags.null], color: '#9333ea' },
      { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--text-tertiary)', fontStyle: 'italic' },
      { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: '#b45309' },
      { tag: [tags.variableName, tags.propertyName], color: 'var(--text-primary)' },
      { tag: tags.operator, color: '#db2777' },
      { tag: tags.punctuation, color: 'var(--text-secondary)' },
    ]),
    { fallback: true },
  ),
];

export const NodePropertiesForm: React.FC<NodePropertiesFormProps> = ({
  node,
  onUpdate,
  plugins = [],
  gatewayEdges = [],
  pathSuggestions = [],
  onGatewayEdgeUpdate,
  onTestRun,
  testRunning = false,
  testResult,
  testError,
  credentialGroupId,
  workflowGroups = [],
  workflowGroupsLoading = false,
  workflowGroupsError = null,
  onWorkflowGroupChange,
}) => {
  const scriptEditorRef = React.useRef<ReactCodeMirrorRef | null>(null);
  const [credentials, setCredentials] = React.useState<CredentialProfile[]>([]);
  const [credentialsLoading, setCredentialsLoading] = React.useState(false);
  const [credentialsError, setCredentialsError] = React.useState<string | null>(null);
  const [workflowOptions, setWorkflowOptions] = React.useState<WorkflowOption[]>([]);
  const [workflowOptionsLoading, setWorkflowOptionsLoading] = React.useState(false);
  const [workflowOptionsError, setWorkflowOptionsError] = React.useState<string | null>(null);
  const [approvalUsers, setApprovalUsers] = React.useState<PxmUser[]>([]);
  const [approvalUsersLoading, setApprovalUsersLoading] = React.useState(false);
  const [approvalUsersError, setApprovalUsersError] = React.useState<string | null>(null);
  const [commandOptions, setCommandOptions] = React.useState<CommandRegistryItem[]>([]);
  const [commandOptionsLoading, setCommandOptionsLoading] = React.useState(false);
  const [commandOptionsError, setCommandOptionsError] = React.useState<string | null>(null);
  const [dbWatchFilterJson, setDbWatchFilterJson] = React.useState('{}');
  const [dbWatchFilterError, setDbWatchFilterError] = React.useState<string | null>(null);
  const [dbWatchTestRunning, setDbWatchTestRunning] = React.useState(false);
  const [dbWatchTestResult, setDbWatchTestResult] = React.useState<TestDbWatchConnectionResponse | null>(null);
  const [dbWatchTestError, setDbWatchTestError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (node.data.nodeType !== 'approval' || !credentialGroupId) {
      setApprovalUsers([]);
      setApprovalUsersError(
        node.data.nodeType === 'approval' && !credentialGroupId
          ? 'Workflow 관리 그룹을 먼저 선택하세요.'
          : null,
      );
      return;
    }

    let cancelled = false;
    setApprovalUsersLoading(true);
    authzApi.listUsers(credentialGroupId)
      .then((items) => {
        if (!cancelled) {
          setApprovalUsers(items.filter((item) => item.status === 'active'));
          setApprovalUsersError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setApprovalUsersError(error instanceof Error ? error.message : '사용자 목록을 불러오지 못했습니다.');
        }
      })
      .finally(() => {
        if (!cancelled) setApprovalUsersLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [credentialGroupId, node.data.nodeType]);

  React.useEffect(() => {
    const data = node.data as any;
    setDbWatchFilterJson(JSON.stringify(data.dbWatchFilter || {}, null, 2));
    setDbWatchFilterError(null);
    setDbWatchTestResult(null);
    setDbWatchTestError(null);
  }, [node.id]);

  React.useEffect(() => {
    let cancelled = false;
    if (!credentialGroupId) {
      setCredentials([]);
      setCredentialsError('Workflow 관리 그룹을 먼저 선택하세요.');
      setCredentialsLoading(false);
      return () => { cancelled = true; };
    }
    setCredentialsLoading(true);
    credentialsApi
      .list(true, credentialGroupId)
      .then((items) => {
        if (!cancelled) {
          setCredentials(items);
          setCredentialsError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setCredentialsError(error instanceof Error ? error.message : 'Credential load failed');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setCredentialsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [credentialGroupId]);

  React.useEffect(() => {
    if (node.data.nodeType !== 'workflow_call') {
      return;
    }

    let cancelled = false;
    setWorkflowOptionsLoading(true);
    fetch('/api/templates?activeOnly=false')
      .then(async (response) => {
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.message || `Workflow list API failed: ${response.status}`);
        }
        return Array.isArray(payload) ? payload : [];
      })
      .then((items) => {
        if (!cancelled) {
          setWorkflowOptions(
            items.map((item: any) => ({
              id: item.id,
              name: item.name || item.id,
            })),
          );
          setWorkflowOptionsError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setWorkflowOptionsError(error instanceof Error ? error.message : 'Workflow 목록을 불러오지 못했습니다.');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setWorkflowOptionsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [node.data.nodeType]);

  React.useEffect(() => {
    if (node.data.nodeType !== 'command') {
      return;
    }

    let cancelled = false;
    setCommandOptionsLoading(true);
    commandsApi
      .list(true)
      .then((items) => {
        if (!cancelled) {
          setCommandOptions(items);
          setCommandOptionsError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setCommandOptionsError(error instanceof Error ? error.message : 'Command 목록을 불러오지 못했습니다.');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setCommandOptionsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [node.data.nodeType]);

  const handleLabelChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onUpdate(node.id, { label: e.target.value });
  };

  const handleDescriptionChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onUpdate(node.id, { description: e.target.value });
  };

  const handleCopyPath = (path: string) => {
    void navigator.clipboard?.writeText(path).catch(() => undefined);
  };

  const handleInsertScriptPath = (path: string) => {
    const data = node.data as any;
    const code = data.code || '';
    const reference = `context.${path}`;
    const editorView = scriptEditorRef.current?.view;
    const start = editorView?.state.selection.main.from ?? code.length;
    const end = editorView?.state.selection.main.to ?? code.length;
    const nextCode = `${code.slice(0, start)}${reference}${code.slice(end)}`;

    onUpdate(node.id, {
      ...data,
      scriptType: 'javascript',
      code: nextCode,
    });

    requestAnimationFrame(() => {
      const cursor = start + reference.length;
      editorView?.focus();
      editorView?.dispatch({
        selection: { anchor: cursor },
        scrollIntoView: true,
      });
    });
  };

  const handleTestDbWatchConnection = async () => {
    const data = node.data as any;
    setDbWatchTestRunning(true);
    setDbWatchTestResult(null);
    setDbWatchTestError(null);

    try {
      const result = await templatesApi.testDbWatchConnection({
        database: data.dbWatchDatabase || null,
        collection: data.dbWatchCollection || null,
        credential_id: data.dbWatchCredentialId || null,
        mode: data.dbWatchMode || 'polling',
        cursor_field: data.dbWatchCursorField || null,
        filter: isPlainObject(data.dbWatchFilter) ? data.dbWatchFilter : {},
      });
      setDbWatchTestResult(result);
    } catch (error) {
      setDbWatchTestError(error instanceof Error ? error.message : 'DB Watch 연결 테스트에 실패했습니다.');
    } finally {
      setDbWatchTestRunning(false);
    }
  };

  // Service 노드 속성
  const renderServiceProperties = () => {
    const data = node.data as any;
    const pluginId = data.plugin_id || 'builtin.http_request';
    const selectedPlugin = findPluginManifest(plugins, pluginId);
    const credentialPolicy = getCredentialPolicy(selectedPlugin);
    const credentialRequired = isCredentialRequired(selectedPlugin);
    const compatibleCredentials = credentials.filter((credential) =>
      isCredentialCompatible(credential, credentialPolicy),
    );
    const selectedCredential = credentials.find((credential) => credential.id === data.credential_id);
    const selectedCredentialCompatible = selectedCredential
      ? isCredentialCompatible(selectedCredential, credentialPolicy)
      : false;

    if (selectedCredential && !selectedCredentialCompatible) {
      queueMicrotask(() => {
        onUpdate(node.id, {
          ...data,
          credential_id: undefined,
          credential_binding: undefined,
        });
      });
    }

    return (
      <>
        <div className="property-section node-test-section">
          <div className="node-test-header">
            <div>
              <h4 className="property-section-title">노드 테스트</h4>
              <div className="property-helper-text">
                현재 설정값으로 이 노드만 실행하고 결과를 확인합니다.
              </div>
            </div>
            <Button
              variant="primary"
              size="sm"
              onClick={onTestRun}
              disabled={!onTestRun || testRunning || (credentialRequired && !selectedCredentialCompatible)}
            >
              {testRunning ? '실행 중...' : '테스트 실행'}
            </Button>
          </div>
          {(testResult || testError) && (
            <div className={`node-test-result ${testResult?.ok ? 'success' : 'error'}`}>
              <div className="node-test-result-meta">
                {testResult
                  ? `${testResult.ok ? '성공' : '실패'} · ${testResult.duration_ms}ms`
                  : '실패'}
              </div>
              {pluginId === 'builtin.ssh' ? (
                <SshTestTerminal
                  command={String(data.command || '')}
                  result={testResult}
                  error={testError}
                />
              ) : (
                <JsonTreeView
                  value={getTestResultValue(testResult, testError)}
                  onPathClick={handleCopyPath}
                />
              )}
            </div>
          )}
        </div>

        <div className="property-section">
          <h4 className="property-section-title">플러그인</h4>
          {selectedPlugin && (
            <div className="selected-plugin-summary">
              <div className="selected-plugin-icon">
                <PluginIcon icon={selectedPlugin.icon} size={18} />
              </div>
              <div>
                <div className="selected-plugin-name">{selectedPlugin.display_name}</div>
                <div className="selected-plugin-meta">{selectedPlugin.category}</div>
              </div>
            </div>
          )}
          <Select
            label="호환 선택"
            value={pluginId}
            onChange={(e) => {
              const nextPlugin = findPluginManifest(plugins, e.target.value);
              const nextPolicy = getCredentialPolicy(nextPlugin);
              const keepCredential =
                selectedCredential && isCredentialCompatible(selectedCredential, nextPolicy);
              onUpdate(node.id, {
                ...data,
                ...getPluginConfigDefaults(nextPlugin),
                label: nextPlugin?.display_name || data.label,
                description: nextPlugin?.description || data.description,
                icon: nextPlugin?.icon || data.icon,
                category: nextPlugin?.category || data.category,
                plugin_id: e.target.value,
                plugin_version: nextPlugin?.version || data.plugin_version,
                credential_id: keepCredential ? data.credential_id : undefined,
                credential_binding: keepCredential
                  ? buildCredentialBinding(selectedCredential, nextPolicy)
                  : undefined,
                timeout: nextPlugin?.timeout_ms || data.timeout,
                retryCount: nextPlugin?.retry_policy?.max_attempts || data.retryCount,
              });
            }}
            options={buildPluginOptions(plugins)}
            fullWidth
          />
          <Select
            label="Credential"
            value={data.credential_id || ''}
            onChange={(e) => {
              const credential = credentials.find((item) => item.id === e.target.value);
              onUpdate(node.id, {
                ...data,
                credential_id: credential?.id,
                credential_binding: credential
                  ? buildCredentialBinding(credential, credentialPolicy)
                  : undefined,
              });
            }}
            options={buildCredentialOptions(compatibleCredentials, credentialPolicy, credentialRequired)}
            helperText={
              credentialsError ||
              (credentialsLoading
                ? 'Credential 목록을 불러오는 중입니다.'
                : credentialPolicy.helperText)
            }
            required={credentialRequired}
            fullWidth
          />
          {selectedCredential && selectedCredentialCompatible && (
            <CredentialBindingSummary
              credential={selectedCredential}
              binding={buildCredentialBinding(selectedCredential, credentialPolicy)}
              policy={credentialPolicy}
            />
          )}
        </div>

        {selectedPlugin ? (
          <div className="property-section">
            <h4 className="property-section-title">플러그인 설정</h4>
            {renderPluginConfigFields(
              selectedPlugin,
              data,
              (nextData) => onUpdate(node.id, nextData),
              selectedCredentialCompatible ? credentialPolicy : undefined,
            )}
          </div>
        ) : (
          <div className="property-section">
            <h4 className="property-section-title">레거시 설정</h4>
            <Input
              label="Message"
              value={data.message || ''}
              onChange={(e) => onUpdate(node.id, { ...data, message: e.target.value })}
              fullWidth
            />
          </div>
        )}

        <div className="property-section">
          <h4 className="property-section-title">고급 설정</h4>
          <Input
            label="Output Path"
            placeholder="outputs.serviceNode"
            value={data.outputPath || data.output_path || ''}
            onChange={(e) => onUpdate(node.id, { ...data, outputPath: e.target.value })}
            helperText="플러그인 실행 결과가 저장될 context path입니다. HTTP 노드는 status_code, ok, headers, body를 저장합니다. 예: httpResults.userLookup"
            fullWidth
          />
          {!selectedPlugin?.config_schema.properties?.timeout_ms && (
            <Input
              label="Timeout (ms)"
              type="number"
              placeholder="5000"
              value={data.timeout || ''}
              onChange={(e) => onUpdate(node.id, {
                ...data,
                timeout: e.target.value === '' ? '' : Number.parseInt(e.target.value, 10),
              })}
              fullWidth
            />
          )}
          <Input
            label="Retry Count"
            type="number"
            placeholder="3"
            value={data.retryCount || ''}
            onChange={(e) => onUpdate(node.id, {
              ...data,
              retryCount: e.target.value === '' ? '' : Number.parseInt(e.target.value, 10),
            })}
            fullWidth
          />
          <Checkbox
            label="Enable Retry"
            checked={data.enableRetry || false}
            onChange={(e) => onUpdate(node.id, { ...data, enableRetry: e.target.checked })}
          />
        </div>
      </>
    );
  };

  // JS Script 노드 속성
  const renderScriptProperties = () => {
    const data = node.data as any;
    return (
      <div className="property-section">
        <h4 className="property-section-title">JS 실행 설정</h4>
        <div className="property-group">
          <label className="property-label">JavaScript Code</label>
          <CodeMirror
            ref={scriptEditorRef}
            className="property-code-editor"
            value={data.code || ''}
            extensions={javascriptEditorExtensions}
            basicSetup={{
              autocompletion: true,
              bracketMatching: true,
              closeBrackets: true,
              foldGutter: true,
              highlightActiveLine: true,
              highlightActiveLineGutter: true,
              lineNumbers: true,
            }}
            onChange={(value) =>
              onUpdate(node.id, {
                ...data,
                scriptType: 'javascript',
                code: value,
              })
            }
            placeholder="return { total: input.formData.price * input.formData.quantity };"
          />
          <div className="property-helper-text">
            `input`과 `context`를 읽고, `return` 값이 output path에 저장됩니다.
          </div>
        </div>
        <PathSuggestionList
          suggestions={pathSuggestions}
          emptyText="연결된 이전 노드의 output path가 없습니다."
          actionLabel="삽입"
          onSelect={handleInsertScriptPath}
        />
        <Input
          label="Output Path"
          placeholder="scriptResults.jsNode"
          value={data.outputPath || ''}
          onChange={(e) => onUpdate(node.id, { ...data, outputPath: e.target.value })}
          helperText="예: scriptResults.calculateAmount. 저장 위치는 data.outputs 하위입니다."
          fullWidth
        />
        <Input
          label="Timeout (ms)"
          type="number"
          placeholder="1000"
          value={data.scriptTimeoutMs || ''}
          onChange={(e) =>
            onUpdate(node.id, {
              ...data,
              scriptTimeoutMs: e.target.value === '' ? '' : Number(e.target.value),
            })
          }
          helperText="Node.js vm 실행 제한 시간입니다."
          fullWidth
        />
      </div>
    );
  };

  const renderCommandProperties = () => {
    const data = node.data as any;
    const argumentsJson = data.commandArgumentsJson || '{\n  "message": "hello from command node"\n}';
    const jsonError = validateJsonText(argumentsJson);
    const selectedCommand = commandOptions.find((command) => command.command_id === data.commandId);
    const argumentDocs = selectedCommand
      ? buildCommandArgumentDocs(selectedCommand, argumentsJson, pathSuggestions)
      : [];
    const missingRequiredArgs = selectedCommand && !jsonError
      ? findMissingRequiredCommandArgs(selectedCommand, argumentsJson, pathSuggestions)
      : [];

    return (
      <div className="property-section">
        <h4 className="property-section-title">Command 실행 설정</h4>
        <Select
          label="Command ID"
          value={data.commandId || ''}
          onChange={(e) => {
            const command = commandOptions.find((item) => item.command_id === e.target.value);
            onUpdate(node.id, {
              ...data,
              commandId: e.target.value,
              commandTimeoutMs: command?.timeout_ms || data.commandTimeoutMs,
              commandArgumentsJson: data.commandArgumentsJson || buildDefaultCommandArguments(command),
            });
          }}
          options={buildCommandOptions(commandOptions, data.commandId, commandOptionsLoading)}
          helperText={
            commandOptionsError ||
            selectedCommand?.description ||
            '엔진 allowlist registry에 등록된 command_id만 실행됩니다.'
          }
          fullWidth
        />
        {!selectedCommand && data.commandId && (
          <div className="property-helper-text">
            현재 command_id는 목록에 없습니다. engine registry에 없으면 실행 시 실패합니다.
          </div>
        )}
        {selectedCommand && (
          <CommandArgumentGuide command={selectedCommand} arguments={argumentDocs} />
        )}
        <div className="property-group">
          <label className="property-label">Arguments JSON</label>
          <textarea
            className="property-textarea code-textarea"
            value={argumentsJson}
            onChange={(e) => onUpdate(node.id, { ...data, commandArgumentsJson: e.target.value })}
            spellCheck={false}
          />
          <div className="property-helper-text">
            registry의 arg_order에 맞춰 JSON key 값을 인자로 전달합니다. 비워둔 key는 같은 이름의 이전 노드 output path에서 찾습니다.
          </div>
          {jsonError && <div className="property-error-text">{jsonError}</div>}
          {!jsonError && missingRequiredArgs.length > 0 && (
            <div className="property-error-text">
              필수 argument 누락: {missingRequiredArgs.join(', ')}
            </div>
          )}
        </div>
        <Input
          label="Output Path"
          placeholder="commandResults.echo"
          value={data.outputPath || ''}
          onChange={(e) => onUpdate(node.id, { ...data, outputPath: e.target.value })}
          helperText="stdout/stderr/exit_code 실행 결과가 저장될 context path입니다."
          fullWidth
        />
        <Input
          label="Timeout (ms)"
          type="number"
          placeholder="1000"
          value={data.commandTimeoutMs || ''}
          onChange={(e) =>
            onUpdate(node.id, {
              ...data,
              commandTimeoutMs: e.target.value === '' ? '' : Number(e.target.value),
            })
          }
          helperText="registry timeout보다 크게 설정해도 registry 상한으로 제한됩니다."
          fullWidth
        />
      </div>
    );
  };

  // Timer 노드 속성
  const renderTimerProperties = () => {
    const data = node.data as any;
    return (
      <div className="property-section">
        <h4 className="property-section-title">타이머 설정</h4>
        <Input
          label="Duration (ms)"
          type="number"
          placeholder="1000"
          value={data.durationMs || ''}
          onChange={(e) => onUpdate(node.id, { ...data, durationMs: e.target.value })}
          helperText="밀리초 단위 (1000 = 1초)"
          fullWidth
        />
        <Select
          label="Timer Type"
          value={data.timerType || 'delay'}
          onChange={(e) => onUpdate(node.id, { ...data, timerType: e.target.value })}
          options={[
            { value: 'delay', label: 'Delay' },
            { value: 'interval', label: 'Interval' },
            { value: 'cron', label: 'Cron' },
          ]}
          fullWidth
        />
      </div>
    );
  };

  // Gateway 노드 속성
  const renderGatewayProperties = () => {
    const data = node.data as any;
    const gatewayType = data.gatewayType || 'exclusive';
    return (
      <div className="property-section">
        <h4 className="property-section-title">게이트웨이 설정</h4>
        <Select
          label="Gateway Type"
          value={gatewayType}
          onChange={(e) => onUpdate(node.id, { ...data, gatewayType: e.target.value })}
          options={[
            { value: 'exclusive', label: 'Exclusive (XOR)' },
            { value: 'parallel', label: 'Parallel (AND)' },
            { value: 'inclusive', label: 'Inclusive (OR)' },
          ]}
          fullWidth
        />
        {renderGatewayEdgeRules(gatewayType, gatewayEdges, onGatewayEdgeUpdate)}
      </div>
    );
  };

  // Start 노드 속성
  const renderStartProperties = () => {
    const data = node.data as any;
    const triggerType = data.triggerType || 'manual';
    const scheduleType = data.scheduleType || 'interval';
    const dbWatchMode = data.dbWatchMode || 'polling';
    const dbWatchCredentialPolicy = getDbWatchCredentialPolicy();
    const dbWatchCredentials = credentials.filter((credential) =>
      isCredentialCompatible(credential, dbWatchCredentialPolicy),
    );
    const selectedDbWatchCredential = credentials.find(
      (credential) => credential.id === data.dbWatchCredentialId,
    );
    return (
      <>
        <div className="property-section">
          <h4 className="property-section-title">시작 트리거</h4>
          <Select
            label="Trigger Type"
            value={triggerType}
            onChange={(e) =>
              onUpdate(node.id, {
                ...data,
                triggerType: e.target.value,
                scheduleType: data.scheduleType || 'interval',
                intervalSeconds: data.intervalSeconds || 300,
                cronExpression: data.cronExpression || '*/5 * * * *',
                dbWatchMode: data.dbWatchMode || 'polling',
                dbWatchOperation: data.dbWatchOperation || 'insert',
                dbWatchPollIntervalSeconds: data.dbWatchPollIntervalSeconds || 10,
                dbWatchCursorField: data.dbWatchCursorField || 'created_at',
              })
            }
            options={[
              { value: 'manual', label: 'Manual / API' },
              { value: 'schedule', label: 'Schedule' },
              { value: 'db_watch', label: 'DB Watch' },
            ]}
            helperText="Schedule/DB Watch는 템플릿 저장 시 백그라운드 job이 생성됩니다."
            fullWidth
          />
          {triggerType === 'schedule' && (
            <>
              <Select
                label="Schedule Type"
                value={scheduleType}
                onChange={(e) =>
                  onUpdate(node.id, {
                    ...data,
                    triggerType: 'schedule',
                    scheduleType: e.target.value,
                  })
                }
                options={[
                  { value: 'interval', label: 'Interval' },
                  { value: 'cron', label: 'Cron' },
                ]}
                fullWidth
              />
              {scheduleType === 'interval' ? (
                <Input
                  label="Interval Seconds"
                  type="number"
                  min={1}
                  placeholder="300"
                  value={data.intervalSeconds || ''}
                  onChange={(e) =>
                    onUpdate(node.id, {
                      ...data,
                      triggerType: 'schedule',
                      scheduleType: 'interval',
                      intervalSeconds: e.target.value === '' ? '' : Number(e.target.value),
                    })
                  }
                  helperText="예: 300 = 5분마다 실행"
                  fullWidth
                />
              ) : (
                <Input
                  label="Cron Expression"
                  placeholder="*/5 * * * *"
                  value={data.cronExpression || ''}
                  onChange={(e) =>
                    onUpdate(node.id, {
                      ...data,
                      triggerType: 'schedule',
                      scheduleType: 'cron',
                      cronExpression: e.target.value,
                    })
                  }
                  helperText="5-field cron 형식입니다. 예: */5 * * * *"
                  fullWidth
                />
              )}
              <div className="property-group">
                <label className="property-label">Scheduled Input JSON</label>
                <textarea
                  className="property-textarea"
                  value={JSON.stringify(data.scheduleInput || {}, null, 2)}
                  onChange={(e) =>
                    onUpdate(node.id, {
                      ...data,
                      triggerType: 'schedule',
                      scheduleInput: parseJsonLoose(e.target.value),
                    })
                  }
                  spellCheck={false}
                />
                <div className="property-helper-text">
                  스케줄 실행 시 formData로 전달됩니다.
                </div>
              </div>
            </>
          )}
          {triggerType === 'db_watch' && (
            <>
              <Checkbox
                label="DB Watch Enabled"
                checked={data.dbWatchEnabled === true}
                onChange={(e) =>
                  onUpdate(node.id, {
                    ...data,
                    triggerType: 'db_watch',
                    dbWatchEnabled: e.target.checked,
                  })
                }
              />
              <div className="node-test-header">
                <div>
                  <div className="property-label">DB Watch Connection Test</div>
                  <div className="property-helper-text">
                    현재 credential, database, collection, filter로 연결과 조회 권한을 확인합니다.
                  </div>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleTestDbWatchConnection}
                  disabled={dbWatchTestRunning || !data.dbWatchCollection}
                >
                  {dbWatchTestRunning ? '확인 중...' : '연결 테스트'}
                </Button>
              </div>
              {(dbWatchTestResult || dbWatchTestError) && (
                <div className={`node-test-result ${dbWatchTestResult?.ok ? 'success' : 'error'}`}>
                  <div className="node-test-result-meta">
                    {dbWatchTestResult
                      ? `성공 · ${dbWatchTestResult.duration_ms}ms`
                      : '실패'}
                  </div>
                  <JsonTreeView
                    value={dbWatchTestResult?.details ?? { error: dbWatchTestError }}
                    onPathClick={handleCopyPath}
                  />
                </div>
              )}
              <Select
                label="MongoDB Credential"
                value={data.dbWatchCredentialId || ''}
                onChange={(e) =>
                  onUpdate(node.id, {
                    ...data,
                    triggerType: 'db_watch',
                    dbWatchCredentialId: e.target.value || undefined,
                  })
                }
                options={buildCredentialOptions(dbWatchCredentials, dbWatchCredentialPolicy)}
                helperText={
                  credentialsError ||
                  (credentialsLoading
                    ? 'Credential 목록을 불러오는 중입니다.'
                    : dbWatchCredentialPolicy.helperText)
                }
                fullWidth
              />
              {selectedDbWatchCredential && (
                <CredentialBindingSummary
                  credential={selectedDbWatchCredential}
                  binding={buildCredentialBinding(selectedDbWatchCredential, dbWatchCredentialPolicy)}
                  policy={dbWatchCredentialPolicy}
                />
              )}
              <Input
                label="Database"
                placeholder="pxm_db"
                value={data.dbWatchDatabase || ''}
                onChange={(e) =>
                  onUpdate(node.id, {
                    ...data,
                    triggerType: 'db_watch',
                    dbWatchDatabase: e.target.value,
                  })
                }
                helperText="비워두면 API가 연결한 기본 Mongo DB를 사용합니다."
                fullWidth
              />
              <Input
                label="Collection"
                placeholder="incoming_requests"
                value={data.dbWatchCollection || ''}
                onChange={(e) =>
                  onUpdate(node.id, {
                    ...data,
                    triggerType: 'db_watch',
                    dbWatchCollection: e.target.value,
                  })
                }
                fullWidth
              />
              <Select
                label="Watch Mode"
                value={dbWatchMode}
                onChange={(e) =>
                  onUpdate(node.id, {
                    ...data,
                    triggerType: 'db_watch',
                    dbWatchMode: e.target.value as any,
                  })
                }
                options={[
                  { value: 'polling', label: 'Polling' },
                  { value: 'change_stream', label: 'Mongo Change Stream' },
                ]}
                helperText="Change Stream은 Mongo replica set 또는 managed cluster가 필요합니다."
                fullWidth
              />
              <Select
                label="Operation"
                value={data.dbWatchOperation || 'insert'}
                onChange={(e) =>
                  onUpdate(node.id, {
                    ...data,
                    triggerType: 'db_watch',
                    dbWatchOperation: e.target.value as any,
                  })
                }
                options={[
                  { value: 'insert', label: 'Insert / new cursor' },
                  { value: 'update', label: 'Update / changed cursor' },
                  { value: 'upsert', label: 'Upsert / changed cursor' },
                ]}
                helperText="Polling은 cursor 증가를 감지하고, Change Stream은 Mongo 변경 이벤트를 받습니다."
                fullWidth
              />
              <Input
                label="Cursor Field"
                placeholder="created_at"
                value={data.dbWatchCursorField ?? 'created_at'}
                onChange={(e) =>
                  onUpdate(node.id, {
                    ...data,
                    triggerType: 'db_watch',
                    dbWatchCursorField: e.target.value,
                  })
                }
                helperText={
                  dbWatchMode === 'change_stream'
                    ? 'Change Stream에서는 이벤트 식별값으로 사용합니다. 비워두면 Mongo change _id를 fallback으로 사용합니다.'
                    : 'Polling에서는 created_at, updated_at처럼 증가 비교가 가능한 필드를 기준으로 새 문서를 찾습니다.'
                }
                fullWidth
              />
              {dbWatchMode === 'polling' ? (
                <Input
                  label="Poll Interval Seconds"
                  type="number"
                  min={1}
                  placeholder="10"
                  value={data.dbWatchPollIntervalSeconds || ''}
                  onChange={(e) =>
                    onUpdate(node.id, {
                      ...data,
                      triggerType: 'db_watch',
                      dbWatchPollIntervalSeconds: e.target.value === '' ? '' : Number(e.target.value),
                    })
                  }
                  helperText="Polling 모드에서 다음 조회까지 기다릴 시간입니다."
                  fullWidth
                />
              ) : (
                <div className="property-helper-text">
                  Change Stream 모드는 MongoDB 변경 이벤트를 실시간으로 구독하므로 poll interval을 사용하지 않습니다.
                </div>
              )}
              <div className="property-group">
                <label className="property-label">Filter JSON</label>
                <textarea
                  className="property-textarea"
                  value={dbWatchFilterJson}
                  onChange={(e) => {
                    const raw = e.target.value;
                    setDbWatchFilterJson(raw);
                    const parsed = parseJsonObject(raw);
                    if (parsed.ok) {
                      setDbWatchFilterError(null);
                      onUpdate(node.id, {
                        ...data,
                        triggerType: 'db_watch',
                        dbWatchFilter: parsed.value,
                      });
                    } else {
                      setDbWatchFilterError(parsed.message);
                    }
                  }}
                  spellCheck={false}
                />
                <div className="property-helper-text">
                  매칭된 문서는 formData.document로 전달됩니다.
                </div>
                {dbWatchFilterError && (
                  <div className="property-error-text">{dbWatchFilterError}</div>
                )}
              </div>
            </>
          )}
        </div>
        <div className="property-section">
          <FormSchemaEditor
            schema={data.formSchema}
            onChange={(schema: FormSchema) => onUpdate(node.id, { ...data, formSchema: schema })}
          />
        </div>
      </>
    );
  };

  // Approval 노드 속성
  const renderApprovalProperties = () => {
    const data = node.data as any;
    const approvalLineSource = data.approvalLineSource || (data.approvalType === 'dynamic' ? 'dynamic' : 'fixed');
    const approvalChannels: Array<'pxm_user' | 'external_email'> =
      Array.isArray(data.approvalChannels) && data.approvalChannels.length
        ? data.approvalChannels
        : [data.approverChannel || 'pxm_user'];
    const allowsPxm = approvalChannels.includes('pxm_user');
    const allowsExternal = approvalChannels.includes('external_email');
    const approvalChannelMode = allowsPxm && allowsExternal
      ? 'hybrid'
      : allowsExternal
        ? 'external_email'
        : 'pxm_user';
    const externalEmail = String(
      allowsPxm ? data.externalApprovalEmail || '' : data.assignee || '',
    ).trim();
    const externalEmailInvalid =
      allowsExternal &&
      externalEmail.length > 0 &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(externalEmail);
    const workflowGroup = workflowGroups.find((group) => group.id === credentialGroupId);
    return (
      <div className="property-section">
        <h4 className="property-section-title">승인 설정</h4>
        <Select
          label="결재라인 입력 방식"
          value={approvalLineSource}
          onChange={(e) => onUpdate(node.id, {
            ...data,
            approvalLineSource: e.target.value as 'fixed' | 'dynamic',
          })}
          options={[
            { value: 'fixed', label: '워크플로우에서 지정' },
            { value: 'dynamic', label: '실행 요청에서 전달' },
          ]}
          helperText="동적 방식은 실행 시 결재 내용과 순차 결재라인을 함께 받습니다."
          fullWidth
        />
        {approvalLineSource === 'dynamic' ? (
          <Input
            label="결재 요청 경로"
            placeholder="approval_request"
            value={data.approvalRequestPath || 'approval_request'}
            onChange={(e) => onUpdate(node.id, { ...data, approvalRequestPath: e.target.value.trim() })}
            helperText="formData 아래에서 결재 요청 객체를 찾을 경로입니다."
            fullWidth
          />
        ) : (
          <>
        {credentialGroupId ? (
          <div className="property-group">
            <span className="property-label">워크플로우 소유 그룹</span>
            <div className="property-value-readonly">
              {workflowGroup?.name || credentialGroupId}
            </div>
            <span className="property-helper-text">
              워크플로우 전체에 적용되는 값입니다. 변경은 빈 캔버스의 워크플로우 속성에서 할 수 있습니다.
            </span>
          </div>
        ) : (
          <Select
            label="워크플로우 소유 그룹 지정"
            value=""
            onChange={(e) => onWorkflowGroupChange?.(e.target.value)}
            options={[
              {
                value: '',
                label: workflowGroupsLoading ? '그룹 불러오는 중...' : '소유 그룹 선택',
              },
              ...workflowGroups.map((group) => ({ value: group.id, label: group.name })),
            ]}
            helperText={workflowGroupsError || '승인자를 선택하려면 먼저 워크플로우 전체의 소유 그룹을 지정해야 합니다.'}
            disabled={workflowGroupsLoading || Boolean(workflowGroupsError) || !onWorkflowGroupChange}
            fullWidth
          />
        )}
        <Select
          label="승인 채널"
          value={approvalChannelMode}
          onChange={(e) => {
            const mode = e.target.value;
            const channels: Array<'pxm_user' | 'external_email'> =
              mode === 'hybrid'
                ? ['pxm_user', 'external_email']
                : [mode as 'pxm_user' | 'external_email'];
            onUpdate(node.id, {
              ...data,
              approverChannel: channels.includes('pxm_user')
                ? 'pxm_user'
                : 'external_email',
              approvalChannels: channels,
              assignee: '',
              externalApprovalEmail: '',
            });
          }}
          options={[
            { value: 'pxm_user', label: 'PXM 웹' },
            { value: 'external_email', label: '이메일 링크' },
            { value: 'hybrid', label: 'PXM 웹 + 이메일 링크' },
          ]}
          helperText="두 채널을 선택해도 결재 Task는 하나이며, 먼저 처리한 채널만 인정됩니다."
          fullWidth
        />
        {allowsPxm && (
          <Select
            label="PXM 승인자"
            value={data.assignee || ''}
            onChange={(e) => onUpdate(node.id, { ...data, assignee: e.target.value })}
            options={[
              { value: '', label: approvalUsersLoading ? '사용자 불러오는 중...' : '승인자 선택' },
              ...approvalUsers.map((user) => ({
                value: user.id,
                label: `${user.display_name} (${user.id})${user.email ? ` · ${user.email}` : ''}`,
              })),
            ]}
            helperText={approvalUsersError || 'Workflow 소유 그룹의 활성 사용자만 선택할 수 있습니다.'}
            disabled={!credentialGroupId || approvalUsersLoading}
            fullWidth
          />
        )}
        {allowsExternal && (
          <>
            <Input
              type="email"
              label="승인자 이메일"
              placeholder="approver@example.com"
              value={externalEmail}
              onChange={(e) =>
                onUpdate(node.id, {
                  ...data,
                  ...(allowsPxm
                    ? { externalApprovalEmail: e.target.value.trim() }
                    : { assignee: e.target.value.trim() }),
                })
              }
              error={externalEmailInvalid ? '올바른 이메일 주소를 입력하세요.' : undefined}
              helperText={
                allowsPxm
                  ? '같은 승인자에게 PXM 결재함과 일회용 이메일 링크를 함께 제공합니다.'
                  : '일회용 승인 링크가 이 주소로 발송됩니다. PXM 가입은 필요하지 않습니다.'
              }
              fullWidth
            />
            <Input
              type="number"
              min={1}
              max={168}
              label="승인 링크 유효시간 (시간)"
              value={data.externalApprovalExpiresInHours ?? 24}
              onChange={(e) => onUpdate(node.id, {
                ...data,
                externalApprovalExpiresInHours: Math.min(168, Math.max(1, Number(e.target.value) || 24)),
              })}
              helperText="1~168시간. 링크는 한 번 처리되면 다시 사용할 수 없습니다."
              fullWidth
            />
            <Checkbox
              label="이메일 OTP 추가 확인"
              checked={data.externalApprovalRequireOtp ?? true}
              onChange={(e) => onUpdate(node.id, { ...data, externalApprovalRequireOtp: e.target.checked })}
            />
            <div className="property-helper-text">
              OTP를 끄면 이메일 링크 소유만으로 승인할 수 있으므로 낮은 위험도의 업무에만 권장합니다.
            </div>
          </>
        )}
        <Select
          label="Approval Type"
          value={data.approvalType || 'single'}
          onChange={(e) => onUpdate(node.id, { ...data, approvalType: e.target.value })}
          options={[
            { value: 'single', label: '단일 승인자' },
            { value: 'multiple', label: '다중 승인자' },
            { value: 'sequential', label: '순차 승인' },
          ]}
          fullWidth
        />
          </>
        )}
        <Checkbox
          label="Require Comment"
          checked={data.requireComment || false}
          onChange={(e) => onUpdate(node.id, { ...data, requireComment: e.target.checked })}
        />
      </div>
    );
  };

  const renderWorkflowCallProperties = () => {
    const data = node.data as any;
    const selectedWorkflow = workflowOptions.find((workflow) => workflow.id === data.targetWorkflowId);
    const callMode = data.workflowCallMode || data.callMode || 'async';
    const inputMode = data.workflowInputMode || 'inherit_form_data';
    const staticJsonError =
      inputMode === 'static_json' ? validateJsonText(data.workflowInputJson || '{}') : null;

    return (
      <div className="property-section">
        <h4 className="property-section-title">워크플로우 호출</h4>
        <Select
          label="호출 대상"
          value={data.targetWorkflowId || ''}
          onChange={(e) => {
            const workflow = workflowOptions.find((item) => item.id === e.target.value);
            onUpdate(node.id, {
              ...data,
              targetWorkflowId: workflow?.id || '',
              targetWorkflowName: workflow?.name || '',
            });
          }}
          options={[
            { value: '', label: workflowOptionsLoading ? '불러오는 중...' : '워크플로우 선택' },
            ...workflowOptions.map((workflow) => ({
              value: workflow.id,
              label: workflow.name,
            })),
          ]}
          helperText={workflowOptionsError || (selectedWorkflow ? selectedWorkflow.id : '호출할 자식 워크플로우를 선택합니다.')}
          fullWidth
        />
        <Select
          label="호출 모드"
          value={callMode}
          onChange={(e) => onUpdate(node.id, { ...data, workflowCallMode: e.target.value as any })}
          options={[
            { value: 'async', label: 'Async - 시작만 요청하고 다음 노드 진행' },
            { value: 'wait', label: 'Wait - 자식 완료 후 다음 노드 진행' },
          ]}
          helperText={
            callMode === 'wait'
              ? '부모 instance는 WAITING 상태가 되고, 자식 완료/실패 후 재개됩니다.'
              : '자식 instance 생성과 START job 등록까지만 보장합니다.'
          }
          fullWidth
        />
        {callMode === 'wait' && (
          <Input
            label="Wait Timeout (ms)"
            type="number"
            min={1000}
            placeholder="300000"
            value={data.workflowWaitTimeoutMs || ''}
            onChange={(e) =>
              onUpdate(node.id, {
                ...data,
                workflowWaitTimeoutMs: e.target.value === '' ? '' : Number(e.target.value),
              })
            }
            helperText="비워두면 기본 300000ms(5분) 후 timeout 실패 처리합니다."
            fullWidth
          />
        )}
        <Select
          label="입력 전달"
          value={inputMode}
          onChange={(e) => onUpdate(node.id, { ...data, workflowInputMode: e.target.value as any })}
          options={[
            { value: 'inherit_form_data', label: '현재 formData 그대로 전달' },
            { value: 'context_path', label: 'Context path 값 전달' },
            { value: 'static_json', label: '정적 JSON 전달' },
          ]}
          fullWidth
        />
        {inputMode === 'context_path' && (
          <Input
            label="Input Path"
            placeholder="scriptResults.prepareInput"
            value={data.workflowInputPath || ''}
            onChange={(e) => onUpdate(node.id, { ...data, workflowInputPath: e.target.value })}
            helperText="예: formData, outputs.prepareInput, scriptResults.prepareInput"
            fullWidth
          />
        )}
        {inputMode === 'static_json' && (
          <div className="property-group">
            <label className="property-label">Input JSON</label>
            <textarea
              className="property-textarea"
              value={data.workflowInputJson || '{\n  \n}'}
              onChange={(e) => onUpdate(node.id, { ...data, workflowInputJson: e.target.value })}
              spellCheck={false}
            />
            {staticJsonError && <div className="property-error-text">{staticJsonError}</div>}
          </div>
        )}
        <Input
          label="Output Path"
          placeholder="workflowCalls.child"
          value={data.outputPath || ''}
          onChange={(e) => onUpdate(node.id, { ...data, outputPath: e.target.value })}
          helperText="child_instance_id와 호출 상태를 저장할 context path입니다."
          fullWidth
        />
      </div>
    );
  };

  const renderEndProperties = () => {
    const data = node.data as any;
    return (
      <div className="property-section">
        <h4 className="property-section-title">완료 결과</h4>
        <Input
          label="Result Path"
          placeholder="scriptResults.calculateAmount"
          value={data.resultPath || ''}
          onChange={(e) => onUpdate(node.id, { ...data, resultPath: e.target.value })}
          helperText="비워두면 context.data만 result로 저장됩니다."
          fullWidth
        />
      </div>
    );
  };

  return (
    <div className="node-properties-form">
      {/* 기본 속성 */}
      <div className="property-section">
        <h4 className="property-section-title">기본 정보</h4>
        <div className="property-group">
          <label className="property-label">노드 ID</label>
          <div className="property-value-readonly">{node.id}</div>
        </div>
        <div className="property-group">
          <label className="property-label">노드 타입</label>
          <div className="property-value-readonly">{node.data.nodeType}</div>
        </div>
        <Input
          label="레이블"
          value={node.data.label}
          onChange={handleLabelChange}
          fullWidth
        />
        <Input
          label="설명"
          value={node.data.description || ''}
          onChange={handleDescriptionChange}
          fullWidth
        />
      </div>

      {/* 노드별 속성 */}
      {node.data.nodeType === 'start' && renderStartProperties()}
      {node.data.nodeType === 'service' && renderServiceProperties()}
      {node.data.nodeType === 'script' && renderScriptProperties()}
      {node.data.nodeType === 'command' && renderCommandProperties()}
      {node.data.nodeType === 'timer' && renderTimerProperties()}
      {node.data.nodeType === 'gateway' && renderGatewayProperties()}
      {node.data.nodeType === 'approval' && renderApprovalProperties()}
      {node.data.nodeType === 'workflow_call' && renderWorkflowCallProperties()}
      {node.data.nodeType === 'end' && renderEndProperties()}

      {/* 위치 정보 */}
      <div className="property-section">
        <h4 className="property-section-title">위치</h4>
        <div className="property-group">
          <label className="property-label">좌표</label>
          <div className="property-value-readonly">
            X: {Math.round(node.position.x)}, Y: {Math.round(node.position.y)}
          </div>
        </div>
      </div>
    </div>
  );
};

function findPluginManifest(plugins: PluginManifest[], pluginId: string) {
  return plugins.find((plugin) => plugin.plugin_id === pluginId);
}

function renderGatewayEdgeRules(
  gatewayType: string,
  gatewayEdges: Edge[],
  onGatewayEdgeUpdate?: (edgeId: string, data: Partial<Edge>) => void,
) {
  const isParallel = gatewayType === 'parallel';
  return (
    <div className="gateway-rule-list">
      <div className="gateway-rule-list-title">Outgoing Edge Rules</div>
      <div className="gateway-rule-note">
        {isParallel
          ? 'AND 게이트웨이는 조건을 평가하지 않고 모든 outgoing edge를 실행합니다.'
          : 'XOR/OR 조건은 나가는 엣지별로 입력합니다. 값은 edge.data.condition에 저장됩니다.'}
      </div>
      {gatewayEdges.length === 0 ? (
        <div className="gateway-rule-empty">연결된 outgoing edge가 없습니다.</div>
      ) : (
        gatewayEdges.map((edge, index) => {
          const condition = getEdgeCondition(edge);
          const isDefault = Boolean((edge.data as any)?.isDefault);
          const label = getEdgeLabel(edge, index);
          return (
            <div className="gateway-rule-item" key={edge.id}>
              <div className="gateway-rule-header">
                <span className="gateway-rule-label">{label}</span>
                {isDefault && <span className="gateway-rule-badge">default</span>}
              </div>
              <div className="gateway-rule-target">to: {edge.target}</div>
              <Input
                label="Edge Label"
                value={label}
                onChange={(event) =>
                  onGatewayEdgeUpdate?.(edge.id, {
                    label: event.target.value,
                    data: { label: event.target.value },
                  })
                }
                fullWidth
              />
              {isParallel ? (
                <div className="gateway-rule-condition">condition: not used</div>
              ) : (
                <>
                  <Input
                    label="Condition Expression"
                    placeholder="amount > 1000"
                    value={condition}
                    disabled={isDefault}
                    onChange={(event) =>
                      onGatewayEdgeUpdate?.(edge.id, {
                        data: { condition: event.target.value },
                      })
                    }
                    helperText={
                      isDefault
                        ? 'Default path는 조건식 없이 사용됩니다.'
                        : '형식: 필드 연산자 값 (==, !=, >=, <=, >, <). 신청 입력(formData)의 최상위 필드만 참조합니다. 공백이 있는 문자열은 따옴표로 감쌉니다. 예: amount >= 1000, status == "approval pending"'
                    }
                    fullWidth
                  />
                  <Checkbox
                    label="Default path"
                    checked={isDefault}
                    onChange={(event) =>
                      onGatewayEdgeUpdate?.(edge.id, {
                        data: {
                          isDefault: event.target.checked,
                          condition: event.target.checked ? '' : condition,
                        },
                      })
                    }
                  />
                </>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

function getEdgeLabel(edge: Edge, index: number): string {
  const dataLabel = (edge.data as any)?.label;
  if (typeof edge.label === 'string' && edge.label.trim()) {
    return edge.label;
  }
  if (typeof dataLabel === 'string' && dataLabel.trim()) {
    return dataLabel;
  }
  return `Edge ${index + 1}`;
}

function getEdgeCondition(edge: Edge): string {
  const condition = (edge.data as any)?.condition;
  return typeof condition === 'string' ? condition : '';
}

function buildPluginOptions(plugins: PluginManifest[]) {
  const options = plugins.map((plugin) => ({
    value: plugin.plugin_id,
    label: plugin.display_name,
  }));

  return options;
}

function buildCommandOptions(
  commands: CommandRegistryItem[],
  currentCommandId?: string,
  loading = false,
) {
  const options = [
    { value: '', label: loading ? '불러오는 중...' : 'Command 선택' },
    ...commands.map((command) => ({
      value: command.command_id,
      label: command.display_name || command.command_id,
    })),
  ];

  if (currentCommandId && !commands.some((command) => command.command_id === currentCommandId)) {
    options.push({ value: currentCommandId, label: `${currentCommandId} (custom)` });
  }

  return options;
}

function buildDefaultCommandArguments(command?: CommandRegistryItem) {
  if (!command) {
    return '{\n  \n}';
  }
  const properties = command.argument_schema?.properties;
  if (!properties || typeof properties !== 'object') {
    return '{\n  \n}';
  }
  const value = Object.fromEntries(
    Object.entries(properties).map(([key, schema]: [string, any]) => [
      key,
      schema?.default ?? '',
    ]),
  );
  return JSON.stringify(value, null, 2);
}

type CommandArgumentDoc = {
  key: string;
  title: string;
  type: string;
  required: boolean;
  defaultValue: unknown;
  description: string;
  orderIndex: number | null;
  source: CommandArgumentSource;
};

type CommandArgumentSource =
  | { kind: 'json' }
  | { kind: 'upstream'; suggestion: NodePathSuggestion }
  | { kind: 'missing' }
  | { kind: 'optional' };

function buildCommandArgumentDocs(
  command: CommandRegistryItem,
  argumentsJson: string,
  pathSuggestions: NodePathSuggestion[],
): CommandArgumentDoc[] {
  const schema = command.argument_schema || {};
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const orderIndex = new Map(command.arg_order.map((key, index) => [key, index]));
  const keys = Array.from(new Set([...command.arg_order, ...Object.keys(properties)]));
  const argumentValues = parseCommandArgumentsObject(argumentsJson);
  const upstreamByPath = buildUpstreamPathMap(pathSuggestions);

  return keys.map((key) => {
    const property = isPlainObject(properties[key]) ? properties[key] : {};
    const source = resolveCommandArgumentSource(
      key,
      required.has(key),
      argumentValues,
      upstreamByPath,
    );
    return {
      key,
      title: typeof property.title === 'string' ? property.title : key,
      type: typeof property.type === 'string' ? property.type : 'any',
      required: required.has(key),
      defaultValue: property.default,
      description: typeof property.description === 'string' ? property.description : '',
      orderIndex: orderIndex.has(key) ? orderIndex.get(key)! : null,
      source,
    };
  });
}

function findMissingRequiredCommandArgs(
  command: CommandRegistryItem,
  argumentsJson: string,
  pathSuggestions: NodePathSuggestion[],
): string[] {
  const schema = command.argument_schema || {};
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  if (required.length === 0) {
    return [];
  }

  const argumentValues = parseCommandArgumentsObject(argumentsJson);
  const upstreamByPath = buildUpstreamPathMap(pathSuggestions);

  return required.filter((key) =>
    resolveCommandArgumentSource(key, true, argumentValues, upstreamByPath).kind === 'missing',
  );
}

function parseCommandArgumentsObject(argumentsJson: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(argumentsJson);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function buildUpstreamPathMap(pathSuggestions: NodePathSuggestion[]): Map<string, NodePathSuggestion> {
  const map = new Map<string, NodePathSuggestion>();
  for (const suggestion of pathSuggestions) {
    map.set(normalizeArgumentPath(suggestion.path), suggestion);
  }
  return map;
}

function resolveCommandArgumentSource(
  key: string,
  required: boolean,
  argumentValues: Record<string, unknown> | null,
  upstreamByPath: Map<string, NodePathSuggestion>,
): CommandArgumentSource {
  const value = argumentValues?.[key];
  if (value !== undefined && value !== null && value !== '') {
    return { kind: 'json' };
  }

  const upstream = upstreamByPath.get(normalizeArgumentPath(key));
  if (upstream) {
    return { kind: 'upstream', suggestion: upstream };
  }

  return required ? { kind: 'missing' } : { kind: 'optional' };
}

function normalizeArgumentPath(path: string) {
  return path.trim().replace(/^context\./, '').replace(/^data\.outputs\./, '');
}

function CommandArgumentGuide({
  command,
  arguments: argumentDocs,
}: {
  command: CommandRegistryItem;
  arguments: CommandArgumentDoc[];
}) {
  if (argumentDocs.length === 0) {
    return (
      <div className="command-argument-guide compact">
        이 command는 추가 arguments를 요구하지 않습니다.
      </div>
    );
  }

  return (
    <div className="command-argument-guide">
      <div className="command-argument-guide-title">
        Arguments Contract
        <span>{command.arg_order.length > 0 ? `CLI order: ${command.arg_order.join(' -> ')}` : 'CLI arguments 없음'}</span>
      </div>
      <div className="command-argument-list">
        {argumentDocs.map((argument) => (
          <div className="command-argument-item" key={argument.key}>
            <div className="command-argument-main">
              <code>{argument.key}</code>
              <span>{argument.title}</span>
              {argument.required && <strong>required</strong>}
              <CommandArgumentSourceBadge source={argument.source} />
            </div>
            <div className="command-argument-meta">
              <span>type: {argument.type}</span>
              <span>
                order: {argument.orderIndex === null ? 'not passed' : argument.orderIndex + 1}
              </span>
              {argument.defaultValue !== undefined && (
                <span>default: {String(argument.defaultValue)}</span>
              )}
            </div>
            {argument.description && (
              <div className="command-argument-description">{argument.description}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function CommandArgumentSourceBadge({ source }: { source: CommandArgumentSource }) {
  if (source.kind === 'json') {
    return <em className="command-argument-source is-json">Arguments JSON</em>;
  }

  if (source.kind === 'upstream') {
    return (
      <em
        className="command-argument-source is-upstream"
        title={`${source.suggestion.sourceNodeLabel}: ${source.suggestion.path}`}
      >
        이전 노드: {source.suggestion.sourceNodeLabel}
      </em>
    );
  }

  if (source.kind === 'missing') {
    return <em className="command-argument-source is-missing">누락</em>;
  }

  return <em className="command-argument-source is-optional">선택</em>;
}

type CredentialPolicy = {
  mode: 'none' | 'mongodb_connection' | 'http_auth' | 'ssh_connection';
  title: string;
  helperText: string;
  handledFields: string[];
  allowedTypes: CredentialProfile['type'][];
  preferredScopes: string[];
};

function buildCredentialOptions(
  credentials: CredentialProfile[],
  policy: CredentialPolicy,
  required = false,
) {
  if (policy.mode === 'none') {
    return [{ value: '', label: '이 노드는 credential을 사용하지 않음' }];
  }

  return [
    ...(required
      ? [{ value: '', label: credentials.length ? 'Credential을 선택하세요' : '사용 가능한 Credential이 없습니다' }]
      : [{ value: '', label: 'Credential 미사용' }]),
    ...credentials.map((credential) => ({
      value: credential.id,
      label: `${credential.name} (${credential.type})`,
    })),
  ];
}

function isCredentialRequired(plugin?: PluginManifest) {
  const requiredSecrets = plugin?.secrets_policy?.required;
  return Boolean(
    requiredSecrets &&
    typeof requiredSecrets === 'object' &&
    Object.values(requiredSecrets).some((value) => value === 'ref://credential_id'),
  );
}

function getCredentialPolicy(plugin?: PluginManifest): CredentialPolicy {
  const pluginId = plugin?.plugin_id || '';
  const tags = plugin?.tags || [];

  if (pluginId === 'connector.db.mongodb.query' || tags.includes('mongodb')) {
    return {
      mode: 'mongodb_connection',
      title: 'MongoDB connection URI',
      helperText: 'Connection String 타입이며 mongo/mongodb/db/database 계열 scope가 있는 credential만 표시됩니다. 선택하면 Connection URI를 대신합니다.',
      handledFields: ['connection_uri'],
      allowedTypes: ['connection_string'],
      preferredScopes: ['mongo', 'mongodb', 'mongo-db', 'mongo_db', 'db', 'database'],
    };
  }

  if (pluginId === 'builtin.http_request' || tags.includes('http') || tags.includes('webhook')) {
    return {
      mode: 'http_auth',
      title: 'HTTP authentication',
      helperText: 'API Key, Bearer Token, Basic Auth credential만 표시됩니다. 선택하면 요청 인증 헤더로 사용됩니다.',
      handledFields: [],
      allowedTypes: ['api_key', 'bearer_token', 'basic_auth', 'custom'],
      preferredScopes: ['http', 'api', 'webhook'],
    };
  }

  if (pluginId === 'builtin.ssh' || tags.includes('ssh')) {
    return {
      mode: 'ssh_connection',
      title: 'SSH connection',
      helperText: 'SSH Credential은 필수입니다. Credential Store에서 host, username, 인증 정보와 host key fingerprint를 등록하세요.',
      handledFields: [],
      allowedTypes: ['ssh'],
      preferredScopes: ['ssh', 'remote', 'server', 'deploy'],
    };
  }

  return {
    mode: 'none',
    title: 'Credential',
    helperText: '현재 선택한 플러그인은 credential binding 규칙이 없습니다.',
    handledFields: [],
    allowedTypes: [],
    preferredScopes: [],
  };
}

function getDbWatchCredentialPolicy(): CredentialPolicy {
  return {
    mode: 'mongodb_connection',
    title: 'MongoDB watch connection URI',
    helperText: 'Connection String 타입이며 mongo/mongodb/db/database 계열 scope가 있는 credential만 표시됩니다. 비워두면 API 서버의 기본 MongoDB 연결을 사용합니다.',
    handledFields: [],
    allowedTypes: ['connection_string'],
    preferredScopes: ['mongo', 'mongodb', 'mongo-db', 'mongo_db', 'db', 'database'],
  };
}

function isCredentialCompatible(credential: CredentialProfile, policy: CredentialPolicy) {
  if (policy.mode === 'none') return false;
  if (!credential.active) return false;
  if (!policy.allowedTypes.includes(credential.type)) return false;

  if (policy.mode === 'mongodb_connection') {
    return credential.scopes.some((scope) => {
      const normalized = normalizeScope(scope);
      return policy.preferredScopes.some((allowed) => normalizeScope(allowed) === normalized);
    });
  }

  return true;
}

function normalizeScope(scope: string) {
  return scope.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function buildCredentialBinding(credential: CredentialProfile, policy: CredentialPolicy) {
  if (policy.mode === 'mongodb_connection') {
    return {
      target: 'connection_uri' as const,
      field: 'connection_uri',
    };
  }

  if (policy.mode === 'ssh_connection') {
    return {
      target: 'ssh_credential' as const,
      field: 'ssh_credential',
    };
  }

  if (credential.type === 'bearer_token') {
    return {
      target: 'authorization_header' as const,
      headerName: 'Authorization',
      scheme: 'Bearer',
    };
  }

  if (credential.type === 'basic_auth') {
    return {
      target: 'basic_auth_header' as const,
      headerName: 'Authorization',
      scheme: 'Basic',
    };
  }

  return {
    target: 'api_key_header' as const,
    headerName: typeof credential.metadata?.headerName === 'string'
      ? credential.metadata.headerName
      : 'x-api-key',
  };
}

function CredentialBindingSummary({
  credential,
  binding,
  policy,
}: {
  credential: CredentialProfile;
  binding: ReturnType<typeof buildCredentialBinding>;
  policy: CredentialPolicy;
}) {
  const destination =
    binding.target === 'connection_uri'
      ? 'Connection URI 필드'
      : binding.target === 'ssh_credential'
        ? 'SSH 연결 정보'
      : `${binding.headerName}${binding.scheme ? ` (${binding.scheme})` : ''} 헤더`;

  return (
    <div className="credential-binding-summary">
      <div className="credential-binding-title">{policy.title}</div>
      <div className="credential-binding-row">
        <span>선택됨</span>
        <strong>{credential.name}</strong>
      </div>
      <div className="credential-binding-row">
        <span>사용 위치</span>
        <strong>{destination}</strong>
      </div>
      <div className="credential-binding-note">
        Secret 원문은 노드에 저장되지 않고 실행 시 credential store에서 읽습니다.
      </div>
    </div>
  );
}

function renderPluginConfigFields(
  plugin: PluginManifest,
  data: Record<string, any>,
  onUpdate: (data: Partial<CustomNodeData>) => void,
  credentialPolicy?: CredentialPolicy,
) {
  const required = new Set(plugin.config_schema.required || []);
  const entries = Object.entries(plugin.config_schema.properties || {});

  if (entries.length === 0) {
    return <div className="property-value-readonly">No configuration</div>;
  }

  return entries.map(([key, property]) => {
    if (credentialPolicy?.handledFields.includes(key)) {
      return (
        <CredentialManagedFieldNotice
          key={key}
          label={property.title || key}
          field={key}
          policy={credentialPolicy}
        />
      );
    }

    const value = data[key] ?? property.default ?? '';
    const label = property.title || key;
    const isRequired = required.has(key);
    const helperText = property.description;

    if (property.enum?.length) {
      return (
        <Select
          key={key}
          label={label}
          value={String(value)}
          onChange={(e) => onUpdate({ ...data, [key]: e.target.value })}
          options={property.enum.map((item) => ({ value: item, label: item }))}
          helperText={helperText}
          required={isRequired}
          fullWidth
        />
      );
    }

    if (property.type === 'boolean') {
      return (
        <Checkbox
          key={key}
          label={label}
          checked={Boolean(value)}
          onChange={(e) => onUpdate({ ...data, [key]: e.target.checked })}
        />
      );
    }

    if (property.type === 'object' || property.type === 'array') {
      const invalidJson = typeof value === 'string' && value.trim() !== '';
      return (
        <div className="property-group" key={key}>
          <label className="property-label">
            {label}
            {isRequired && <span className="input-required">*</span>}
          </label>
          <textarea
            className="property-textarea"
            value={typeof value === 'string' ? value : JSON.stringify(value || {}, null, 2)}
            onChange={(e) => onUpdate({ ...data, [key]: parseJsonLoose(e.target.value) })}
            aria-invalid={invalidJson}
          />
          {helperText && <div className="property-helper-text">{helperText}</div>}
          {invalidJson && (
            <div className="property-helper-text property-error-text">
              올바른 JSON {property.type === 'array' ? 'array' : 'object'}를 입력하세요.
            </div>
          )}
        </div>
      );
    }

    return (
      <Input
        key={key}
        label={label}
        type={property.type === 'integer' || property.type === 'number' ? 'number' : 'text'}
        value={value}
        onChange={(e) => onUpdate({ ...data, [key]: normalizeInputValue(e.target.value, property) })}
        helperText={helperText}
        required={isRequired}
        fullWidth
      />
    );
  });
}

function CredentialManagedFieldNotice({
  label,
  field,
  policy,
}: {
  label: string;
  field: string;
  policy: CredentialPolicy;
}) {
  return (
    <div className="credential-managed-field">
      <div>
        <div className="credential-managed-label">{label}</div>
        <div className="credential-managed-helper">
          이 값은 선택한 credential secret으로 제공됩니다.
        </div>
      </div>
      <code>{field}</code>
      <span>{policy.title}</span>
    </div>
  );
}

function normalizeInputValue(value: string, property: PluginJsonSchemaProperty) {
  if (property.type === 'integer') {
    return value === '' ? '' : Number.parseInt(value, 10);
  }
  if (property.type === 'number') {
    return value === '' ? '' : Number.parseFloat(value);
  }
  return value;
}

function parseJsonLoose(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseJsonObject(value: string): { ok: true; value: Record<string, any> } | { ok: false; message: string } {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, message: 'JSON object 형식으로 입력하세요. 예: {"type":"approval"}' };
    }
    return { ok: true, value: parsed };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'JSON 파싱에 실패했습니다.',
    };
  }
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getTestResultValue(result?: PluginTestResponse | null, error?: string | null) {
  if (error && !result?.output) {
    return { error };
  }
  return result?.output ?? { error };
}

function SshTestTerminal({
  command,
  result,
  error,
}: {
  command: string;
  result?: PluginTestResponse | null;
  error?: string | null;
}) {
  const output = isPlainObject(result?.output) ? result.output : {};
  const stdout = sanitizeTerminalText(typeof output.stdout === 'string' ? output.stdout : '');
  const stderr = sanitizeTerminalText(
    typeof output.stderr === 'string' && output.stderr
      ? output.stderr
      : error || result?.error || '',
  );
  const exitCode = output.exit_code;

  const handleCopy = async () => {
    await navigator.clipboard.writeText([
      `$ ${sanitizeTerminalText(command)}`,
      stdout,
      stderr ? `# stderr\n${stderr}` : '',
    ].filter(Boolean).join('\n'));
  };

  return (
    <div className="ssh-test-terminal">
      <div className="ssh-test-terminal-meta">
        <span>exit {exitCode ?? (result?.ok ? 0 : '-')}</span>
        <span>{result?.duration_ms ?? '-'}ms</span>
        <button type="button" onClick={handleCopy}>출력 복사</button>
      </div>
      <div className="ssh-test-terminal-screen">
        <div className="ssh-test-terminal-prompt">$ {sanitizeTerminalText(command)}</div>
        {stdout && <pre>{stdout}</pre>}
        {stderr && <pre className="stderr">{stderr}</pre>}
        {!stdout && !stderr && <div className="ssh-test-terminal-empty">출력 없음</div>}
      </div>
    </div>
  );
}

function getPluginConfigDefaults(plugin?: PluginManifest): Partial<CustomNodeData> {
  if (!plugin) return {};
  const defaults: Record<string, unknown> = {};
  Object.entries(plugin.config_schema.properties || {}).forEach(([key, property]) => {
    if (property.default !== undefined) {
      defaults[key] = property.default;
    }
  });
  return defaults as Partial<CustomNodeData>;
}

function PathSuggestionList({
  suggestions,
  emptyText,
  actionLabel,
  onSelect,
}: {
  suggestions: NodePathSuggestion[];
  emptyText: string;
  actionLabel: string;
  onSelect: (path: string) => void;
}) {
  return (
    <div className="path-suggestion-panel">
      <div className="path-suggestion-title">이전 노드 output path</div>
      {suggestions.length === 0 ? (
        <div className="path-suggestion-empty">{emptyText}</div>
      ) : (
        <div className="path-suggestion-list">
          {suggestions.map((suggestion) => (
            <button
              type="button"
              className="path-suggestion-item"
              key={`${suggestion.sourceNodeId}:${suggestion.path}`}
              onClick={() => onSelect(suggestion.path)}
              title={`${suggestion.sourceNodeLabel}: ${suggestion.path}`}
            >
              <span className="path-suggestion-label">{suggestion.label}</span>
              <code>{suggestion.path}</code>
              <span className="path-suggestion-action">{actionLabel}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function JsonTreeView({
  value,
  onPathClick,
}: {
  value: unknown;
  onPathClick: (path: string) => void;
}) {
  return (
    <div className="json-tree-view">
      <JsonTreeNode name="output" value={value} path="output" depth={0} onPathClick={onPathClick} />
    </div>
  );
}

function JsonTreeNode({
  name,
  value,
  path,
  depth,
  onPathClick,
}: {
  name: string;
  value: unknown;
  path: string;
  depth: number;
  onPathClick: (path: string) => void;
}) {
  const isObjectLike = value !== null && typeof value === 'object';
  const entries = isObjectLike
    ? Array.isArray(value)
      ? value.map((item, index) => [String(index), item] as const)
      : Object.entries(value as Record<string, unknown>)
    : [];
  const preview = formatJsonLeaf(value);

  return (
    <div className="json-tree-node">
      <button
        type="button"
        className={`json-tree-row${isObjectLike ? ' parent' : ' leaf'}`}
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => onPathClick(path)}
        title={`Copy JSON path: ${path}`}
      >
        <span className="json-tree-key">{name}</span>
        <span className="json-tree-path">{path}</span>
        {!isObjectLike && <span className="json-tree-value">{preview}</span>}
        {isObjectLike && <span className="json-tree-count">{entries.length} items</span>}
      </button>
      {entries.map(([key, child]) => (
        <JsonTreeNode
          key={`${path}.${key}`}
          name={key}
          value={child}
          path={appendJsonPath(path, key)}
          depth={depth + 1}
          onPathClick={onPathClick}
        />
      ))}
    </div>
  );
}

function appendJsonPath(path: string, key: string) {
  return /^\d+$/.test(key) ? `${path}[${key}]` : `${path}.${key}`;
}

function validateJsonText(value: string) {
  const text = value.trim();
  if (!text) {
    return null;
  }
  try {
    JSON.parse(text);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'JSON 형식이 올바르지 않습니다.';
  }
}

function formatJsonLeaf(value: unknown) {
  if (typeof value === 'string') {
    return JSON.stringify(value.length > 80 ? `${value.slice(0, 77)}...` : value);
  }
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
