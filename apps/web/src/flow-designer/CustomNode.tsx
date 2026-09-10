import React from 'react';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';
import { Loader, CheckCircle, XCircle, Clock } from 'lucide-react';
import type { CustomNodeData } from './form-types';
import { nodeTypeIcon } from './plugin-icons';
import { nodeSummaryLine, nodeSummaryTitle } from './node-summary';
import './CustomNode.css';
import './NodeAnimations.css';
import './design-system-custom.css';

export const CustomNode: React.FC<NodeProps<CustomNodeData>> = ({ data, selected }) => {
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

  const summaryLine = nodeSummaryLine(data);
  const isGateway = data.nodeType === 'gateway';
  const isApproval = data.nodeType === 'approval';

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
          {nodeTypeIcon(data.nodeType, data.icon)}
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
          {summaryLine && (
            <div className="custom-node-description" title={nodeSummaryTitle(data)}>
              {summaryLine}
            </div>
          )}
        </div>
      </div>

      {isGateway ? (
        <>
          <Handle
            type="source"
            position={Position.Right}
            id="true"
            className="custom-handle custom-handle-true"
            style={{ top: '30%' }}
          />
          <Handle
            type="source"
            position={Position.Right}
            id="false"
            className="custom-handle custom-handle-false"
            style={{ top: '70%' }}
          />
        </>
      ) : isApproval ? (
        <>
          <Handle
            type="source"
            position={Position.Right}
            id="approved"
            className="custom-handle custom-handle-true"
            style={{ top: '30%' }}
          />
          <Handle
            type="source"
            position={Position.Right}
            id="rejected"
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
