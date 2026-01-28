// 테마 타입
export type ThemeMode = 'dark' | 'light';

// 테마별 색상 정의
export interface ThemeColors {
  // 배경
  bgPrimary: string;
  bgSecondary: string;
  bgTertiary: string;

  // 텍스트
  textPrimary: string;
  textSecondary: string;
  textMuted: string;

  // 보더
  border: string;
  borderLight: string;

  // 액센트
  accent: string;
  accentHover: string;

  // 그래프 배경
  graphBg: string;
  graphDots: string;
}

export const themes: Record<ThemeMode, ThemeColors> = {
  dark: {
    bgPrimary: '#0f172a',
    bgSecondary: '#1e293b',
    bgTertiary: '#334155',
    textPrimary: '#f8fafc',
    textSecondary: '#e2e8f0',
    textMuted: '#64748b',
    border: '#334155',
    borderLight: '#475569',
    accent: '#3b82f6',
    accentHover: '#2563eb',
    graphBg: '#0f172a',
    graphDots: '#334155',
  },
  light: {
    bgPrimary: '#ffffff',
    bgSecondary: '#f8fafc',
    bgTertiary: '#e2e8f0',
    textPrimary: '#0f172a',
    textSecondary: '#1e293b',
    textMuted: '#64748b',
    border: '#e2e8f0',
    borderLight: '#cbd5e1',
    accent: '#2563eb',
    accentHover: '#1d4ed8',
    graphBg: '#f8fafc',
    graphDots: '#cbd5e1',
  },
};

// 노드 상태별 색상 (테마별)
export const getNodeStatusColors = (theme: ThemeMode) => ({
  idle: {
    bg: theme === 'dark' ? '#f8fafc' : '#f1f5f9',
    border: theme === 'dark' ? '#cbd5e1' : '#94a3b8',
    text: '#64748b',
  },
  running: {
    bg: theme === 'dark' ? '#dbeafe' : '#eff6ff',
    border: '#3b82f6',
    text: '#1d4ed8',
    glow: '0 0 20px rgba(59, 130, 246, 0.5)',
  },
  completed: {
    bg: theme === 'dark' ? '#dcfce7' : '#f0fdf4',
    border: '#22c55e',
    text: '#15803d',
  },
  failed: {
    bg: theme === 'dark' ? '#fee2e2' : '#fef2f2',
    border: '#ef4444',
    text: '#dc2626',
    glow: '0 0 20px rgba(239, 68, 68, 0.5)',
  },
  waiting: {
    bg: theme === 'dark' ? '#fef3c7' : '#fffbeb',
    border: '#f59e0b',
    text: '#d97706',
    glow: '0 0 20px rgba(245, 158, 11, 0.4)',
  },
  retrying: {
    bg: theme === 'dark' ? '#fae8ff' : '#fdf4ff',
    border: '#c026d3',
    text: '#a21caf',
    glow: '0 0 20px rgba(192, 38, 211, 0.4)',
  },
});
