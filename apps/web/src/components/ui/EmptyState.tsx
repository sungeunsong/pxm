import type { HTMLAttributes, ReactNode } from 'react';
import { AlertTriangle, Inbox, LoaderCircle } from 'lucide-react';
import './primitives.css';

export type EmptyStateKind = 'empty' | 'loading' | 'error';

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  kind?: EmptyStateKind;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}

const DEFAULT_ICON: Record<EmptyStateKind, ReactNode> = {
  empty: <Inbox size={24} />,
  loading: <LoaderCircle size={24} />,
  error: <AlertTriangle size={24} />,
};

/** 빈 결과, 로딩, 오류를 같은 시각·접근성 규칙으로 표현한다. */
export function EmptyState({
  kind = 'empty',
  title,
  description,
  icon,
  action,
  compact = false,
  className = '',
  role,
  ...rest
}: EmptyStateProps) {
  return (
    <div
      className={`pxm-empty-state kind-${kind}${compact ? ' compact' : ''} ${className}`.trim()}
      role={role ?? (kind === 'error' ? 'alert' : 'status')}
      aria-live={kind === 'loading' ? 'polite' : undefined}
      {...rest}
    >
      <span className={`pxm-empty-state-icon${kind === 'loading' ? ' spinning' : ''}`} aria-hidden="true">
        {icon ?? DEFAULT_ICON[kind]}
      </span>
      <strong>{title}</strong>
      {description && <span>{description}</span>}
      {action && <div className="pxm-empty-state-action">{action}</div>}
    </div>
  );
}
