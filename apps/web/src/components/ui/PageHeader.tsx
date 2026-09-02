import type { HTMLAttributes, ReactNode } from 'react';
import './primitives.css';

export interface PageHeaderProps extends HTMLAttributes<HTMLElement> {
  title?: string;
  description: ReactNode;
  eyebrow?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
}

/**
 * 화면 설명과 주 작업을 묶는 페이지 상단 영역.
 * 앱 셸이 이미 화면 제목을 제공하는 경우 title을 생략해 제목 중복을 피한다.
 */
export function PageHeader({
  title,
  description,
  eyebrow,
  icon,
  actions,
  className = '',
  ...rest
}: PageHeaderProps) {
  return (
    <section className={`pxm-page-header ${className}`.trim()} {...rest}>
      {icon && <span className="pxm-page-header-icon" aria-hidden="true">{icon}</span>}
      <div className="pxm-page-header-copy">
        {eyebrow && <span className="pxm-page-header-eyebrow">{eyebrow}</span>}
        {title && <h2>{title}</h2>}
        <p>{description}</p>
      </div>
      {actions && <div className="pxm-page-header-actions">{actions}</div>}
    </section>
  );
}
