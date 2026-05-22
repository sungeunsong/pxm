import React, { useEffect, useState } from 'react';
import { Rocket, ChevronRight, Play, FileText, CheckCircle2 } from 'lucide-react';
import './RequestPortal.css';

interface Template {
  id: string;
  name: string;
  description: string;
  version: number;
  nodes: any[];
  edges: any[];
}

export const RequestPortal: React.FC = () => {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null);
  const [formData, setFormData] = useState<Record<string, any>>({});
  const [successInstanceId, setSuccessInstanceId] = useState<string | null>(null);

  // 템플릿 목록 로드
  const fetchTemplates = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/templates');
      if (!res.ok) throw new Error('Failed to fetch templates');
      const data = await res.json();
      
      // 혹시 비어 있다면 디폴트 예시 템플릿 시딩 (동적 폼 실감 렌더링을 위해)
      const validTemplates = Array.isArray(data) ? data : [];
      
      if (validTemplates.length === 0) {
        setTemplates([
          {
            id: 'demo-1',
            name: 'HR Onboarding Process',
            description: '신입 사원의 온보딩 승인 및 Slack 채널 자동 초대 프로세스',
            version: 1,
            nodes: [
              { id: '1', data: { label: 'Start', nodeType: 'start' } },
              { id: '2', data: { label: 'Manager Approve', nodeType: 'approval' } },
              { id: '3', data: { label: 'Slack Invite', nodeType: 'service' } },
              { id: '4', data: { label: 'End', nodeType: 'end' } },
            ],
            edges: []
          },
          {
            id: 'demo-2',
            name: 'IT Access & VM Allocation',
            description: '개발자 계정 권한 승인 및 가상머신 프로비저닝 워크플로우',
            version: 2,
            nodes: [],
            edges: []
          }
        ]);
      } else {
        // 이름이 누락된 더미 데이터가 있으면 보정하여 출력
        const normalized = validTemplates.map((t: any, idx: number) => ({
          ...t,
          name: t.name || `Custom Workflow #${idx + 1}`,
          description: t.description || '이 템플릿에 대한 설명이 준비되어 있습니다.',
        }));
        setTemplates(normalized);
      }
    } catch (error) {
      console.error('Failed to load templates:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTemplates();
  }, []);

  const handleOpenLaunchDrawer = (template: Template) => {
    setSelectedTemplate(template);
    setSuccessInstanceId(null);
    
    // 폼 초기화 ( Start 노드의 폼 스키마 형태를 흉내 냄 )
    const initialFields: Record<string, any> = {
      requesterName: '',
      department: 'Development',
      purpose: '',
    };
    
    // 템플릿 노드들 중 start 노드가 지닌 formSchema가 있다면 매핑
    const startNode = template.nodes.find(n => n.data?.nodeType === 'start');
    if (startNode?.data?.formSchema?.fields) {
      startNode.data.formSchema.fields.forEach((f: any) => {
        initialFields[f.name] = f.defaultValue || '';
      });
    }

    setFormData(initialFields);
  };

  const handleInputChange = (key: string, value: any) => {
    setFormData(prev => ({ ...prev, [key]: value }));
  };

  const handleLaunch = async () => {
    if (!selectedTemplate) return;

    try {
      const res = await fetch(`/api/templates/${selectedTemplate.id}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ formData }),
      });

      if (!res.ok) throw new Error('Execution failed');
      const data = await res.json();
      
      setSuccessInstanceId(data.instance_id);
    } catch (error) {
      console.error('Failed to launch workflow:', error);
      alert('워크플로우 실행 기동에 실패했습니다.');
    }
  };

  return (
    <div className="request-portal">
      <div className="portal-header-title">
        <Rocket size={20} className="header-icon" />
        <h2>신청 런처 포털 <span className="neon-badge">LAUNCHER</span></h2>
      </div>

      <div className="portal-layout">
        {/* TEMPLATES GRID */}
        <div className="templates-grid-section">
          {loading && templates.length === 0 ? (
            <div className="loading-state">템플릿 목록을 불러오는 중입니다...</div>
          ) : templates.length === 0 ? (
            <div className="empty-state">신청 가능한 액티브 템플릿이 없습니다.</div>
          ) : (
            <div className="templates-grid">
              {templates.map(tmpl => (
                <div key={tmpl.id} className="template-card">
                  <div className="card-top">
                    <div className="version-tag">v{tmpl.version}</div>
                    <FileText className="template-icon" size={24} />
                  </div>
                  <div className="card-body">
                    <h3>{tmpl.name}</h3>
                    <p>{tmpl.description}</p>
                  </div>
                  <div className="card-footer">
                    <button className="btn-launch-open" onClick={() => handleOpenLaunchDrawer(tmpl)}>
                      신청 기동하기 <ChevronRight size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* LAUNCH DRAWER/DRAWER SECTION */}
        {selectedTemplate && (
          <div className="launch-drawer">
            <div className="drawer-header">
              <h3>워크플로우 기동 설정</h3>
              <span className="drawer-template-name">{selectedTemplate.name}</span>
            </div>

            <div className="drawer-body">
              {successInstanceId ? (
                <div className="launch-success">
                  <CheckCircle2 size={48} className="success-icon" />
                  <h4>기동 성공!</h4>
                  <p>신규 인스턴스가 엔진 큐에 배정되었습니다.</p>
                  <code className="instance-id-code">ID: {successInstanceId}</code>
                  <button className="btn-success-close" onClick={() => setSelectedTemplate(null)}>
                    확인 및 닫기
                  </button>
                </div>
              ) : (
                <div className="launch-form">
                  <p className="form-info-text">이 워크플로우를 가동하기 위한 기본 실행 변수 정보를 기입해 주십시오.</p>

                  <div className="form-group">
                    <label>신청자 성명</label>
                    <input 
                      type="text" 
                      placeholder="성명을 입력하세요" 
                      value={formData.requesterName || ''}
                      onChange={(e) => handleInputChange('requesterName', e.target.value)}
                    />
                  </div>

                  <div className="form-group">
                    <label>소속 부서</label>
                    <select 
                      value={formData.department || 'Development'}
                      onChange={(e) => handleInputChange('department', e.target.value)}
                    >
                      <option value="Development">개발 부서 (Development)</option>
                      <option value="HR">인사 부서 (HR Team)</option>
                      <option value="Legal">법무 부서 (Legal Dept)</option>
                      <option value="Sales">영업 부서 (Sales Team)</option>
                    </select>
                  </div>

                  <div className="form-group">
                    <label>신청 및 기동 사유</label>
                    <textarea 
                      rows={4}
                      placeholder="신청 사유를 상세 기입하십시오" 
                      value={formData.purpose || ''}
                      onChange={(e) => handleInputChange('purpose', e.target.value)}
                    />
                  </div>

                  {/* 동적 폼 필드가 추가적으로 존재할 경우 렌더링 */}
                  {selectedTemplate.nodes.find(n => n.data?.nodeType === 'start')?.data?.formSchema?.fields?.map((field: any) => {
                    if (['requesterName', 'department', 'purpose'].includes(field.name)) return null;
                    return (
                      <div key={field.name} className="form-group">
                        <label>{field.label || field.name}</label>
                        <input 
                          type="text"
                          placeholder={`${field.label || field.name}을(를) 입력하십시오`}
                          value={formData[field.name] || ''}
                          onChange={(e) => handleInputChange(field.name, e.target.value)}
                        />
                      </div>
                    );
                  })}

                  <div className="drawer-footer">
                    <button className="btn-cancel" onClick={() => setSelectedTemplate(null)}>취소</button>
                    <button className="btn-launch-execute" onClick={handleLaunch}>
                      <Play size={14} fill="currentColor" /> 가동하기 (Launch)
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
