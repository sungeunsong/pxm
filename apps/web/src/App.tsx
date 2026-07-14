import { useEffect, useState } from 'react';
import { 
  LayoutGrid, 
  Paintbrush, 
  Rocket, 
  Search, 
  Inbox, 
  FileText, 
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
} from 'lucide-react';
import { DashboardPage } from './dashboard/DashboardPage';
import { FlowDesigner } from './flow-designer/FlowDesigner';
import { RequestPortal } from './request-portal/RequestPortal';
import { InstanceTracker } from './instance-tracker/InstanceTracker';
import { InboxPage } from './inbox/InboxPage';
import { CredentialsPage } from './credentials/CredentialsPage';
import { CommandRegistryPage } from './commands/CommandRegistryPage';
import { PluginControlPage } from './plugins/PluginControlPage';
import { PluginRegistryPage } from './plugins/PluginRegistryPage';
import { AccessManagementPage } from './authz/AccessManagementPage';
import { LoginPage } from './auth/LoginPage';
import { AccountDialog } from './auth/AccountDialog';
import { SessionActivityGuard } from './auth/SessionActivityGuard';
import { ExecutionPresetsPage } from './input-presets/ExecutionPresetsPage';
import { SecurityPolicyPage } from './security/SecurityPolicyPage';
import { sessionApi, type SessionUser } from './api/session';
import { AUTH_REQUIRED_EVENT } from './api/fetch-security';
import { approvalSampleUiEnabled } from './config/features';
import './App.css';

type ActiveTab =
  | 'dashboard'
  | 'designer'
  | 'request'
  | 'presets'
  | 'tracker'
  | 'inbox'
  | 'credentials'
  | 'commands'
  | 'plugins'
  | 'pluginRegistry'
  | 'access'
  | 'security';

const DEFAULT_TAB: ActiveTab = 'dashboard';

const ROUTE_TO_TAB: Record<string, ActiveTab> = {
  dashboard: 'dashboard',
  designer: 'designer',
  request: 'request',
  presets: 'presets',
  tracker: 'tracker',
  inbox: 'inbox',
  credentials: 'credentials',
  commands: 'commands',
  plugins: 'plugins',
  'plugin-registry': 'pluginRegistry',
  access: 'access',
  security: 'security',
};

const TAB_TO_ROUTE: Record<ActiveTab, string> = {
  dashboard: 'dashboard',
  designer: 'designer',
  request: 'request',
  presets: 'presets',
  tracker: 'tracker',
  inbox: 'inbox',
  credentials: 'credentials',
  commands: 'commands',
  plugins: 'plugins',
  pluginRegistry: 'plugin-registry',
  access: 'access',
  security: 'security',
};

