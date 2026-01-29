import React, { useState, useRef } from 'react';
import type { Node } from 'reactflow';
import { Header } from '../components/Header';
import { FlowCanvas } from './FlowCanvas';
import type { FlowCanvasRef } from './FlowCanvas';
import type { CustomNodeData, FormSchema } from './form-types';
import { NodePropertiesForm } from './NodePropertiesForm';
import { TemplateListModal } from './TemplateListModal';
import { ExecutionModal } from './ExecutionModal';
import { templatesApi } from '../api/templates';
import type { WorkflowTemplate } from '../api/templates';
import './FlowDesigner.css';

export interface FlowDesignerProps {
  children?: React.ReactNode;
}

export const FlowDesigner: React.FC<FlowDesignerProps> = () => {
  const [darkMode, setDarkMode] = useState(true);
  const [selectedNode, setSelectedNode] = useState<Node<CustomNodeData> | null>(null);
  const [currentTemplateId, setCurrentTemplateId] = useState<string | null>(null);
  const [currentTemplateName, setCurrentTemplateName] = useState<string>('');
  const [isTemplateModalOpen, setIsTemplateModalOpen] = useState(false);
  const [isExecutionModalOpen, setIsExecutionModalOpen] = useState(false);
  const [executionInstanceId, setExecutionInstanceId] = useState<string | null>(null);
  const [executionFormSchema, setExecutionFormSchema] = useState<FormSchema | undefined>(undefined);
  const flowCanvasRef = useRef<FlowCanvasRef>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // SSE 연결 정리
  React.useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  const handleRun = async (formData?: Record<string, any>) => {
    if (!currentTemplateId) {
      alert('먼저 템플릿을 저장하거나 불러와주세요.');
      return;
    }

    // formData가 없으면 Start 노드에 폼이 있는지 확인
    if (!formData) {
      const nodes = flowCanvasRef.current?.getNodes() || [];
      console.log('[DEBUG] All nodes:', nodes);
      
      const startNode = nodes.find(n => n.data.nodeType === 'start');
      console.log('[DEBUG] Start node:', startNode);
      console.log('[DEBUG] formSchema:', startNode?.data.formSchema);
      
      if (startNode?.data.formSchema && startNode.data.formSchema.fields.length > 0) {
        console.log('[DEBUG] Opening form modal with fields:', startNode.data.formSchema.fields);
        // 폼이 있으면 실행 모달을 열어서 폼을 먼저 표시
        // formSchema를 깊은 복사하여 저장 (circular reference 방지)
        setExecutionFormSchema(JSON.parse(JSON.stringify(startNode.data.formSchema)));
        setExecutionInstanceId(null); // 아직 실행 전
        setIsExecutionModalOpen(true);
        return;
      } else {
        console.log('[DEBUG] No form fields found, executing directly');
      }
    }

    try {
      // formData 정리 (circular reference 제거)
      let cleanFormData: Record<string, any> | undefined = undefined;
      if (formData) {
        console.log('[FlowDesigner] Original formData:', formData);
        cleanFormData = {};
        Object.keys(formData).forEach(key => {
          const value = formData[key];
          // 기본 타입만 복사
          if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
            cleanFormData![key] = value;
          } else if (Array.isArray(value)) {
            // 배열은 기본 타입만 포함된 경우 복사
            cleanFormData![key] = value.filter(v => 
              typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null
            );
          } else {
            console.warn(`[FlowDesigner] Skipping non-primitive value for key ${key}:`, typeof value);
          }
        });
        console.log('[FlowDesigner] Clean formData:', cleanFormData);
      }
      
      const result = await templatesApi.execute(currentTemplateId, cleanFormData);
      
      // 실행 모달 열기 (또는 업데이트)
      setExecutionInstanceId(result.instance_id);
      if (!isExecutionModalOpen) {
        setIsExecutionModalOpen(true);
      }
      
      // SSE 연결하여 캔버스 노드 상태 업데이트
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      const eventSource = new EventSource(`http://localhost:3000/instances/${result.instance_id}/stream`);
      eventSourceRef.current = eventSource;

      // 공통 이벤트 핸들러
      const handleEvent = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          console.log('SSE Event (Canvas):', data);

          // 노드 상태 업데이트
          if (data.event_type === 'NODE_STARTED' && data.payload?.node_id) {
            updateNodeExecutionStatus(data.payload.node_id, 'running');
          } else if (data.event_type === 'NODE_COMPLETED' && data.payload?.node_id) {
            updateNodeExecutionStatus(data.payload.node_id, 'completed');
          } else if (data.event_type === 'NODE_FAILED' && data.payload?.node_id) {
            updateNodeExecutionStatus(data.payload.node_id, 'failed');
          }

          // 완료 시 연결 종료
          if (data.event_type === 'INSTANCE_COMPLETED' || data.event_type === 'INSTANCE_FAILED') {
            setTimeout(() => {
              eventSource.close();
            }, 1000);
          }
        } catch (err) {
          console.error('Failed to parse SSE event:', err);
        }
      };

      // 모든 이벤트 타입에 대해 리스너 등록
      const eventTypes = [
        'INSTANCE_CREATED',
        'INSTANCE_RUNNING',
        'INSTANCE_WAITING',
        'INSTANCE_COMPLETED',
        'INSTANCE_FAILED',
        'NODE_STARTED',
        'NODE_COMPLETED',
        'NODE_FAILED',
        'TIMER_SCHEDULED',
        'TIMER_ESCALATED',
        'RETRY_SCHEDULED',
        'APPROVAL_REQUIRED',
      ];

      eventTypes.forEach((eventType) => {
        eventSource.addEventListener(eventType, handleEvent);
      });

      // 기본 message 이벤트도 처리
      eventSource.onmessage = handleEvent;

      eventSource.onerror = (err) => {
        console.error('SSE Error:', err);
        eventSource.close();
      };
      
      console.log('Workflow execution started:', result);
    } catch (error) {
      console.error('Failed to execute workflow:', error);
      alert('워크플로우 실행에 실패했습니다.');
    }
  };

  const updateNodeExecutionStatus = (nodeId: string, status: 'pending' | 'running' | 'completed' | 'failed') => {
    flowCanvasRef.current?.updateNodeData(nodeId, { executionStatus: status });
  };

  const handleSave = async () => {
    const nodes = flowCanvasRef.current?.getNodes() || [];
    const edges = flowCanvasRef.current?.getEdges() || [];

    const templateName = prompt('템플릿 이름을 입력하세요:', currentTemplateName || 'New Workflow');
    if (!templateName) return;

    try {
      if (currentTemplateId) {
        // 기존 템플릿 업데이트
        const updated = await templatesApi.update(currentTemplateId, {
          name: templateName,
          nodes,
          edges,
        });
        setCurrentTemplateName(updated.name);
        alert(`템플릿이 업데이트되었습니다: ${updated.name} (v${updated.version})`);
      } else {
        // 새 템플릿 생성
        const created = await templatesApi.create({
          name: templateName,
          description: '워크플로우 템플릿',
          nodes,
          edges,
        });
        setCurrentTemplateId(created.id);
        setCurrentTemplateName(created.name);
        alert(`템플릿이 저장되었습니다: ${created.name}`);
      }
    } catch (error) {
      console.error('Failed to save template:', error);
      alert('템플릿 저장에 실패했습니다.');
    }
  };

  const handleLoad = () => {
    setIsTemplateModalOpen(true);
  };

  const handleTemplateSelect = (template: WorkflowTemplate) => {
    // 템플릿의 노드와 엣지를 캔버스에 적용
    flowCanvasRef.current?.setNodesAndEdges(template.nodes, template.edges);
    setCurrentTemplateId(template.id);
    setCurrentTemplateName(template.name);
    alert(`템플릿 "${template.name}"을 불러왔습니다.`);
  };

  const handleSettings = () => {
    console.log('Open settings');
    // TODO: 설정 모달 열기
  };

  const handleToggleDarkMode = () => {
    setDarkMode(!darkMode);
  };

  const handleNodeSelect = (node: Node | null) => {
    setSelectedNode(node as Node<CustomNodeData> | null);
  };

  // 노드 업데이트 핸들러
  const handleNodeUpdate = (nodeId: string, data: Partial<CustomNodeData>) => {
    flowCanvasRef.current?.updateNodeData(nodeId, data);
  };

  // 드래그 시작 핸들러
  const onDragStart = (event: React.DragEvent, nodeType: string, label: string) => {
    const nodeData: CustomNodeData = {
      label,
      nodeType: nodeType as CustomNodeData['nodeType'],
      description: `${label} 노드`,
    };
    event.dataTransfer.setData('application/reactflow', JSON.stringify(nodeData));
    event.dataTransfer.effectAllowed = 'move';
  };

  return (
    <div className="flow-designer">
      <Header
        title="PXM Flow Designer"
        onRun={() => handleRun()}
        onSave={handleSave}
        onLoad={handleLoad}
        onSettings={handleSettings}
        darkMode={darkMode}
        onToggleDarkMode={handleToggleDarkMode}
      />

      <div className="flow-designer-content">
        {/* Node Palette */}
        <aside className="node-palette">
          <div className="palette-header">
            <h3 className="palette-title">노드 팔레트</h3>
          </div>
          <div className="palette-content">
            <div className="palette-section">
              <h4 className="palette-section-title">기본 노드</h4>
              <div className="palette-nodes">
                <div
                  className="palette-node"
                  draggable
                  onDragStart={(e) => onDragStart(e, 'start', 'Start')}
                >
                  <div className="palette-node-icon" style={{ background: 'var(--node-start)' }}>
                    <span>▶</span>
                  </div>
                  <span className="palette-node-label">Start</span>
                </div>
                <div
                  className="palette-node"
                  draggable
                  onDragStart={(e) => onDragStart(e, 'service', 'Service')}
                >
                  <div className="palette-node-icon" style={{ background: 'var(--node-service)' }}>
                    <span>⚙</span>
                  </div>
                  <span className="palette-node-label">Service</span>
                </div>
                <div
                  className="palette-node"
                  draggable
                  onDragStart={(e) => onDragStart(e, 'timer', 'Timer')}
                >
                  <div className="palette-node-icon" style={{ background: 'var(--node-timer)' }}>
                    <span>⏱</span>
                  </div>
                  <span className="palette-node-label">Timer</span>
                </div>
                <div
                  className="palette-node"
                  draggable
                  onDragStart={(e) => onDragStart(e, 'gateway', 'Gateway')}
                >
                  <div className="palette-node-icon" style={{ background: 'var(--node-gateway)' }}>
                    <span>◆</span>
                  </div>
                  <span className="palette-node-label">Gateway</span>
                </div>
                <div
                  className="palette-node"
                  draggable
                  onDragStart={(e) => onDragStart(e, 'approval', 'Approval')}
                >
                  <div className="palette-node-icon" style={{ background: 'var(--node-approval)' }}>
                    <span>✓</span>
                  </div>
                  <span className="palette-node-label">Approval</span>
                </div>
                <div
                  className="palette-node"
                  draggable
                  onDragStart={(e) => onDragStart(e, 'end', 'End')}
                >
                  <div className="palette-node-icon" style={{ background: 'var(--node-end)' }}>
                    <span>■</span>
                  </div>
                  <span className="palette-node-label">End</span>
                </div>
              </div>
            </div>
          </div>
        </aside>

        {/* Canvas */}
        <main className="canvas">
          <FlowCanvas ref={flowCanvasRef} onNodeSelect={handleNodeSelect} />
        </main>

        {/* Properties Panel */}
        <aside className="properties-panel">
          <div className="properties-header">
            <h3 className="properties-title">속성 패널</h3>
          </div>
          <div className="properties-content">
            {selectedNode ? (
              <NodePropertiesForm
                node={selectedNode}
                onUpdate={handleNodeUpdate}
              />
            ) : (
              <div className="properties-placeholder">
                <p className="text-secondary">
                  노드를 선택하면 속성이 표시됩니다
                </p>
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* 템플릿 목록 모달 */}
      <TemplateListModal
        isOpen={isTemplateModalOpen}
        onClose={() => setIsTemplateModalOpen(false)}
        onSelect={handleTemplateSelect}
      />

      {/* 실행 상태 모달 */}
      <ExecutionModal
        isOpen={isExecutionModalOpen}
        instanceId={executionInstanceId}
        templateName={currentTemplateName}
        formSchema={executionFormSchema}
        onFormSubmit={(formData) => {
          handleRun(formData);
        }}
        onClose={() => setIsExecutionModalOpen(false)}
      />
    </div>
  );
};
