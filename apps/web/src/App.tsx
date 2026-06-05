import { useState } from 'react';
import { 
  LayoutGrid, 
  Paintbrush, 
  Rocket, 
  Search, 
  Inbox, 
  Settings, 
  FileText, 
  Bell, 
  HelpCircle
} from 'lucide-react';
import { DashboardPage } from './dashboard/DashboardPage';
import { FlowDesigner } from './flow-designer/FlowDesigner';
import { RequestPortal } from './request-portal/RequestPortal';
import { InstanceTracker } from './instance-tracker/InstanceTracker';
import { InboxPage } from './inbox/InboxPage';
import './App.css';

function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'designer' | 'request' | 'tracker' | 'inbox'>('inbox'); // 디폴트로 사용자가 원한 inbox를 켜둠
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);

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
            <span>업무 및 요청</span>
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
          
          <button className="sidebar-menu-item disabled">
            <Settings size={16} />
            <span>시스템 설정</span>
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
              {activeTab === 'request' && "업무 신청 런처"}
              {activeTab === 'tracker' && "운영자 / 모니터링 담당 상세 화면 구성"}
              {activeTab === 'inbox' && "내 결재함"}
            </h1>
            <p className="header-subtitle">
              {activeTab === 'dashboard' && "전체 워크플로우 실시간 상태 모니터링 및 주요 KPI 요약"}
              {activeTab === 'designer' && "프로세스 템플릿 설계, 배포, 관리 및 노드 속성 설정"}
              {activeTab === 'request' && "필요한 업무 프로세스를 신속하게 가동하고 요청을 전달합니다"}
              {activeTab === 'tracker' && "실행 모니터링, 실패 대응, 재시도/운영 조치 및 로그 분석"}
              {activeTab === 'inbox' && "승인 대기 Task 확인 및 처리"}
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
        </main>
      </div>
    </div>
  );
}

export default App;
