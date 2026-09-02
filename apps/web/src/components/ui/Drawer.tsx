import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import './primitives.css';
import { isTopModalLayer, popModalLayer, pushModalLayer } from '../../lib/modal-layer';

export interface DrawerProps {
  title: ReactNode;
  eyebrow?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  width?: 'sm' | 'md' | 'lg';
  className?: string;
  closeLabel?: string;
  closeOnBackdrop?: boolean;
}

/**
 * 우측 상세 패널. 열릴 때 닫기 버튼으로 이동하고, Tab을 내부에 고정하며,
 * Esc/배경 클릭으로 닫은 뒤 기존 포커스를 복원한다.
 */
export function Drawer({
  title,
  eyebrow,
  children,
  footer,
  onClose,
  width = 'md',
  className = '',
  closeLabel = '상세 패널 닫기',
  closeOnBackdrop = true,
}: DrawerProps) {
  const titleId = useId();
  const drawerRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const restoreFrameRef = useRef<number | null>(null);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (restoreFrameRef.current !== null) window.cancelAnimationFrame(restoreFrameRef.current);
    previousFocusRef.current ??= document.activeElement as HTMLElement | null;
    const drawer = drawerRef.current;
    drawer?.querySelector<HTMLElement>('[data-drawer-initial-focus]')?.focus();

    // 이 Drawer 위에 확인 다이얼로그가 열리면 그 쪽이 최상단이 된다.
    // 그때는 Esc/Tab을 넘겨야 Esc 한 번에 둘 다 닫히지 않는다.
    const layer = pushModalLayer('drawer');

    const handleKey = (event: KeyboardEvent) => {
      if (!isTopModalLayer(layer)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !drawer) return;
      const focusable = Array.from(drawer.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ));
      if (focusable.length === 0) {
        event.preventDefault();
        drawer.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!drawer.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('keydown', handleKey);
      popModalLayer(layer);
      restoreFrameRef.current = window.requestAnimationFrame(() => {
        previousFocusRef.current?.focus();
        previousFocusRef.current = null;
        restoreFrameRef.current = null;
      });
    };
  }, []);

  return (
    <div
      className="pxm-drawer-backdrop"
      onMouseDown={(event) => closeOnBackdrop && event.target === event.currentTarget && onClose()}
    >
      <aside
        ref={drawerRef}
        className={`pxm-drawer width-${width} ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="pxm-drawer-header">
          <div>
            {eyebrow && <span className="pxm-drawer-eyebrow">{eyebrow}</span>}
            <h3 id={titleId}>{title}</h3>
          </div>
          <button type="button" className="pxm-drawer-close" onClick={onClose} aria-label={closeLabel} data-drawer-initial-focus>
            <X size={18} />
          </button>
        </header>
        <div className="pxm-drawer-body">{children}</div>
        {footer && <footer className="pxm-drawer-footer">{footer}</footer>}
      </aside>
    </div>
  );
}
