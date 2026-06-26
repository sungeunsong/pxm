import React from 'react';
import type { Node } from 'reactflow';
import type { Edge } from 'reactflow';
import { Button, Input, Select, Checkbox } from '../components';
import type { CustomNodeData, FormSchema } from './form-types';
import type { PluginManifest, PluginJsonSchemaProperty, PluginTestResponse } from '../api/plugins';
import { credentialsApi, type CredentialProfile } from '../api/credentials';
import { FormSchemaEditor } from './FormSchemaEditor';
import { PluginIcon } from './plugin-icons';
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
}) => {
  const scriptTextareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const [credentials, setCredentials] = React.useState<CredentialProfile[]>([]);
  const [credentialsLoading, setCredentialsLoading] = React.useState(false);
  const [credentialsError, setCredentialsError] = React.useState<string | null>(null);
  const [workflowOptions, setWorkflowOptions] = React.useState<WorkflowOption[]>([]);
  const [workflowOptionsLoading, setWorkflowOptionsLoading] = React.useState(false);
  const [workflowOptionsError, setWorkflowOptionsError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setCredentialsLoading(true);
    credentialsApi
      .list(true)
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
  }, []);

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
    const textarea = scriptTextareaRef.current;
    const start = textarea?.selectionStart ?? code.length;
    const end = textarea?.selectionEnd ?? code.length;
    const nextCode = `${code.slice(0, start)}${reference}${code.slice(end)}`;

    onUpdate(node.id, {
      ...data,
      scriptType: 'javascript',
      code: nextCode,
    });

    requestAnimationFrame(() => {
      textarea?.focus();
      const cursor = start + reference.length;
      textarea?.setSelectionRange(cursor, cursor);
    });
  };

  // Service 노드 속성
  const renderServiceProperties = () => {
    const data = node.data as any;
    const pluginId = data.plugin_id || 'builtin.http_request';
    const selectedPlugin = findPluginManifest(plugins, pluginId);
    const credentialPolicy = getCredentialPolicy(selectedPlugin);
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
              disabled={!onTestRun || testRunning}
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
              <JsonTreeView
                value={getTestResultValue(testResult, testError)}
                onPathClick={handleCopyPath}
              />
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
            options={buildCredentialOptions(compatibleCredentials, credentialPolicy)}
            helperText={
              credentialsError ||
              (credentialsLoading
                ? 'Credential 목록을 불러오는 중입니다.'
                : credentialPolicy.helperText)
            }
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
            helperText="테스트/실행 결과를 저장할 context path입니다. 예: httpResults.userLookup"
            fullWidth
          />
          <Input
            label="Timeout (ms)"
            type="number"
            placeholder="5000"
            value={data.timeout || ''}
            onChange={(e) => onUpdate(node.id, { ...data, timeout: e.target.value })}
            fullWidth
          />
          <Input
            label="Retry Count"
            type="number"
            placeholder="3"
            value={data.retryCount || ''}
            onChange={(e) => onUpdate(node.id, { ...data, retryCount: e.target.value })}
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
          <textarea
            ref={scriptTextareaRef}
            className="property-textarea code-textarea"
            value={data.code || ''}
            onChange={(e) =>
              onUpdate(node.id, {
                ...data,
                scriptType: 'javascript',
                code: e.target.value,
              })
            }
            placeholder="return { total: input.formData.price * input.formData.quantity };"
            spellCheck={false}
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
              })
            }
            options={[
              { value: 'manual', label: 'Manual / API' },
              { value: 'schedule', label: 'Schedule' },
            ]}
            helperText="Schedule을 선택하면 템플릿 저장 시 scheduler job이 생성됩니다."
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
    return (
      <div className="property-section">
        <h4 className="property-section-title">승인 설정</h4>
        <Input
          label="Approver (Email)"
          placeholder="user@example.com"
          value={data.assignee || ''}
          onChange={(e) => onUpdate(node.id, { ...data, assignee: e.target.value })}
          fullWidth
        />
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
          helperText={workflowOptionsError || (selectedWorkflow ? selectedWorkflow.id : 'async 방식으로 자식 instance를 생성합니다. 자식 완료까지 기다리지는 않습니다.')}
          fullWidth
        />
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
                        : '예: amount > 1000, status == approved'
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

type CredentialPolicy = {
  mode: 'none' | 'mongodb_connection' | 'http_auth';
  title: string;
  helperText: string;
  handledFields: string[];
  allowedTypes: CredentialProfile['type'][];
  preferredScopes: string[];
};

function buildCredentialOptions(credentials: CredentialProfile[], policy: CredentialPolicy) {
  if (policy.mode === 'none') {
    return [{ value: '', label: '이 노드는 credential을 사용하지 않음' }];
  }

  return [
    { value: '', label: 'Credential 미사용' },
    ...credentials.map((credential) => ({
      value: credential.id,
      label: `${credential.name} (${credential.type})`,
    })),
  ];
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

  return {
    mode: 'none',
    title: 'Credential',
    helperText: '현재 선택한 플러그인은 credential binding 규칙이 없습니다.',
    handledFields: [],
    allowedTypes: [],
    preferredScopes: [],
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
          />
          {helperText && <div className="property-helper-text">{helperText}</div>}
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

function getTestResultValue(result?: PluginTestResponse | null, error?: string | null) {
  if (error && !result?.output) {
    return { error };
  }
  return result?.output ?? { error };
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
