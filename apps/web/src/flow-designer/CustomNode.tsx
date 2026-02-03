import React from 'react';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';
import { Loader, CheckCircle, XCircle, Clock } from 'lucide-react';
import type { CustomNodeData } from './form-types';
import './CustomNode.css';
import './NodeAnimations.css';

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

  const getExecutionStatusIcon = (status?: string) => {
    switch (status) {
      case 'running':
        return <Loader size={14} className="execution-status-icon running" />;
      case 'completed':
        return <CheckCircle size={14} className="execution-status-icon completed" />;
      case 'failed':
        return <XCircle size={14} className="execution-status-icon failed" />;
      case 'pending':
        return <Clock size={14} className="execution-status-icon pending" />;
      default:
        return null;
    }
  };

  const isGateway = data.nodeType === 'gateway';

  return (
    <div 
      className={`custom-node custom-node-${data.nodeType} ${selected ? 'selected' : ''} ${data.executionStatus ? `execution-${data.executionStatus}` : ''}`}
      style={{ position: 'relative' }}
    >
      {data.executionStatus && data.executionStatus !== 'pending' && (
        <div className={`status-ring status-${data.executionStatus}`} />
      )}

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
          <div className="custom-node-label">
            {data.label}
            {data.executionStatus && (
              <span className="execution-status-badge">
                {getExecutionStatusIcon(data.executionStatus)}
              </span>
            )}
          </div>
          {data.description && (
            <div className="custom-node-description">{data.description}</div>
          )}
        </div>
      </div>

      {isGateway ? (
        <>
          <div className="gateway-handle-label true-label">True</div>
          <Handle
            type="source"
            position={Position.Right}
            id="true"
            className="custom-handle custom-handle-true"
            style={{ top: '30%' }}
          />
          <div className="gateway-handle-label false-label">False</div>
          <Handle
            type="source"
            position={Position.Right}
            id="false"
            className="custom-handle custom-handle-false"
            style={{ top: '70%' }}
          />
        </>
      ) : (
        data.nodeType !== 'end' && (
          <Handle
            type="source"
            position={Position.Right}
            className="custom-handle"
          />
        )
      )}
    </div>
  );
};
