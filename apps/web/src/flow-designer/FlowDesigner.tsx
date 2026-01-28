import React, { useState, useRef } from 'react';
import type { Node } from 'reactflow';
import { Header } from '../components/Header';
import { FlowCanvas } from './FlowCanvas';
import type { FlowCanvasRef } from './FlowCanvas';
import type { CustomNodeData } from './CustomNode';
import { NodePropertiesForm } from './NodePropertiesForm';
import { TemplateListModal } from './TemplateListModal';
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
  const [isTemplateModalOpen, setIsTemplateModalOpen] = useState(false);
  const flowCanvasRef = useRef<FlowCanvasRef>(null);

  const handleRun = () => {
    console.log('Run workflow');
    // TODO: 워크플로우 실행 API 호출
  };

  const handleSave = async () => {
    const nodes = flowCanvasRef.current?.getNodes() || [];
    const edges = flowCanvasRef.current?.getEdges() || [];

    const templateName = prompt('템플릿 이름을 입력하세요:', currentTemplateId ? undefined : 'New Workflow');
    if (!templateName) return;

    try {
      if (currentTemplateId) {
        // 기존 템플릿 업데이트
        const updated = await templatesApi.update(currentTemplateId, {
          name: templateName,
          nodes,
          edges,
        });
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
        onRun={handleRun}
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
    </div>
  );
};
