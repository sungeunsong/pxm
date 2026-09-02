import { useEffect, useState, type ComponentType } from 'react';
import { 
  LayoutGrid, 
  Paintbrush, 
  Rocket, 
  Search, 
  Inbox, 
  FileJson,
  KeyRound,
  Plug,
  Terminal,
  Shield,
  PanelLeftClose,
  PanelLeftOpen,
  Braces,
  LockKeyhole,
  Stethoscope,
  Send,
  Activity,
  MailCheck,
  ClipboardCheck,
  FileClock,
} from 'lucide-react';
import { DashboardPage } from './dashboard/DashboardPage';
import { FlowDesigner } from './flow-designer/FlowDesigner';
import { RequestPortal } from './request-portal/RequestPortal';
import { MyRequestsPage } from './my-requests/MyRequestsPage';
import { InstanceTracker } from './instance-tracker/InstanceTracker';
import { InboxPage } from './inbox/InboxPage';
import { CredentialsPage } from './credentials/CredentialsPage';
import { CommandRegistryPage } from './commands/CommandRegistryPage';
import { PluginControlPage } from './plugins/PluginControlPage';
import { PluginRegistryPage } from './plugins/PluginRegistryPage';
import { AccessManagementPage } from './authz/AccessManagementPage';
import { LoginPage } from './auth/LoginPage';
import { ExternalApprovalPage } from './external-approval/ExternalApprovalPage';
import { AccountDialog } from './auth/AccountDialog';
import { SessionActivityGuard } from './auth/SessionActivityGuard';
import { ExecutionPresetsPage } from './input-presets/ExecutionPresetsPage';
import { SecurityPolicyPage } from './security/SecurityPolicyPage';
import { sessionApi, type SessionUser } from './api/session';
import { AUTH_REQUIRED_EVENT } from './api/fetch-security';
import { RuntimeIntegrityPage } from './runtime-integrity/RuntimeIntegrityPage';
import { WebhookManagementPage } from './webhooks/WebhookManagementPage';
import { OperationsPage } from './operations/OperationsPage';
import { NotificationManagementPage } from './notifications/NotificationManagementPage';
import { AuditLogPage } from './audit/AuditLogPage';
import './App.css';

type ActiveTab =
  | 'dashboard'
  | 'designer'
  | 'request'
  | 'myRequests'
  | 'presets'
  | 'tracker'
  | 'inbox'
  | 'credentials'
  | 'commands'
  | 'plugins'
  | 'pluginRegistry'
  | 'access'
  | 'security'
  | 'integrity'
  | 'webhooks'
  | 'operations'
  | 'notifications'
  | 'audit';

const DEFAULT_TAB: ActiveTab = 'dashboard';

const ROUTE_TO_TAB: Record<string, ActiveTab> = {
  dashboard: 'dashboard',
  designer: 'designer',
  request: 'request',
  'my-requests': 'myRequests',
  presets: 'presets',
  tracker: 'tracker',
  inbox: 'inbox',
  credentials: 'credentials',
  commands: 'commands',
  plugins: 'plugins',
  'plugin-registry': 'pluginRegistry',
  access: 'access',
  security: 'security',
  integrity: 'integrity',
  webhooks: 'webhooks',
  operations: 'operations',
  notifications: 'notifications',
  audit: 'audit',
};

const TAB_TO_ROUTE: Record<ActiveTab, string> = {
  dashboard: 'dashboard',
  designer: 'designer',
  request: 'request',
  myRequests: 'my-requests',
  presets: 'presets',
  tracker: 'tracker',
  inbox: 'inbox',
  credentials: 'credentials',
  commands: 'commands',
  plugins: 'plugins',
  pluginRegistry: 'plugin-registry',
  access: 'access',
  security: 'security',
  integrity: 'integrity',
  webhooks: 'webhooks',
  operations: 'operations',
  notifications: 'notifications',
  audit: 'audit',
};

const PAGE_TITLE: Record<ActiveTab, string> = {
  dashboard: '대시보드',
  designer: '워크플로우 설계',
  request: '워크플로우 관리',
  myRequests: '내 요청',
  presets: '실행 프리셋',
  tracker: '실행 모니터링',
  inbox: '내 결재함',
  credentials: '연동 자격증명',
  commands: '명령어 관리',
  plugins: '플러그인 제어',
  pluginRegistry: '플러그인 등록',
  access: '사용자 및 권한',
  security: '제품 설정',
  integrity: '실행 이상 점검',
  webhooks: '결과 Webhook',
  operations: '운영 상태',
  notifications: '승인자 알림',
  audit: '감사 로그',
};

