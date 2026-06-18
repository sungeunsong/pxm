import React from 'react';
import type { Node } from 'reactflow';
import type { Edge } from 'reactflow';
import { Button, Input, Select, Checkbox } from '../components';
import type { CustomNodeData, FormSchema } from './form-types';
import type { PluginManifest, PluginJsonSchemaProperty, PluginTestResponse } from '../api/plugins';
import { FormSchemaEditor } from './FormSchemaEditor';
import { PluginIcon } from './plugin-icons';
import './NodePropertiesForm.css';

export interface NodePropertiesFormProps {
  node: Node<CustomNodeData>;
  onUpdate: (nodeId: string, data: Partial<CustomNodeData>) => void;
  plugins?: PluginManifest[];
  gatewayEdges?: Edge[];
  onGatewayEdgeUpdate?: (edgeId: string, data: Partial<Edge>) => void;
  onTestRun?: () => void;
  testRunning?: boolean;
  testResult?: PluginTestResponse | null;
  testError?: string | null;
}

export const NodePropertiesForm: React.FC<NodePropertiesFormProps> = ({
  node,
  onUpdate,
  plugins = [],
  gatewayEdges = [],
  onGatewayEdgeUpdate,
  onTestRun,
  testRunning = false,
  testResult,
  testError,
}) => {
  const handleLabelChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onUpdate(node.id, { label: e.target.value });
  };

  const handleDescriptionChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onUpdate(node.id, { description: e.target.value });
  };

  // Service 노드 속성
  const renderServiceProperties = () => {
    const data = node.data as any;
    const pluginId = data.plugin_id || 'builtin.http_request';
    const selectedPlugin = findPluginManifest(plugins, pluginId);
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
              <pre>{formatTestResult(testResult, testError)}</pre>
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
              onUpdate(node.id, {
                ...data,
                ...getPluginConfigDefaults(nextPlugin),
                label: nextPlugin?.display_name || data.label,
                description: nextPlugin?.description || data.description,
                icon: nextPlugin?.icon || data.icon,
                category: nextPlugin?.category || data.category,
                plugin_id: e.target.value,
                plugin_version: nextPlugin?.version || data.plugin_version,
                timeout: nextPlugin?.timeout_ms || data.timeout,
                retryCount: nextPlugin?.retry_policy?.max_attempts || data.retryCount,
              });
            }}
            options={buildPluginOptions(plugins)}
            fullWidth
          />
        </div>

        {selectedPlugin ? (
          <div className="property-section">
            <h4 className="property-section-title">플러그인 설정</h4>
            {renderPluginConfigFields(selectedPlugin, data, (nextData) => onUpdate(node.id, nextData))}
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
    return (
      <div className="property-section">
        <FormSchemaEditor
          schema={data.formSchema}
          onChange={(schema: FormSchema) => onUpdate(node.id, { ...data, formSchema: schema })}
        />
      </div>
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

function renderPluginConfigFields(
  plugin: PluginManifest,
  data: Record<string, any>,
  onUpdate: (data: Partial<CustomNodeData>) => void,
) {
  const required = new Set(plugin.config_schema.required || []);
  const entries = Object.entries(plugin.config_schema.properties || {});

  if (entries.length === 0) {
    return <div className="property-value-readonly">No configuration</div>;
  }

  return entries.map(([key, property]) => {
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

function formatTestResult(result?: PluginTestResponse | null, error?: string | null) {
  if (error && !result?.output) {
    return error;
  }
  return JSON.stringify(result?.output ?? { error }, null, 2);
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
