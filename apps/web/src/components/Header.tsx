import React from 'react';
import { Play, Save, FolderOpen, Settings, Moon, Sun, Clock } from 'lucide-react';
import { Button } from './Button';
import './Header.css';

export interface HeaderProps {
  title?: string;
  onRun?: () => void;
  onSave?: () => void;
  onLoad?: () => void;
  onHistory?: () => void;
  onSettings?: () => void;
  darkMode?: boolean;
  onToggleDarkMode?: () => void;
  actions?: React.ReactNode;
}

export const Header: React.FC<HeaderProps> = ({
  title = 'PXM Flow Designer',
  onRun,
  onSave,
  onLoad,
  onHistory,
  onSettings,
  darkMode = true,
  onToggleDarkMode,
  actions,
}) => {
  return (
    <header className="header">
      <div className="header-left">
        <div className="header-logo">
          <div className="logo-icon">PXM</div>
        </div>
        <h1 className="header-title">{title}</h1>
      </div>

      <div className="header-right">
        {actions}
        {onRun && (
          <Button
            variant="primary"
            icon={<Play />}
            onClick={onRun}
          >
            Run
          </Button>
        )}
        {onSave && (
          <Button
            variant="secondary"
            icon={<Save />}
            onClick={onSave}
          >
            Save
          </Button>
        )}
        {onLoad && (
          <Button
            variant="secondary"
            icon={<FolderOpen />}
            onClick={onLoad}
          >
            Load
          </Button>
        )}
        {onHistory && (
          <Button
            variant="secondary"
            icon={<Clock />}
            onClick={onHistory}
          >
            History
          </Button>
        )}
        {onSettings && (
          <Button
            variant="ghost"
            icon={<Settings />}
            onClick={onSettings}
          />
        )}
        {onToggleDarkMode && (
          <Button
            variant="ghost"
            icon={darkMode ? <Sun /> : <Moon />}
            onClick={onToggleDarkMode}
          />
        )}
      </div>
    </header>
  );
};
