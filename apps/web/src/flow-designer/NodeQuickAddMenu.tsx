import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { createPortal } from 'react-dom';
import { nodeTypeIcon } from './plugin-icons';
import type { NodeCatalogItem } from './node-catalog';
import './NodeQuickAddMenu.css';

interface NodeQuickAddMenuProps {
  title: string;
  anchor: { x: number; y: number };
  boundary: { left: number; top: number; right: number; bottom: number };
  items: NodeCatalogItem[];
  onSelect: (item: NodeCatalogItem) => void;
  onClose: () => void;
}

export function NodeQuickAddMenu({ title, anchor, boundary, items, onSelect, onClose }: NodeQuickAddMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [position, setPosition] = useState(anchor);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const filteredItems = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized ? items.filter((item) => item.searchText.includes(normalized)) : items;
  }, [items, query]);
  const resolvedActiveIndex = filteredItems[activeIndex]?.available
    ? activeIndex
    : Math.max(0, filteredItems.findIndex((item) => item.available));

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const box = menu.getBoundingClientRect();
    setPosition({
      x: Math.max(boundary.left + 8, Math.min(anchor.x, boundary.right - box.width - 8)),
      y: Math.max(boundary.top + 8, Math.min(anchor.y, boundary.bottom - box.height - 8)),
    });
    inputRef.current?.focus({ preventScroll: true });
  }, [anchor, boundary.bottom, boundary.left, boundary.right, boundary.top]);

  useEffect(() => {
    const closeFromOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const closeFromViewportChange = (event: Event) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    window.addEventListener('pointerdown', closeFromOutside);
    window.addEventListener('scroll', closeFromViewportChange, true);
    return () => {
      window.removeEventListener('pointerdown', closeFromOutside);
      window.removeEventListener('scroll', closeFromViewportChange, true);
    };
  }, [onClose]);

  const move = (delta: number) => {
    const availableIndexes = filteredItems.flatMap((item, index) => item.available ? [index] : []);
    if (availableIndexes.length === 0) return;
    const current = Math.max(0, availableIndexes.indexOf(resolvedActiveIndex));
    const next = availableIndexes[(current + delta + availableIndexes.length) % availableIndexes.length];
    setActiveIndex(next);
    menuRef.current?.querySelector(`[data-node-option-index="${next}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = filteredItems[resolvedActiveIndex];
      if (item?.available) onSelect(item);
    }
  };

  return createPortal((
    <div
      ref={menuRef}
      className="node-quick-add"
      style={{ left: position.x, top: position.y }}
      onKeyDown={handleKeyDown}
      onWheel={(event) => event.stopPropagation()}
      data-testid="node-quick-add"
    >
      <div className="node-quick-add-title">{title}</div>
      <label className="node-quick-add-search">
        <Search size={15} aria-hidden="true" />
        <input
          ref={inputRef}
          role="combobox"
          aria-label="추가할 노드 검색"
          aria-controls="node-quick-add-results"
          aria-expanded="true"
          aria-activedescendant={filteredItems[resolvedActiveIndex] ? `node-option-${filteredItems[resolvedActiveIndex].id}` : undefined}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          placeholder="노드 이름, 유형, 플러그인 검색"
        />
        <kbd>Esc</kbd>
      </label>
      <div id="node-quick-add-results" className="node-quick-add-results" role="listbox">
        {filteredItems.map((item, index) => (
          <button
            key={item.id}
            id={`node-option-${item.id}`}
            type="button"
            role="option"
            aria-selected={index === resolvedActiveIndex}
            className={index === resolvedActiveIndex ? 'active' : undefined}
            disabled={!item.available}
            title={item.unavailableReason}
            data-node-option-index={index}
            onMouseMove={() => setActiveIndex(index)}
            onClick={() => onSelect(item)}
          >
            <span className={`node-quick-add-icon type-${item.data.nodeType}`} aria-hidden="true">
              {nodeTypeIcon(item.data.nodeType, item.data.icon)}
            </span>
            <span className="node-quick-add-copy">
              <strong>{item.name}</strong>
              <small>{item.sourceLabel} · {item.typeLabel}</small>
              {!item.available && <small className="unavailable">{item.unavailableReason}</small>}
            </span>
          </button>
        ))}
        {filteredItems.length === 0 && <div className="node-quick-add-empty">일치하는 노드가 없습니다.</div>}
      </div>
      <div className="node-quick-add-help">↑↓ 이동 · Enter 추가 · Esc 닫기</div>
    </div>
  ), document.body);
}
