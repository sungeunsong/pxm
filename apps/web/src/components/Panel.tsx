import React, { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import './Panel.css';

export interface PanelProps {
  title?: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  className?: string;
}

export const Panel: React.FC<PanelProps> = ({
  title,
  subtitle,
  actions,
  children,
  collapsible = false,
  defaultCollapsed = false,
  className = '',
}) => {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  const classNames = [
    'panel',
    collapsed && 'panel-collapsed',
    className,
  ].filter(Boolean).join(' ');

  return (
    <div className={classNames}>
      {(title || actions) && (
        <div className="panel-header">
          <div className="panel-header-content">
            {title && (
              <div className="panel-title-group">
                <h3 className="panel-title">{title}</h3>
                {subtitle && <p className="panel-subtitle">{subtitle}</p>}
              </div>
            )}
          </div>
          <div className="panel-actions">
            {actions}
            {collapsible && (
              <button
                className="panel-collapse-btn"
                onClick={() => setCollapsed(!collapsed)}
                aria-label={collapsed ? 'Expand' : 'Collapse'}
              >
                {collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
              </button>
            )}
          </div>
        </div>
      )}
      {!collapsed && (
        <div className="panel-body">
          {children}
        </div>
      )}
    </div>
  );
};
