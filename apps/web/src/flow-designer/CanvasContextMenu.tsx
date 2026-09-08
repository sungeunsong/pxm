import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './CanvasContextMenu.css';

export interface CanvasContextMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  disabled?: boolean;
  tone?: 'default' | 'danger';
  separatorBefore?: boolean;
  onSelect: () => void | Promise<void>;
}

interface CanvasContextMenuProps {
  title?: string;
  anchor: { x: number; y: number };
  boundary: { left: number; top: number; right: number; bottom: number };
  items: CanvasContextMenuItem[];
  onClose: () => void;
}

export function CanvasContextMenu({ title, anchor, boundary, items, onClose }: CanvasContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(anchor);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const box = menu.getBoundingClientRect();
    setPosition({
      x: Math.max(boundary.left + 8, Math.min(anchor.x, boundary.right - box.width - 8)),
      y: Math.max(boundary.top + 8, Math.min(anchor.y, boundary.bottom - box.height - 8)),
    });
    const firstEnabled = menu.querySelector<HTMLButtonElement>('button:not(:disabled)');
    firstEnabled?.focus({ preventScroll: true });
  }, [anchor, boundary.bottom, boundary.left, boundary.right, boundary.top, title]);

  useEffect(() => {
    const closeFromOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const closeFromViewportChange = () => onClose();
    window.addEventListener('pointerdown', closeFromOutside);
    window.addEventListener('scroll', closeFromViewportChange, true);
    return () => {
      window.removeEventListener('pointerdown', closeFromOutside);
      window.removeEventListener('scroll', closeFromViewportChange, true);
    };
  }, [onClose]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [],
    );
    if (buttons.length === 0) return;
    const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : event.key === 'ArrowDown'
          ? (currentIndex + 1 + buttons.length) % buttons.length
          : (currentIndex - 1 + buttons.length) % buttons.length;
    buttons[nextIndex]?.focus();
  };

  return createPortal((
    <div
      ref={menuRef}
      className="canvas-context-menu"
      role="menu"
      aria-label={title || '캔버스 메뉴'}
      style={{ left: position.x, top: position.y }}
      onKeyDown={handleKeyDown}
      data-testid="canvas-context-menu"
    >
      {title && <div className="canvas-context-menu-title">{title}</div>}
      {items.map((item) => (
        <React.Fragment key={item.id}>
          {item.separatorBefore && <div className="canvas-context-menu-separator" role="separator" />}
          <button
            type="button"
            role="menuitem"
            className={item.tone === 'danger' ? 'danger' : undefined}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              void item.onSelect();
            }}
          >
            <span className="canvas-context-menu-icon" aria-hidden="true">{item.icon}</span>
            <span className="canvas-context-menu-label">{item.label}</span>
            {item.shortcut && <span className="canvas-context-menu-shortcut">{item.shortcut}</span>}
          </button>
        </React.Fragment>
      ))}
    </div>
  ), document.body);
}