const readTabFromHash = (): ActiveTab | null => {
  if (typeof window === 'undefined') return null;
  const route = window.location.hash.replace(/^#\/?/, '').split('?')[0];
  const tab = ROUTE_TO_TAB[route] || null;
  return tab === 'inbox' && !approvalSampleUiEnabled ? null : tab;
};

const readInitialTab = (): ActiveTab => {
  if (typeof window === 'undefined') return DEFAULT_TAB;
  const hashTab = readTabFromHash();
  if (hashTab) return hashTab;

  return DEFAULT_TAB;
};

function WorkspaceApp({ user, onUserChange, onLogout, onSessionRevoked, onSessionExpired }: { user: SessionUser; onUserChange: (user: SessionUser) => void; onLogout: () => void; onSessionRevoked: () => void; onSessionExpired: () => void }) {
  const [activeTab, setActiveTabState] = useState<ActiveTab>(readInitialTab);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('pxm.sidebar.collapsed') === 'true');

  const toggleSidebar = () => setSidebarCollapsed((current) => {
    localStorage.setItem('pxm.sidebar.collapsed', String(!current));
    return !current;
  });

  const setActiveTab = (tab: ActiveTab) => {
    const nextTab = tab === 'inbox' && !approvalSampleUiEnabled ? 'request' : tab;
    setActiveTabState(nextTab);
    window.history.pushState(null, '', `#/${TAB_TO_ROUTE[nextTab]}`);
  };

  useEffect(() => {
    const userTabs: ActiveTab[] = approvalSampleUiEnabled
      ? ['request', 'tracker', 'inbox']
      : ['request', 'tracker'];
    if (user.role === 'user' && !userTabs.includes(activeTab)) {
      setActiveTab('request');
    } else if (!approvalSampleUiEnabled && activeTab === 'inbox') {
      setActiveTab(user.role === 'user' ? 'request' : 'dashboard');
    }
  }, [activeTab, user.role]);

  useEffect(() => {
    if (!window.location.hash) {
      window.history.replaceState(null, '', `#/${TAB_TO_ROUTE[activeTab]}`);
    }

    const syncTabFromLocation = () => {
      const nextTab = readTabFromHash();
      if (!nextTab) return;
      setActiveTabState(nextTab);
    };

    window.addEventListener('hashchange', syncTabFromLocation);
    window.addEventListener('popstate', syncTabFromLocation);
    return () => {
      window.removeEventListener('hashchange', syncTabFromLocation);
      window.removeEventListener('popstate', syncTabFromLocation);
    };
  }, [activeTab]);

  // 실행 트래커에서 인스턴스를 선택해 실시간 모니터링을 시도할 때
  const handleSelectInstanceForTracking = (instanceId: string) => {
    setSelectedInstanceId(instanceId);
    setActiveTab('designer'); // Flow Designer로 탭 스위칭
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
          {user.role !== 'user' && <button
            title="대시보드"
            className={`sidebar-menu-item ${activeTab === 'dashboard' ? 'active' : ''}`}
            onClick={() => setActiveTab('dashboard')}
          >
            <LayoutGrid size={16} />
            <span>대시보드</span>
          </button>}

          {user.role === 'admin' && <button
            title="보안 정책"
            className={`sidebar-menu-item ${activeTab === 'security' ? 'active' : ''}`}
            onClick={() => setActiveTab('security')}
          >
            <LockKeyhole size={16} />
            <span>보안 정책</span>
          </button>}
          
          {user.role !== 'user' && <button
            title="Flow Designer"
            className={`sidebar-menu-item ${activeTab === 'designer' ? 'active' : ''}`}
            onClick={() => {
              setActiveTab('designer');
              setSelectedInstanceId(null); // 신규 설계 모드 리셋
            }}
          >
            <Paintbrush size={16} />
            <span>Flow Designer</span>
          </button>}

          <button
            title="워크플로우 관리"
            className={`sidebar-menu-item ${activeTab === 'request' ? 'active' : ''}`}
            onClick={() => setActiveTab('request')}
          >
            <Rocket size={16} />
            <span>워크플로우 관리</span>
          </button>

          {user.role !== 'user' && <button
            title="API 실행 프리셋"
            className={`sidebar-menu-item ${activeTab === 'presets' ? 'active' : ''}`}
            onClick={() => setActiveTab('presets')}
          >
            <Braces size={16} />
            <span>API 실행 프리셋</span>
          </button>}

          <button
            title="실행 모니터링"
            className={`sidebar-menu-item ${activeTab === 'tracker' ? 'active' : ''}`}
            onClick={() => setActiveTab('tracker')}
          >
            <Search size={16} />
            <span>실행 모니터링</span>
          </button>

          {approvalSampleUiEnabled && <button
            title="승인자 / 결재자"
            className={`sidebar-menu-item ${activeTab === 'inbox' ? 'active' : ''}`}
            onClick={() => setActiveTab('inbox')}
          >
            <Inbox size={16} />
            <span>승인자 / 결재자</span>
          </button>}
          
          {user.role !== 'user' && <div className="sidebar-separator">설정 및 감사</div>}
          
          {user.role !== 'user' && <button
            title="Credential Store"
            className={`sidebar-menu-item ${activeTab === 'credentials' ? 'active' : ''}`}
            onClick={() => setActiveTab('credentials')}
          >
            <KeyRound size={16} />
            <span>Credential Store</span>
          </button>}

          {user.role !== 'user' && <button
            title="Access Management"
            className={`sidebar-menu-item ${activeTab === 'access' ? 'active' : ''}`}
            onClick={() => setActiveTab('access')}
          >
            <Shield size={16} />
            <span>Access Management</span>
          </button>}

          {user.role === 'admin' && <button
            title="Command Registry"
            className={`sidebar-menu-item ${activeTab === 'commands' ? 'active' : ''}`}
            onClick={() => setActiveTab('commands')}
          >
            <Terminal size={16} />
            <span>Command Registry</span>
          </button>}

          {user.role === 'admin' && <button
            title="Plugin Control"
            className={`sidebar-menu-item ${activeTab === 'plugins' ? 'active' : ''}`}
            onClick={() => setActiveTab('plugins')}
          >
            <Plug size={16} />
            <span>Plugin Control</span>
          </button>}

          {user.role === 'admin' && <button
            title="Plugin Registry"
            className={`sidebar-menu-item ${activeTab === 'pluginRegistry' ? 'active' : ''}`}
            onClick={() => setActiveTab('pluginRegistry')}
          >
            <FileJson size={16} />
            <span>Plugin Registry</span>
          </button>}
          
          {user.role !== 'user' && <button className="sidebar-menu-item disabled" title="감사 로그">
            <FileText size={16} />
            <span>감사 로그</span>
          </button>}
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
              {activeTab === 'request' && "워크플로우 관리"}
              {activeTab === 'presets' && "API 실행 프리셋"}
              {activeTab === 'tracker' && "운영자 / 모니터링 담당 상세 화면 구성"}
              {activeTab === 'inbox' && "내 결재함"}
              {activeTab === 'credentials' && "Credential Store 관리"}
              {activeTab === 'access' && "Access Management"}
              {activeTab === 'security' && "보안 정책"}
              {activeTab === 'commands' && "Command Registry 관리"}
              {activeTab === 'plugins' && "Plugin Control 관리"}
              {activeTab === 'pluginRegistry' && "Plugin Registry 관리"}
            </h1>
            <p className="header-subtitle">
              {activeTab === 'dashboard' && "전체 워크플로우 실시간 상태 모니터링 및 주요 KPI 요약"}
              {activeTab === 'designer' && "프로세스 템플릿 설계, 배포, 관리 및 노드 속성 설정"}
              {activeTab === 'request' && "배포된 워크플로우를 조회하고 트리거 상태와 수동 실행을 관리합니다"}
              {activeTab === 'presets' && "워크플로우별 Start 입력값과 API 호출 alias를 한곳에서 관리합니다"}
              {activeTab === 'tracker' && "실행 모니터링, 실패 대응, 재시도/운영 조치 및 로그 분석"}
              {activeTab === 'inbox' && "승인 대기 Task 확인 및 처리"}
              {activeTab === 'credentials' && "외부 연동 secret을 안전하게 관리하고 노드에서는 credential ID만 참조합니다"}
              {activeTab === 'access' && "그룹, 유저, 서비스계정, API key 발급과 폐기를 관리합니다"}
              {activeTab === 'security' && "로그인 세션의 비활동·절대 만료 정책과 기존 세션 처리를 관리합니다"}
              {activeTab === 'commands' && "workflow에서 사용할 allowlist command를 최고관리자가 등록하고 통제합니다"}
              {activeTab === 'plugins' && "Flow Designer에서 사용할 플러그인의 활성 상태와 workspace 정책을 관리합니다"}
              {activeTab === 'pluginRegistry' && "플러그인 manifest를 등록, 검증, hot reload합니다"}
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
                onSwitchToInbox={approvalSampleUiEnabled ? () => setActiveTab('inbox') : undefined}
                initialMonitorInstanceId={selectedInstanceId || undefined}
              />
            </div>
          )}

          {activeTab === 'request' && <RequestPortal currentUser={user} />}

          {activeTab === 'presets' && <ExecutionPresetsPage currentUser={user} />}

          {activeTab === 'tracker' && (
            <InstanceTracker onSelectInstance={handleSelectInstanceForTracking} />
          )}

          {approvalSampleUiEnabled && activeTab === 'inbox' && (
            <InboxPage onSwitchToDesigner={() => setActiveTab('designer')} />
          )}

          {activeTab === 'credentials' && <CredentialsPage currentUser={user} />}

          {activeTab === 'access' && <AccessManagementPage currentUser={user} />}

          {activeTab === 'security' && <SecurityPolicyPage onCurrentSessionRevoked={onSessionRevoked} />}

          {activeTab === 'commands' && <CommandRegistryPage />}

          {activeTab === 'plugins' && <PluginControlPage />}

          {activeTab === 'pluginRegistry' && <PluginRegistryPage />}
        </main>
      </div>
      {accountOpen && <AccountDialog user={user} onChange={onUserChange} onClose={() => setAccountOpen(false)} />}
      <SessionActivityGuard user={user} onUserChange={onUserChange} onExpired={onSessionExpired} />
    </div>
  );
}

function App() {
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

export default App;
