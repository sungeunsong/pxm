import React, { useState } from 'react';
import type { Node } from 'reactflow';
import { Header } from '../components/Header';
import { FlowCanvas } from './FlowCanvas';
import type { CustomNodeData } from './CustomNode';
import './FlowDesigner.css';

export interface FlowDesignerProps {
  children?: React.ReactNode;
}

export const FlowDesigner: React.FC<FlowDesignerProps> = () => {
  const [darkMode, setDarkMode] = useState(true);
  const [selectedNode, setSelectedNode] = useState<Node<CustomNodeData> | null>(null);

  const handleRun = () => {
    console.log('Run workflow');
  };

  const handleSave = () => {
    console.log('Save workflow');
  };

  const handleSettings = () => {
    console.log('Open settings');
  };

  const handleToggleDarkMode = () => {
    setDarkMode(!darkMode);
  };

  const handleNodeSelect = (node: Node | null) => {
    setSelectedNode(node as Node<CustomNodeData> | null);
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
          <FlowCanvas onNodeSelect={handleNodeSelect} />
        </main>

        {/* Properties Panel */}
        <aside className="properties-panel">
          <div className="properties-header">
            <h3 className="properties-title">속성 패널</h3>
          </div>
          <div className="properties-content">
            {selectedNode ? (
              <div className="properties-form">
                <div className="property-group">
                  <label className="property-label">노드 ID</label>
                  <div className="property-value">{selectedNode.id}</div>
                </div>
                <div className="property-group">
                  <label className="property-label">노드 타입</label>
                  <div className="property-value">{selectedNode.data.nodeType}</div>
                </div>
                <div className="property-group">
                  <label className="property-label">레이블</label>
                  <div className="property-value">{selectedNode.data.label}</div>
                </div>
                {selectedNode.data.description && (
                  <div className="property-group">
                    <label className="property-label">설명</label>
                    <div className="property-value">{selectedNode.data.description}</div>
                  </div>
                )}
                <div className="property-group">
                  <label className="property-label">위치</label>
                  <div className="property-value">
                    X: {Math.round(selectedNode.position.x)}, Y: {Math.round(selectedNode.position.y)}
                  </div>
                </div>
              </div>
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
    </div>
  );
};
