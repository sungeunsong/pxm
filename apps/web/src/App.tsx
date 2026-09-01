import { useEffect, useState, type ComponentType } from 'react';
import { 
  LayoutGrid, 
  Paintbrush, 
  Rocket, 
  Search, 
  Inbox, 
  FileJson,
  Bell,
  KeyRound,
  Plug,
  Terminal,
  HelpCircle,
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
              {activeTab === 'dashboard' && "종합 상황실 / 대시보드"}
              {activeTab === 'designer' && "Flow Designer"}
              {activeTab === 'request' && (user.role === 'user' ? "요청하기" : "워크플로우 관리")}
              {activeTab === 'myRequests' && "내 요청"}
              {activeTab === 'presets' && "API 실행 프리셋"}
              {activeTab === 'tracker' && "운영자 / 모니터링 담당 상세 화면 구성"}
              {activeTab === 'inbox' && "내 결재함"}
              {activeTab === 'credentials' && "Credential Store 관리"}
              {activeTab === 'access' && "Access Management"}
              {activeTab === 'security' && "제품 설정"}
              {activeTab === 'commands' && "Command Registry 관리"}
              {activeTab === 'plugins' && "Plugin Control 관리"}
              {activeTab === 'pluginRegistry' && "Plugin Registry 관리"}
              {activeTab === 'integrity' && "워크플로우 실행 이상 점검"}
              {activeTab === 'webhooks' && "외부 결과 Webhook"}
              {activeTab === 'operations' && "실행·Outbox 운영 상태"}
              {activeTab === 'notifications' && "승인자 알림 발송 이력"}
              {activeTab === 'audit' && "감사 로그"}
            </h1>
            <p className="header-subtitle">
              {activeTab === 'dashboard' && "전체 워크플로우 실시간 상태 모니터링 및 주요 KPI 요약"}
              {activeTab === 'designer' && "프로세스 템플릿 설계, 배포, 관리 및 노드 속성 설정"}
              {activeTab === 'request' && (user.role === 'user' ? "사용할 워크플로우를 선택하고 요청을 시작합니다" : "배포된 워크플로우를 조회하고 트리거 상태와 수동 실행을 관리합니다")}
              {activeTab === 'myRequests' && "내가 시작한 요청의 현재 결재 단계와 처리 결과를 확인합니다"}
              {activeTab === 'presets' && "워크플로우별 Start 입력값과 API 호출 alias를 한곳에서 관리합니다"}
              {activeTab === 'tracker' && "실행 모니터링, 실패 대응, 재시도/운영 조치 및 로그 분석"}
              {activeTab === 'inbox' && "승인 대기 Task 확인 및 처리"}
              {activeTab === 'credentials' && "외부 연동 secret을 안전하게 관리하고 노드에서는 credential ID만 참조합니다"}
              {activeTab === 'access' && "그룹, 유저, 서비스계정, API key 발급과 폐기를 관리합니다"}
              {activeTab === 'security' && "제품 전역 보안과 운영 정책을 관리합니다"}
              {activeTab === 'commands' && "workflow에서 사용할 allowlist command를 최고관리자가 등록하고 통제합니다"}
              {activeTab === 'plugins' && "Flow Designer에서 사용할 플러그인의 활성 상태와 workspace 정책을 관리합니다"}
              {activeTab === 'pluginRegistry' && "플러그인 manifest를 등록, 검증, hot reload합니다"}
              {activeTab === 'integrity' && "연결이 끊겼거나 처리 작업 없이 멈춘 실행 데이터를 진단하고 안전하게 복구합니다"}
              {activeTab === 'webhooks' && "최종 승인·반려·취소 결과의 외부 전달, 실패 이력과 재전송을 관리합니다"}
              {activeTab === 'operations' && "Engine Job, 장기 대기, 만료 잠금과 외부 전송 적체를 진단하고 안전하게 복구합니다"}
              {activeTab === 'notifications' && "PXM 승인자 이메일의 발송 상태, 실패 원인과 재발송을 관리합니다"}
              {activeTab === 'audit' && "관리 작업의 수행자, 대상과 변경 상세를 안전하게 추적합니다"}
            </p>
          </div>

          <div className="header-right">
            {activeTab === 'inbox' && (
              <div className="info-banner-bubble">
                승인자는 "내 결재함"에서 대기 Task를 확인하고, 상세 내용을 검토한 후 승인/반려/보류 처리할 수 있습니다.
              </div>
            )}
            {activeTab === 'tracker' && (
              <div className="info-banner-bubble info-orange">
                운영자/모니터링 담당은 실행 현황 모니터링, 실패 원인 분석, 재시도 및 로그 확인을 통해 안정적인 운영을 지원합니다.
              </div>
            )}
            {activeTab === 'credentials' && (
              <div className="info-banner-bubble">
                Secret 원문은 저장 후 다시 노출하지 않으며, 사용 이력은 audit log에 기록됩니다.
              </div>
            )}
            {activeTab === 'access' && (
              <div className="info-banner-bubble">
                API key 원문은 생성 직후 한 번만 표시되며, 이후에는 prefix만 조회됩니다.
              </div>
            )}
            {activeTab === 'security' && (
              <div className="info-banner-bubble">
                정책 변경은 최고관리자 비밀번호 재확인 후 감사 로그에 기록됩니다.
              </div>
            )}
            {activeTab === 'commands' && (
              <div className="info-banner-bubble">
                Command는 registry에 등록된 executable만 실행되며 실행 이력은 audit log로 남습니다.
              </div>
            )}
            {activeTab === 'plugins' && (
              <div className="info-banner-bubble">
                Disabled 플러그인은 디자이너 팔레트와 실행 API에서 사용할 수 없습니다.
              </div>
            )}
            {activeTab === 'pluginRegistry' && (
              <div className="info-banner-bubble">
                파일 manifest는 읽기 전용이며, 운영자가 추가한 manifest는 Mongo registry에 저장됩니다.
              </div>
            )}
            {activeTab === 'integrity' && (
              <div className="info-banner-bubble info-orange">
                점검만으로 데이터가 변경되지는 않으며, 복구 전 현재 상태를 다시 확인합니다.
              </div>
            )}
            {activeTab === 'audit' && (
              <div className="info-banner-bubble">
                민감정보는 기록 단계와 조회 단계에서 마스킹됩니다.
              </div>
            )}
            
            <div className="header-search">
              <input type="text" placeholder="메뉴, 업무, 요청명 검색 (Ctrl + K)" />
            </div>
            
            <button className="header-icon-btn badge-btn">
              <Bell size={16} />
              <span className="btn-badge">12</span>
            </button>
            
            <button className="header-icon-btn">
              <HelpCircle size={16} />
            </button>
            
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
