import React from 'react';
import type { Node } from 'reactflow';
import { Input, Select, Checkbox } from '../components';
import type { CustomNodeData, FormSchema } from './form-types';
import { FormSchemaEditor } from './FormSchemaEditor';
import './NodePropertiesForm.css';

export interface NodePropertiesFormProps {
  node: Node<CustomNodeData>;
  onUpdate: (nodeId: string, data: Partial<CustomNodeData>) => void;
}

export const NodePropertiesForm: React.FC<NodePropertiesFormProps> = ({ node, onUpdate }) => {
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
    return (
      <>
        <div className="property-section">
          <h4 className="property-section-title">플러그인 선택</h4>
          <Select
            label="Connector Type"
            value={pluginId}
            onChange={(e) => onUpdate(node.id, { ...data, plugin_id: e.target.value })}
            options={[
              { value: 'builtin.http_request', label: 'HTTP Request (Built-in)' },
              { value: 'connector.slack', label: 'Slack Alerter (Mock)' },
              { value: 'connector.acra', label: 'ACRA Security Assessor (Mock)' },
              { value: 'connector.nit', label: 'NIT VM Provisioner (Mock)' },
            ]}
            fullWidth
          />
        </div>

        {pluginId === 'builtin.http_request' && (
          <div className="property-section">
            <h4 className="property-section-title">HTTP 설정</h4>
            <Input
              label="URL"
              placeholder="https://api.example.com/endpoint"
              value={data.url || ''}
              onChange={(e) => onUpdate(node.id, { ...data, url: e.target.value })}
              fullWidth
            />
            <Select
              label="HTTP Method"
              value={data.method || 'GET'}
              onChange={(e) => onUpdate(node.id, { ...data, method: e.target.value })}
              options={[
                { value: 'GET', label: 'GET' },
                { value: 'POST', label: 'POST' },
                { value: 'PUT', label: 'PUT' },
                { value: 'PATCH', label: 'PATCH' },
                { value: 'DELETE', label: 'DELETE' },
              ]}
              fullWidth
            />
            <Input
              label="Headers (JSON)"
              placeholder='{"Content-Type": "application/json"}'
              value={data.headers || ''}
              onChange={(e) => onUpdate(node.id, { ...data, headers: e.target.value })}
              fullWidth
            />
          </div>
        )}

        {pluginId === 'connector.slack' && (
          <div className="property-section">
            <h4 className="property-section-title">Slack Alerter 설정</h4>
            <Input
              label="Message"
              placeholder="보낼 알림 메시지"
              value={data.message || ''}
              onChange={(e) => onUpdate(node.id, { ...data, message: e.target.value })}
              fullWidth
            />
          </div>
        )}

        {pluginId === 'connector.acra' && (
          <div className="property-section">
            <h4 className="property-section-title">ACRA Assessor 설정</h4>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', padding: '10px', background: 'rgba(255,255,255,0.03)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
              🛡️ ACRA 보안 등급 검수 및 취약점 검증을 수행합니다. (자동 Mock 승인)
            </div>
          </div>
        )}

        {pluginId === 'connector.nit' && (
          <div className="property-section">
            <h4 className="property-section-title">NIT Provisioner 설정</h4>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', padding: '10px', background: 'rgba(255,255,255,0.03)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
              💻 사내 IT 클라우드에 신규 가상 환경 및 리소스를 생성합니다. (자동 Mock 할당)
            </div>
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
    return (
      <div className="property-section">
        <h4 className="property-section-title">게이트웨이 설정</h4>
        <Select
          label="Gateway Type"
          value={data.gatewayType || 'exclusive'}
          onChange={(e) => onUpdate(node.id, { ...data, gatewayType: e.target.value })}
          options={[
            { value: 'exclusive', label: 'Exclusive (XOR)' },
            { value: 'parallel', label: 'Parallel (AND)' },
            { value: 'inclusive', label: 'Inclusive (OR)' },
          ]}
          fullWidth
        />
        <Input
          label="Condition Expression"
          placeholder="status === 'approved'"
          value={data.condition || ''}
          onChange={(e) => onUpdate(node.id, { ...data, condition: e.target.value })}
          helperText="JavaScript 표현식"
          fullWidth
        />
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
      {node.data.nodeType === 'timer' && renderTimerProperties()}
      {node.data.nodeType === 'gateway' && renderGatewayProperties()}
      {node.data.nodeType === 'approval' && renderApprovalProperties()}

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
