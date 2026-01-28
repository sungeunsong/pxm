import { useTheme } from './ThemeContext';

export function ThemeToggle() {
  const { mode, toggleTheme, colors } = useTheme();

  return (
    <button
      onClick={toggleTheme}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 40,
        height: 40,
        borderRadius: 10,
        border: `1px solid ${colors.border}`,
        backgroundColor: colors.bgSecondary,
        cursor: 'pointer',
        transition: 'all 0.2s ease',
        fontSize: 18,
      }}
      title={mode === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = colors.bgTertiary;
        e.currentTarget.style.transform = 'scale(1.05)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = colors.bgSecondary;
        e.currentTarget.style.transform = 'scale(1)';
      }}
    >
      {mode === 'dark' ? '☀️' : '🌙'}
    </button>
  );
}
