import type { HTMLAttributes, ReactNode } from 'react';
import './primitives.css';

export type StatusBadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent';

export interface StatusBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  status: string;
  label?: ReactNode;
  icon?: ReactNode;
  tone?: StatusBadgeTone;
}

const TONE_BY_STATUS: Record<string, StatusBadgeTone> = {
  ACTIVE: 'success', COMPLETED: 'success', SENT: 'success', APPROVED: 'success', HEALTHY: 'success',
  RUNNING: 'info', CREATED: 'info',
  WAITING: 'warning', PENDING: 'warning', OPEN: 'warning', DISABLED: 'warning', WARNING: 'warning',
  FAILED: 'danger', REJECTED: 'danger', DELETED: 'danger', EXPIRED: 'danger', DEAD_LETTER: 'danger', TERMINATED: 'danger',
  PAUSED: 'accent',
};

function statusBadgeTone(status: string): StatusBadgeTone {
  return TONE_BY_STATUS[status.toUpperCase()] ?? 'neutral';
}

/** 상태 색은 의미를 보조할 뿐이며, label 텍스트를 항상 함께 렌더링한다. */
export function StatusBadge({ status, label, icon, tone, className = '', ...rest }: StatusBadgeProps) {
  const resolvedTone = tone ?? statusBadgeTone(status);
  return (
    <span className={`pxm-status-badge tone-${resolvedTone} ${className}`.trim()} data-status={status} {...rest}>
      {icon && <span className="pxm-status-badge-icon" aria-hidden="true">{icon}</span>}
      <span>{label ?? status}</span>
    </span>
  );
}
