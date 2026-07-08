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
  HelpCircle
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
import './App.css';

type ActiveTab =
  | 'dashboard'
  | 'designer'
  | 'request'
  | 'tracker'
  | 'inbox'
  | 'credentials'
  | 'commands'
  | 'plugins'
  | 'pluginRegistry';

const DEFAULT_TAB: ActiveTab = 'inbox';

const ROUTE_TO_TAB: Record<string, ActiveTab> = {
  dashboard: 'dashboard',
  designer: 'designer',
  request: 'request',
  tracker: 'tracker',
  inbox: 'inbox',
  credentials: 'credentials',
  commands: 'commands',
  plugins: 'plugins',
  'plugin-registry': 'pluginRegistry',
};

const TAB_TO_ROUTE: Record<ActiveTab, string> = {
  dashboard: 'dashboard',
  designer: 'designer',
  request: 'request',
  tracker: 'tracker',
  inbox: 'inbox',
  credentials: 'credentials',
  commands: 'commands',
  plugins: 'plugins',
  pluginRegistry: 'plugin-registry',
};

const readTabFromHash = (): ActiveTab | null => {
  if (typeof window === 'undefined') return null;
  const route = window.location.hash.replace(/^#\/?/, '');
  return ROUTE_TO_TAB[route] || null;
};

const readInitialTab = (): ActiveTab => {
  if (typeof window === 'undefined') return DEFAULT_TAB;
  const hashTab = readTabFromHash();
  if (hashTab) return hashTab;

  return DEFAULT_TAB;
};

function App() {
  const [activeTab, setActiveTabState] = useState<ActiveTab>(readInitialTab);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);

  const setActiveTab = (tab: ActiveTab) => {
    setActiveTabState(tab);
    window.history.pushState(null, '', `#/${TAB_TO_ROUTE[tab]}`);
  };

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
      <aside className="app-sidebar">
        <div className="sidebar-logo">
          <div className="sidebar-logo-text">
            <div className="sidebar-logo-dot" />
            BPM Web
          </div>
        </div>
        
        <nav className="sidebar-menu">
          <button 
            className={`sidebar-menu-item ${activeTab === 'dashboard' ? 'active' : ''}`}
            onClick={() => setActiveTab('dashboard')}
          >
            <LayoutGrid size={16} />
            <span>대시보드</span>
          </button>
          
          <button 
            className={`sidebar-menu-item ${activeTab === 'designer' ? 'active' : ''}`}
            onClick={() => {
              setActiveTab('designer');
              setSelectedInstanceId(null); // 신규 설계 모드 리셋
            }}
          >
            <Paintbrush size={16} />
            <span>Flow Designer</span>
          </button>

          <button 
            className={`sidebar-menu-item ${activeTab === 'request' ? 'active' : ''}`}
            onClick={() => setActiveTab('request')}
          >
            <Rocket size={16} />
            <span>워크플로우 관리</span>
          </button>

          <button 
            className={`sidebar-menu-item ${activeTab === 'tracker' ? 'active' : ''}`}
            onClick={() => setActiveTab('tracker')}
          >
            <Search size={16} />
            <span>실행 모니터링</span>
          </button>

          <button 
            className={`sidebar-menu-item ${activeTab === 'inbox' ? 'active' : ''}`}
            onClick={() => setActiveTab('inbox')}
          >
            <Inbox size={16} />
            <span>승인자 / 결재자</span>
          </button>
          
          <div className="sidebar-separator">설정 및 감사</div>
          
          <button 
            className={`sidebar-menu-item ${activeTab === 'credentials' ? 'active' : ''}`}
            onClick={() => setActiveTab('credentials')}
          >
            <KeyRound size={16} />
            <span>Credential Store</span>
          </button>

          <button
            className={`sidebar-menu-item ${activeTab === 'commands' ? 'active' : ''}`}
            onClick={() => setActiveTab('commands')}
          >
            <Terminal size={16} />
            <span>Command Registry</span>
          </button>

          <button
            className={`sidebar-menu-item ${activeTab === 'plugins' ? 'active' : ''}`}
            onClick={() => setActiveTab('plugins')}
          >
            <Plug size={16} />
            <span>Plugin Control</span>
          </button>

          <button
            className={`sidebar-menu-item ${activeTab === 'pluginRegistry' ? 'active' : ''}`}
            onClick={() => setActiveTab('pluginRegistry')}
          >
            <FileJson size={16} />
            <span>Plugin Registry</span>
          </button>
          
          <button className="sidebar-menu-item disabled">
            <FileText size={16} />
            <span>감사 로그</span>
          </button>
        </nav>
        
        <div className="sidebar-footer">
          <div className="sidebar-avatar">
            {activeTab === 'inbox' ? "결" : activeTab === 'tracker' ? "운" : "설"}
          </div>
          <div className="sidebar-user-info">
            <span className="sidebar-user-name">
              {activeTab === 'inbox' ? "김결재 부장" : activeTab === 'tracker' ? "운영자" : "설계자"}
            </span>
            <span className="sidebar-user-dept">
              {activeTab === 'inbox' ? "경영지원본부" : activeTab === 'tracker' ? "시스템관리팀" : "프로세스혁신팀"}
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
              {activeTab === 'designer' && "설계자 / 관리자 상세 화면 구성"}
              {activeTab === 'request' && "워크플로우 관리"}
              {activeTab === 'tracker' && "운영자 / 모니터링 담당 상세 화면 구성"}
              {activeTab === 'inbox' && "내 결재함"}
              {activeTab === 'credentials' && "Credential Store 관리"}
              {activeTab === 'commands' && "Command Registry 관리"}
              {activeTab === 'plugins' && "Plugin Control 관리"}
              {activeTab === 'pluginRegistry' && "Plugin Registry 관리"}
            </h1>
            <p className="header-subtitle">
              {activeTab === 'dashboard' && "전체 워크플로우 실시간 상태 모니터링 및 주요 KPI 요약"}
              {activeTab === 'designer' && "프로세스 템플릿 설계, 배포, 관리 및 노드 속성 설정"}
              {activeTab === 'request' && "배포된 워크플로우를 조회하고 트리거 상태와 수동 실행을 관리합니다"}
              {activeTab === 'tracker' && "실행 모니터링, 실패 대응, 재시도/운영 조치 및 로그 분석"}
              {activeTab === 'inbox' && "승인 대기 Task 확인 및 처리"}
              {activeTab === 'credentials' && "외부 연동 secret을 안전하게 관리하고 노드에서는 credential ID만 참조합니다"}
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
            {activeTab === 'designer' && (
              <div className="info-banner-bubble info-purple">
                설계자/관리자는 드래그 & 드롭으로 손쉽게 프로세스를 구성하고, 속성 설정 및 버전을 관리합니다.
              </div>
            )}
            {activeTab === 'credentials' && (
              <div className="info-banner-bubble">
                Secret 원문은 저장 후 다시 노출하지 않으며, 사용 이력은 audit log에 기록됩니다.
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
            
            <div className="header-profile">
              <div className="profile-text">
                <span className="profile-name">
                  {activeTab === 'inbox' ? "김결재 부장" : activeTab === 'tracker' ? "운영자" : "설계자"}
                </span>
                <span className="profile-role">
                  {activeTab === 'inbox' ? "경영지원본부" : activeTab === 'tracker' ? "모니터링팀" : "프로세스설계팀"}
                </span>
              </div>
              <div className="profile-avatar-img">
                {activeTab === 'inbox' ? "👨‍💼" : activeTab === 'tracker' ? "👩‍💻" : "🧙‍♂️"}
              </div>
            </div>
          </div>
        </header>

        {/* Core Screen Rendering */}
        <main className="app-main-content">
          {activeTab === 'dashboard' && <DashboardPage />}
          
          {activeTab === 'designer' && (
            <div style={{ height: '100%' }}>
              <FlowDesigner 
                onSwitchToInbox={() => setActiveTab('inbox')}
                initialMonitorInstanceId={selectedInstanceId || undefined}
              />
            </div>
          )}

          {activeTab === 'request' && <RequestPortal />}

          {activeTab === 'tracker' && (
            <InstanceTracker onSelectInstance={handleSelectInstanceForTracking} />
          )}

          {activeTab === 'inbox' && (
            <InboxPage onSwitchToDesigner={() => setActiveTab('designer')} />
          )}

          {activeTab === 'credentials' && <CredentialsPage />}

          {activeTab === 'commands' && <CommandRegistryPage />}

          {activeTab === 'plugins' && <PluginControlPage />}

          {activeTab === 'pluginRegistry' && <PluginRegistryPage />}
        </main>
      </div>
    </div>
  );
}

export default App;
