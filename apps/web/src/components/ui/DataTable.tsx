import type { CSSProperties, TableHTMLAttributes } from 'react';
import './primitives.css';

export interface DataTableProps extends TableHTMLAttributes<HTMLTableElement> {
  /** 스크린리더가 표의 목적을 알 수 있도록 항상 지정한다. */
  'aria-label': string;
  minWidth?: number | string;
  containerClassName?: string;
}

/** 가로 overflow와 공통 표 타이포·focus 표시를 제공하는 native table 래퍼. */
export function DataTable({
  minWidth,
  containerClassName = '',
  className = '',
  style,
  ...rest
}: DataTableProps) {
  const tableStyle: CSSProperties = {
    ...style,
    ...(minWidth ? { minWidth: typeof minWidth === 'number' ? `${minWidth}px` : minWidth } : {}),
  };
  return (
    <div className={`pxm-data-table-scroll ${containerClassName}`.trim()}>
      <table className={`pxm-data-table ${className}`.trim()} style={tableStyle} {...rest} />
    </div>
  );
}
