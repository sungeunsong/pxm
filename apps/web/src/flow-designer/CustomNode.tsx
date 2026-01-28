import React from 'react';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';
import './CustomNode.css';

export interface CustomNodeData {
  label: string;
  nodeType: 'start' | 'service' | 'timer' | 'gateway' | 'approval' | 'end';
  description?: string;
}

export const CustomNode: React.FC<NodeProps<CustomNodeData>> = ({ data, selected }) => {
  const getNodeIcon = (type: string) => {
    switch (type) {
      case 'start': return '▶';
      case 'service': return '⚙';
      case 'timer': return '⏱';
      case 'gateway': return '◆';
      case 'approval': return '✓';
      case 'end': return '■';
      default: return '●';
    }
  };

  return (
    <div className={`custom-node custom-node-${data.nodeType} ${selected ? 'selected' : ''}`}>
      {data.nodeType !== 'start' && (
        <Handle
          type="target"
          position={Position.Left}
          className="custom-handle"
        />
      )}
      
      <div className="custom-node-content">
        <div className="custom-node-icon">
          {getNodeIcon(data.nodeType)}
        </div>
        <div className="custom-node-info">
          <div className="custom-node-label">{data.label}</div>
          {data.description && (
            <div className="custom-node-description">{data.description}</div>
          )}
        </div>
      </div>

      {data.nodeType !== 'end' && (
        <Handle
          type="source"
          position={Position.Right}
          className="custom-handle"
        />
      )}
    </div>
  );
};
