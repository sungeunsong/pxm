import React, { useEffect, useRef, useState } from 'react';
import { Clock, Download, FolderOpen, MoreHorizontal, Moon, Play, Save, Settings, Sun, Upload } from 'lucide-react';
import { Button } from './Button';
import './Header.css';

/**
 * Flow Designer 상단 바.
 *
 * 이전에는 로고 + "PXM Flow Designer" + "Build, test and operate workflows" 를 띄우고
 * Run/Save/Load/Import/Export/History/Settings/Theme 8개를 같은 크기로 나열했다.
 * 앱 헤더가 이미 화면 이름을 말하고 있으므로 여기서는
 * **지금 편집 중인 워크플로우**와 주 액션(저장·실행)만 보여주고 나머지는 ··· 로 넣는다.
 */

export interface HeaderProps {
  /** 편집 중인 워크플로우 이름. 비어 있으면 새 워크플로우로 표시한다. */
  workflowName?: string;
  /** 배포 v3 / 초안 같은 상태 문구 */
  statusLabel?: string;
  /** 저장되지 않은 변경이 있는지 */
  dirty?: boolean;
  onRun?: () => void;
  onSave?: () => void;
  onLoad?: () => void;
  onImport?: () => void;
  onExport?: () => void;
  onHistory?: () => void;
  onSettings?: () => void;
  darkMode?: boolean;
  onToggleDarkMode?: () => void;
  actions?: React.ReactNode;
}

interface OverflowItem {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  workflowName,
  statusLabel,
  dirty = false,
  onRun,
  onSave,
  onLoad,
  onImport,
  onExport,
  onHistory,
  onSettings,
  darkMode = true,
  onToggleDarkMode,
  actions,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', escape);
    };
  }, [menuOpen]);

  const overflow: OverflowItem[] = [
    onLoad && { label: '불러오기', icon: <FolderOpen size={15} />, onClick: onLoad },
    onImport && { label: '파일에서 가져오기', icon: <Upload size={15} />, onClick: onImport },
    onExport && { label: '파일로 내보내기', icon: <Download size={15} />, onClick: onExport },
    onHistory && { label: '실행 이력', icon: <Clock size={15} />, onClick: onHistory },
    onSettings && { label: '워크플로우 설정', icon: <Settings size={15} />, onClick: onSettings },
    onToggleDarkMode && {
      label: darkMode ? '밝은 테마로' : '어두운 테마로',
      icon: darkMode ? <Sun size={15} /> : <Moon size={15} />,
      onClick: onToggleDarkMode,
    },
  ].filter(Boolean) as OverflowItem[];

  return (
    <header className="designer-header">
      <div className="designer-header-left">
        <h1 className="designer-workflow-name" title={workflowName || '새 워크플로우'}>
          {workflowName || '새 워크플로우'}
        </h1>
        {statusLabel && <span className="designer-workflow-status">{statusLabel}</span>}
        {dirty && <span className="designer-workflow-dirty">저장 안 됨</span>}
      </div>

      <div className="designer-header-right">
        {actions}
        {onSave && (
          <Button variant="secondary" icon={<Save />} onClick={onSave}>
            저장
          </Button>
        )}
        {onRun && (
          <Button variant="primary" icon={<Play />} onClick={onRun}>
            실행
          </Button>
        )}

        {overflow.length > 0 && (
          <div className="designer-overflow" ref={menuRef}>
            <Button
              variant="ghost"
              icon={<MoreHorizontal />}
              onClick={() => setMenuOpen((open) => !open)}
              aria-label="더 보기"
            />
            {menuOpen && (
              <div className="designer-overflow-menu" role="menu">
                {overflow.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      item.onClick();
                    }}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
};