const USER_TABS = new Set<ActiveTab>(['request', 'myRequests', 'inbox']);
const GROUP_MANAGER_TABS = new Set<ActiveTab>([
  'dashboard',
  'designer',
  'request',
  'myRequests',
  'presets',
  'tracker',
  'inbox',
  'credentials',
  'access',
  'audit',
]);

function canAccessTab(role: SessionUser['role'], tab: ActiveTab): boolean {
  if (role === 'admin') return true;
  return (role === 'group_manager' ? GROUP_MANAGER_TABS : USER_TABS).has(tab);
}

function landingTab(role: SessionUser['role']): ActiveTab {
  return role === 'user' ? 'request' : 'dashboard';
}

type SidebarItemDefinition = {
  tab: ActiveTab;
  label: string;
  icon: ComponentType<{ size?: number }>;
};

type SidebarSectionDefinition = {
  id: string;
  label: string;
  items: SidebarItemDefinition[];
};

function sidebarSections(role: SessionUser['role']): SidebarSectionDefinition[] {
  const requests: SidebarSectionDefinition = {
    id: 'requests',
    label: role === 'user' ? '나의 업무' : '요청 및 결재',
    items: role === 'user'
      ? [
          { tab: 'request', label: '요청하기', icon: Rocket },
          { tab: 'myRequests', label: '내 요청', icon: ClipboardCheck },
          { tab: 'inbox', label: '내 결재함', icon: Inbox },
        ]
      : [
          { tab: 'myRequests', label: '내 요청', icon: ClipboardCheck },
          { tab: 'inbox', label: '내 결재함', icon: Inbox },
        ],
  };
  if (role === 'user') return [requests];

  const sections: SidebarSectionDefinition[] = [
    {
      id: 'overview',
      label: '개요',
      items: [{ tab: 'dashboard', label: '대시보드', icon: LayoutGrid }],
    },
    {
      id: 'workflow',
      label: '설계 및 실행',
      items: [
        { tab: 'designer', label: '워크플로우 설계', icon: Paintbrush },
        { tab: 'request', label: '워크플로우 관리', icon: Rocket },
        { tab: 'presets', label: '실행 프리셋', icon: Braces },
        { tab: 'tracker', label: '실행 모니터링', icon: Search },
      ],
    },
    requests,
  ];

  if (role === 'admin') {
    sections.push({
      id: 'operations',
      label: '운영',
      items: [
        { tab: 'operations', label: '운영 상태', icon: Activity },
        { tab: 'integrity', label: '실행 이상 점검', icon: Stethoscope },
        { tab: 'notifications', label: '승인자 알림', icon: MailCheck },
        { tab: 'webhooks', label: '결과 Webhook', icon: Send },
        { tab: 'audit', label: '감사 로그', icon: FileClock },
      ],
    });
  }

  sections.push({
    id: 'platform',
    label: role === 'admin' ? '플랫폼 설정' : '그룹 관리',
    items: [
      { tab: 'access', label: '사용자 및 권한', icon: Shield },
      { tab: 'credentials', label: '연동 자격증명', icon: KeyRound },
      ...(role === 'group_manager'
        ? [{ tab: 'audit' as const, label: '감사 로그', icon: FileClock }]
        : []),
      ...(role === 'admin'
        ? [
            { tab: 'security' as const, label: '제품 설정', icon: LockKeyhole },
            { tab: 'commands' as const, label: '명령어 관리', icon: Terminal },
            { tab: 'plugins' as const, label: '플러그인 제어', icon: Plug },
            { tab: 'pluginRegistry' as const, label: '플러그인 등록', icon: FileJson },
          ]
        : []),
    ],
  });
  return sections;
}

