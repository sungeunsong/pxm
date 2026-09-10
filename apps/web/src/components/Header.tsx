import React, { useEffect, useRef, useState } from 'react';
import { Clock, Download, FolderOpen, LayoutGrid, MoreHorizontal, Moon, Play, Save, Settings, Sun, Upload } from 'lucide-react';
import { Button } from './Button';
import './Header.css';

/**
 * Flow Designer 상단 바.
 *
 * 이전에는 로고 + "PXM Flow Designer" + "Build, test and operate workflows" 를 띄우고
 * Run/Save/Load/Import/Export/History/Settings/Theme 8개를 같은 크기로 나열했다.
 * 앱 헤더가 이미 화면 이름을 말하고 있으므로 여기서는
 * **지금 편집 중인 워크플로우**와 주 액션(저장·실행)만 보여주고 나머지는 ··· 로 넣는다.
 *
 * 왼쪽에는 워크플로우 탭 줄(leading)이 들어온다. 활성 탭이 곧 지금 편집 중인
 * 워크플로우이므로 이름·버전·배포 상태·미저장 표시를 이 바에서 한 번 더 적지 않는다.
 */

export interface HeaderProps {
  /** 왼쪽 영역에 놓을 내용. 워크플로우 탭 줄이 여기로 들어온다. */
  leading?: React.ReactNode;
  onRun?: () => void;
  onSave?: () => void;
  /** 노드를 계층형으로 다시 배치한다 */
  onAutoLayout?: () => void;
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
  leading,
  onRun,
  onSave,
  onAutoLayout,
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
    onAutoLayout && { label: '자동 정렬', icon: <LayoutGrid size={15} />, onClick: onAutoLayout },
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
      <div className="designer-header-left">{leading}</div>

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
