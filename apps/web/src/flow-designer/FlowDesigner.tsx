import React, { useState } from 'react';
import { Header } from '../components/Header';
import './FlowDesigner.css';

export interface FlowDesignerProps {
  children?: React.ReactNode;
}

export const FlowDesigner: React.FC<FlowDesignerProps> = ({ children }) => {
  const [darkMode, setDarkMode] = useState(true);

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
                <div className="palette-node" data-node-type="start">
                  <div className="palette-node-icon" style={{ background: 'var(--node-start)' }}>
                    <span>▶</span>
                  </div>
                  <span className="palette-node-label">Start</span>
                </div>
                <div className="palette-node" data-node-type="service">
                  <div className="palette-node-icon" style={{ background: 'var(--node-service)' }}>
                    <span>⚙</span>
                  </div>
                  <span className="palette-node-label">Service</span>
                </div>
                <div className="palette-node" data-node-type="timer">
                  <div className="palette-node-icon" style={{ background: 'var(--node-timer)' }}>
                    <span>⏱</span>
                  </div>
                  <span className="palette-node-label">Timer</span>
                </div>
                <div className="palette-node" data-node-type="gateway">
                  <div className="palette-node-icon" style={{ background: 'var(--node-gateway)' }}>
                    <span>◆</span>
                  </div>
                  <span className="palette-node-label">Gateway</span>
                </div>
                <div className="palette-node" data-node-type="approval">
                  <div className="palette-node-icon" style={{ background: 'var(--node-approval)' }}>
                    <span>✓</span>
                  </div>
                  <span className="palette-node-label">Approval</span>
                </div>
                <div className="palette-node" data-node-type="end">
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
          <div className="canvas-content">
            {children || (
              <div className="canvas-placeholder">
                <h2>워크플로우 캔버스</h2>
                <p className="text-secondary">
                  왼쪽 팔레트에서 노드를 드래그하여 워크플로우를 구성하세요
                </p>
              </div>
            )}
          </div>
        </main>

        {/* Properties Panel */}
        <aside className="properties-panel">
          <div className="properties-header">
            <h3 className="properties-title">속성 패널</h3>
          </div>
          <div className="properties-content">
            <div className="properties-placeholder">
              <p className="text-secondary">
                노드를 선택하면 속성이 표시됩니다
              </p>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
};