const readTabFromHash = (): ActiveTab | null => {
  if (typeof window === 'undefined') return null;
  const route = window.location.hash.replace(/^#\/?/, '').split('?')[0];
  return ROUTE_TO_TAB[route] || null;
};

const readInitialTab = (): ActiveTab => {
  if (typeof window === 'undefined') return DEFAULT_TAB;
  const hashTab = readTabFromHash();
  if (hashTab) return hashTab;

  return DEFAULT_TAB;
};

function WorkspaceApp({ user, onUserChange, onLogout, onSessionRevoked, onSessionExpired }: { user: SessionUser; onUserChange: (user: SessionUser) => void; onLogout: () => void; onSessionRevoked: () => void; onSessionExpired: () => void }) {
  const [activeTab, setActiveTabState] = useState<ActiveTab>(() => {
    const initialTab = readInitialTab();
    return canAccessTab(user.role, initialTab) ? initialTab : landingTab(user.role);
  });
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [selectedRequestInstanceId, setSelectedRequestInstanceId] = useState<string | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('pxm.sidebar.collapsed') === 'true');
  const navigationSections = sidebarSections(user.role);

  const toggleSidebar = () => setSidebarCollapsed((current) => {
    localStorage.setItem('pxm.sidebar.collapsed', String(!current));
    return !current;
  });

  const setActiveTab = (tab: ActiveTab) => {
    const nextTab = canAccessTab(user.role, tab) ? tab : landingTab(user.role);
    setActiveTabState(nextTab);
    window.history.pushState(null, '', `#/${TAB_TO_ROUTE[nextTab]}`);
  };

  useEffect(() => {
    if (!window.location.hash) {
      window.history.replaceState(null, '', `#/${TAB_TO_ROUTE[activeTab]}`);
    } else {
      const requestedTab = readTabFromHash();
      if (requestedTab && !canAccessTab(user.role, requestedTab)) {
        window.history.replaceState(null, '', `#/${TAB_TO_ROUTE[activeTab]}`);
      }
    }

    const syncTabFromLocation = () => {
      const nextTab = readTabFromHash();
      if (!nextTab) return;
      const allowedTab = canAccessTab(user.role, nextTab) ? nextTab : landingTab(user.role);
      setActiveTabState(allowedTab);
      if (allowedTab !== nextTab) {
        window.history.replaceState(null, '', `#/${TAB_TO_ROUTE[allowedTab]}`);
      }
    };

    window.addEventListener('hashchange', syncTabFromLocation);
    window.addEventListener('popstate', syncTabFromLocation);
    return () => {
      window.removeEventListener('hashchange', syncTabFromLocation);
      window.removeEventListener('popstate', syncTabFromLocation);
    };
  }, [activeTab, user.role]);

  // 실행 트래커에서 인스턴스를 선택해 실시간 모니터링을 시도할 때
  const handleSelectInstanceForTracking = (instanceId: string) => {
    setSelectedInstanceId(instanceId);
    setActiveTab('designer'); // Flow Designer로 탭 스위칭
  };

  const handleRequestStarted = (instanceId: string) => {
    setSelectedRequestInstanceId(instanceId);
    setActiveTab('myRequests');
  };

  const handleSidebarSelect = (tab: ActiveTab) => {
    if (tab === 'designer') setSelectedInstanceId(null);
    setActiveTab(tab);
  };

  return (
    <div className="app-container">
      {/* 1. Left Sidebar (Deep Navy) */}
      <aside className={`app-sidebar${sidebarCollapsed ? ' collapsed' : ''}`}>
        <div className="sidebar-logo">
          <div className="sidebar-logo-text">
            <img src="/brand/pxm-app-icon.png" alt="" /><span>PXM</span>
          </div>
          <button className="sidebar-collapse-button" onClick={toggleSidebar} title={sidebarCollapsed ? '사이드바 펼치기' : '사이드바 접기'} aria-label={sidebarCollapsed ? '사이드바 펼치기' : '사이드바 접기'}>
            {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        </div>
        
        <nav className="sidebar-menu">
          {navigationSections.map((section) => (
            <section className="sidebar-menu-section" data-testid="sidebar-section" data-section-id={section.id} key={section.id}>
              <div className="sidebar-section-label">{section.label}</div>
              <div className="sidebar-section-items">
                {section.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.tab}
                      title={item.label}
                      className={`sidebar-menu-item ${activeTab === item.tab ? 'active' : ''}`}
                      onClick={() => handleSidebarSelect(item.tab)}
                    >
                      <Icon size={16} />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
          
        </nav>
        
        <div className="sidebar-footer">
          <div className="sidebar-avatar">
            {user.display_name.slice(0, 1)}
          </div>
          <div className="sidebar-user-info">
            <span className="sidebar-user-name">
              {user.display_name}
            </span>
            <span className="sidebar-user-dept">
              {user.role === 'admin' ? '최고관리자' : user.role === 'group_manager' ? '그룹 관리자' : '사용자'}
            </span>
          </div>
        </div>
      </aside>

      {/* 2. Main Area (White Header + Grey Content) */}
      <div className="app-main">
        <header className="app-top-header">
          <div className="header-left">
            <h1 className="header-title">
              {activeTab === 'request' && user.role === 'user' ? '요청하기' : PAGE_TITLE[activeTab]}
            </h1>
          </div>

          <div className="header-right">
            <button className="header-profile" onClick={() => setAccountOpen(true)}>
              <span className="header-profile-avatar">{user.display_name.slice(0, 1)}</span>
              <div className="profile-text">
                <span className="profile-name">
                  {user.display_name}
                </span>
                <span className="profile-role">
                  {user.id}
                </span>
              </div>
            </button>
            <button className="header-logout" onClick={onLogout}>로그아웃</button>
          </div>
        </header>

        {/* Core Screen Rendering */}
        <main className="app-main-content">
          {activeTab === 'dashboard' && <DashboardPage />}
          
          {activeTab === 'designer' && (
            <div style={{ height: '100%' }}>
              <FlowDesigner 
                currentUser={user}
                onSwitchToInbox={() => setActiveTab('inbox')}
                onExitTrace={() => {
                  setSelectedInstanceId(null);
                  setActiveTab('tracker');
                }}
                initialMonitorInstanceId={selectedInstanceId || undefined}
              />
            </div>
          )}

          {activeTab === 'request' && <RequestPortal currentUser={user} onRequestStarted={handleRequestStarted} />}

          {activeTab === 'myRequests' && (
            <MyRequestsPage currentUser={user} initialInstanceId={selectedRequestInstanceId} />
          )}

          {activeTab === 'presets' && <ExecutionPresetsPage currentUser={user} />}

          {activeTab === 'tracker' && (
            <InstanceTracker onSelectInstance={handleSelectInstanceForTracking} />
          )}

          {activeTab === 'inbox' && (
            <InboxPage onSwitchToDesigner={() => setActiveTab('designer')} />
          )}

          {activeTab === 'credentials' && <CredentialsPage currentUser={user} />}

          {activeTab === 'access' && <AccessManagementPage currentUser={user} />}

          {activeTab === 'security' && <SecurityPolicyPage onCurrentSessionRevoked={onSessionRevoked} />}

          {activeTab === 'commands' && <CommandRegistryPage />}

          {activeTab === 'plugins' && <PluginControlPage />}

          {activeTab === 'pluginRegistry' && <PluginRegistryPage />}

          {activeTab === 'integrity' && <RuntimeIntegrityPage />}

          {activeTab === 'webhooks' && <WebhookManagementPage />}

          {activeTab === 'operations' && <OperationsPage />}

          {activeTab === 'notifications' && <NotificationManagementPage />}

          {activeTab === 'audit' && <AuditLogPage currentUser={user} />}
        </main>
      </div>
      {accountOpen && <AccountDialog user={user} onChange={onUserChange} onClose={() => setAccountOpen(false)} />}
      <SessionActivityGuard user={user} onUserChange={onUserChange} onExpired={onSessionExpired} />
    </div>
  );
}

function AuthenticatedApp() {
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);
  const [loginNotice, setLoginNotice] = useState('');
  useEffect(() => {
    const handleAuthRequired = () => {
      setLoginNotice('세션이 만료되었습니다. 다시 로그인해 주세요.');
      setUser(null);
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, handleAuthRequired);
    sessionApi.me().then(setUser).catch(() => setUser(null));
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, handleAuthRequired);
  }, []);
  if (user === undefined) return <main className="login-page"><div className="login-loading">세션 확인 중…</div></main>;
  if (!user) return <LoginPage notice={loginNotice} onLogin={(nextUser) => { setLoginNotice(''); setUser(nextUser); }} />;
  return <WorkspaceApp
    user={user}
    onUserChange={setUser}
    onLogout={async () => { await sessionApi.logout(); setUser(null); }}
    onSessionRevoked={() => { setLoginNotice('보안 정책 변경으로 세션이 종료되었습니다. 다시 로그인해 주세요.'); setUser(null); }}
    onSessionExpired={() => { setLoginNotice('비활동 또는 절대 만료시간이 지나 세션이 종료되었습니다. 다시 로그인해 주세요.'); setUser(null); }}
  />;
}

function App() {
  const externalApprovalMatch = window.location.pathname.match(/^\/external-approval\/([A-Za-z0-9_-]+)\/?$/);
  if (externalApprovalMatch) return <ExternalApprovalPage token={externalApprovalMatch[1]} />;
  return <AuthenticatedApp />;
}

export default App;
