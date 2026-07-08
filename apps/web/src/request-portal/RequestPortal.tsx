import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  FileText,
  GitBranch,
  Play,
  RefreshCw,
  Search,
  Trash2,
  Workflow,
} from 'lucide-react';
import { deleteInputPreset, type InputPreset, listInputPresets, saveInputPreset } from '../input-presets';
import './RequestPortal.css';

interface Template {
  id: string;
  name: string;
  description: string;
  group?: string;
  tags?: string[];
  version: number;
  nodes: any[];
  edges: any[];
  updated_at?: string;
  created_at?: string;
}

type StartFormField = {
  id?: string;
  name?: string;
  label?: string;
  type?: string;
  placeholder?: string;
  defaultValue?: any;
};

type FilterMode = 'all' | 'manual' | 'schedule' | 'db_watch' | 'approval';

type ScheduleStatus = {
  job: {
    id: string;
    status?: string | null;
    scheduleType: 'interval' | 'cron';
    intervalSeconds?: number | null;
    cronExpression?: string | null;
    nextRunAt?: string | Date | null;
    lastRunAt?: string | null;
    lastInstanceId?: string | null;
    lastError?: string | null;
    active: boolean;
  } | null;
  runs: Array<{
    id: string;
    instanceId?: string | null;
    scheduledFor: string;
    firedAt: string;
    status: 'STARTED' | 'FAILED';
    error?: string | null;
  }>;
};

export const RequestPortal: React.FC = () => {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null);
  const [formData, setFormData] = useState<Record<string, any>>({});
  const [presetVersion, setPresetVersion] = useState(0);
  const [selectedPresets, setSelectedPresets] = useState<InputPreset[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(false);
  const [successInstanceId, setSuccessInstanceId] = useState<string | null>(null);
  const [scheduleStatus, setScheduleStatus] = useState<ScheduleStatus | null>(null);
  const [scheduleStatusLoading, setScheduleStatusLoading] = useState(false);

  const fetchTemplates = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/templates');
      if (!res.ok) throw new Error('Failed to fetch templates');
      const data = await res.json();
      const validTemplates = Array.isArray(data) ? data : [];

      setTemplates(
        validTemplates.map((template: any, idx: number) => ({
          ...template,
          name: template.name || `Custom Workflow #${idx + 1}`,
          description: template.description || '설명 없음',
          tags: Array.isArray(template.tags) ? template.tags : [],
          nodes: Array.isArray(template.nodes) ? template.nodes : [],
          edges: Array.isArray(template.edges) ? template.edges : [],
        })),
      );
    } catch (error) {
      console.error('Failed to load templates:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTemplates();
  }, []);

  const summaries = useMemo(() => templates.map(buildTemplateSummary), [templates]);
  const selectedSummary = selectedTemplate ? buildTemplateSummary(selectedTemplate) : null;

  useEffect(() => {
    if (!selectedTemplate) {
      setSelectedPresets([]);
      return;
    }

    let cancelled = false;
    setPresetsLoading(true);
    listInputPresets(selectedTemplate.id)
      .then((items) => {
        if (!cancelled) setSelectedPresets(items);
      })
      .catch((error) => {
        console.error('Failed to load input presets:', error);
        if (!cancelled) setSelectedPresets([]);
      })
      .finally(() => {
        if (!cancelled) setPresetsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedTemplate, presetVersion]);

  const filteredTemplates = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return templates.filter((template) => {
      const summary = buildTemplateSummary(template);
      const matchesQuery =
        !normalizedQuery ||
        [
          template.name,
          template.description,
          template.group,
          ...(template.tags || []),
          template.id,
        ]
          .join(' ')
          .toLowerCase()
          .includes(normalizedQuery);

      const matchesFilter =
        filterMode === 'all' ||
        (filterMode === 'manual' && summary.triggerType === 'manual') ||
        (filterMode === 'schedule' && summary.triggerType === 'schedule') ||
        (filterMode === 'db_watch' && summary.triggerType === 'db_watch') ||
        (filterMode === 'approval' && summary.approvalNodes > 0);

      return matchesQuery && matchesFilter;
    });
  }, [filterMode, query, templates]);

  const metrics = useMemo(
    () => ({
      total: templates.length,
      schedule: summaries.filter((item) => item.triggerType === 'schedule').length,
      dbWatch: summaries.filter((item) => item.triggerType === 'db_watch').length,
      scheduleEnabled: summaries.filter((item) => item.scheduleEnabled).length,
      approval: summaries.filter((item) => item.approvalNodes > 0).length,
    }),
    [summaries, templates.length],
  );

  const handleOpenTemplate = (template: Template) => {
    setSelectedTemplate(template);
    setSuccessInstanceId(null);
    setScheduleStatus(null);
    setFormData(buildInitialInput(template));
    if (buildTemplateSummary(template).triggerType === 'schedule') {
      void fetchScheduleStatus(template.id);
    }
  };

  const handleInputChange = (key: string, value: any) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
  };

  const refreshPresets = () => setPresetVersion((current) => current + 1);

  const handleApplyPreset = (presetId: string) => {
    const preset = selectedPresets.find((item) => item.id === presetId);
    if (!preset) return;
    setFormData((current) => ({ ...current, ...preset.values }));
  };

  const handleSavePreset = async () => {
    if (!selectedTemplate) return;
    const name = prompt('파라미터 세트 이름을 입력하세요.');
    if (!name?.trim()) return;
    try {
      await saveInputPreset(selectedTemplate.id, name, formData);
      refreshPresets();
    } catch (error) {
      console.error('Failed to save input preset:', error);
      alert('파라미터 세트 저장에 실패했습니다.');
    }
  };

  const handleDeletePreset = async (presetId: string) => {
    const preset = selectedPresets.find((item) => item.id === presetId);
    if (!preset) return;
    if (!confirm(`파라미터 세트 "${preset.name}"을 삭제할까요?`)) return;
    if (!selectedTemplate) return;
    try {
      await deleteInputPreset(selectedTemplate.id, presetId);
      refreshPresets();
    } catch (error) {
      console.error('Failed to delete input preset:', error);
      alert('파라미터 세트 삭제에 실패했습니다.');
    }
  };

  const handleLaunch = async () => {
    if (!selectedTemplate) return;

    try {
      const res = await fetch(`/api/templates/${selectedTemplate.id}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'async', input: formData }),
      });

      if (!res.ok) throw new Error('Execution failed');
      const data = await res.json();
      setSuccessInstanceId(data.instance_id);
    } catch (error) {
      console.error('Failed to launch workflow:', error);
      alert('워크플로우 실행에 실패했습니다.');
    }
  };

  const handleToggleSchedule = async (enabled: boolean) => {
    if (!selectedTemplate) return;

    try {
      const res = await fetch(`/api/templates/${selectedTemplate.id}/schedule/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });

      if (!res.ok) throw new Error('Schedule toggle failed');
      const data = await res.json();
      const updated = data.template;

      setTemplates((current) =>
        current.map((template) => (template.id === updated.id ? updated : template)),
      );
      setSelectedTemplate(updated);
      setSuccessInstanceId(null);
      await fetchScheduleStatus(updated.id);
    } catch (error) {
      console.error('Failed to toggle schedule:', error);
      alert('스케줄 상태 변경에 실패했습니다.');
    }
  };

  const handleToggleDbWatch = async (enabled: boolean) => {
    if (!selectedTemplate) return;

    try {
      const res = await fetch(`/api/templates/${selectedTemplate.id}/db-watch/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });

      if (!res.ok) throw new Error('DB Watch toggle failed');
      const data = await res.json();
      const updated = data.template;

      setTemplates((current) =>
        current.map((template) => (template.id === updated.id ? updated : template)),
      );
      setSelectedTemplate(updated);
      setSuccessInstanceId(null);
    } catch (error) {
      console.error('Failed to toggle DB Watch:', error);
      alert('DB Watch 상태 변경에 실패했습니다.');
    }
  };

  const handleDeleteTemplate = async () => {
    if (!selectedTemplate) return;
    const confirmed = window.confirm(`워크플로우 "${selectedTemplate.name}"을 삭제할까요?`);
    if (!confirmed) return;

    try {
      const res = await fetch(`/api/templates/${selectedTemplate.id}`, {
        method: 'DELETE',
      });

      if (!res.ok) throw new Error('Template delete failed');

      setTemplates((current) => current.filter((template) => template.id !== selectedTemplate.id));
      setSelectedTemplate(null);
      setSuccessInstanceId(null);
      setScheduleStatus(null);
    } catch (error) {
      console.error('Failed to delete workflow:', error);
      alert('워크플로우 삭제에 실패했습니다.');
    }
  };

  const fetchScheduleStatus = async (templateId: string) => {
    setScheduleStatusLoading(true);
    try {
      const res = await fetch(`/api/templates/${templateId}/schedule/status`);
      if (!res.ok) throw new Error('Schedule status load failed');
      setScheduleStatus(await res.json());
    } catch (error) {
      console.error('Failed to load schedule status:', error);
      setScheduleStatus(null);
    } finally {
      setScheduleStatusLoading(false);
    }
  };

  return (
    <div className="request-portal">
      <div className="workflow-admin-header">
        <div>
          <div className="workflow-admin-title">
            <Workflow size={20} />
            <h2>워크플로우 관리</h2>
          </div>
          <p>배포된 워크플로우를 한눈에 보고, 트리거 상태와 구성을 확인하며 필요 시 수동 실행합니다.</p>
        </div>
        <button className="workflow-refresh-button" onClick={fetchTemplates} disabled={loading}>
          <RefreshCw size={15} />
          새로고침
        </button>
      </div>

      <div className="workflow-metrics">
        <MetricCard icon={<FileText size={18} />} label="전체 템플릿" value={metrics.total} />
        <MetricCard icon={<CalendarClock size={18} />} label="스케줄 타입" value={metrics.schedule} />
        <MetricCard icon={<Activity size={18} />} label="DB Watch 타입" value={metrics.dbWatch} />
        <MetricCard icon={<CheckCircle2 size={18} />} label="승인 포함" value={metrics.approval} />
      </div>

      <div className="workflow-admin-layout">
        <section className="workflow-list-panel">
          <div className="workflow-toolbar">
            <div className="workflow-search">
              <Search size={15} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="워크플로우명, 그룹, 태그 검색"
              />
            </div>
            <div className="workflow-filter-tabs">
              {[
                ['all', '전체'],
                ['manual', 'Manual/API'],
                ['schedule', 'Schedule'],
                ['db_watch', 'DB Watch'],
                ['approval', '승인 포함'],
              ].map(([value, label]) => (
                <button
                  key={value}
                  className={filterMode === value ? 'active' : ''}
                  onClick={() => setFilterMode(value as FilterMode)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="workflow-table-wrap">
            <table className="workflow-table">
              <thead>
                <tr>
                  <th>워크플로우</th>
                  <th>트리거</th>
                  <th>구성</th>
                  <th>그룹/태그</th>
                  <th>업데이트</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {loading && filteredTemplates.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="workflow-empty">템플릿 목록을 불러오는 중입니다.</td>
                  </tr>
                ) : filteredTemplates.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="workflow-empty">조건에 맞는 워크플로우가 없습니다.</td>
                  </tr>
                ) : (
                  filteredTemplates.map((template) => {
                    const summary = buildTemplateSummary(template);
                    return (
                      <tr
                        key={template.id}
                        className={selectedTemplate?.id === template.id ? 'selected' : ''}
                        onClick={() => handleOpenTemplate(template)}
                      >
                        <td>
                          <div className="workflow-name-cell">
                            <strong>{template.name}</strong>
                            <span>{template.description}</span>
                          </div>
                        </td>
                        <td>
                          <TriggerBadge summary={summary} />
                        </td>
                        <td>
                          <div className="workflow-structure">
                            <span>{summary.nodeCount} nodes</span>
                            <span>{summary.edgeCount} edges</span>
                          </div>
                        </td>
                        <td>
                          <div className="workflow-tags">
                            {template.group && <span>{template.group}</span>}
                            {(template.tags || []).slice(0, 2).map((tag) => (
                              <span key={tag}>{tag}</span>
                            ))}
                          </div>
                        </td>
                        <td>{formatDate(template.updated_at || template.created_at)}</td>
                        <td>
                          <button className="workflow-row-action" aria-label="상세 보기">
                            <ChevronRight size={15} />
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="workflow-detail-panel">
          {selectedTemplate && selectedSummary ? (
            <>
              <div className="detail-header">
                <div>
                  <span className="detail-kicker">Workflow Detail</span>
                  <h3>{selectedTemplate.name}</h3>
                </div>
                <TriggerBadge summary={selectedSummary} />
              </div>

              <div className="detail-grid">
                <DetailItem label="Template ID" value={selectedTemplate.id} mono />
                <DetailItem label="Version" value={`v${selectedTemplate.version || 1}`} />
                <DetailItem label="Nodes" value={String(selectedSummary.nodeCount)} />
                <DetailItem label="Edges" value={String(selectedSummary.edgeCount)} />
                <DetailItem label="Approval Nodes" value={String(selectedSummary.approvalNodes)} />
                <DetailItem label="Service Nodes" value={String(selectedSummary.serviceNodes)} />
              </div>

              {selectedSummary.triggerType === 'schedule' && (
                <div className="detail-section schedule-control-section">
                  <h4>스케줄 운영</h4>
                  <p className="form-info-text">
                    Flow Designer는 스케줄 조건만 정의합니다. 실제 반복 실행 활성화는 이 화면에서 관리합니다.
                  </p>
                  <ScheduleStatusSummary loading={scheduleStatusLoading} status={scheduleStatus} />
                  <button
                    className={`schedule-toggle-button ${selectedSummary.scheduleEnabled ? 'danger' : 'primary'}`}
                    onClick={() => handleToggleSchedule(!selectedSummary.scheduleEnabled)}
                  >
                    <CalendarClock size={14} />
                    {selectedSummary.scheduleEnabled ? '스케줄 비활성화' : '스케줄 활성화'}
                  </button>
                  <ScheduleRunList status={scheduleStatus} />
                </div>
              )}

              {selectedSummary.triggerType === 'db_watch' && (
                <div className="detail-section schedule-control-section">
                  <h4>DB Watch 운영</h4>
                  <p className="form-info-text">
                    활성화 상태에서는 저장된 database/collection 조건을 백그라운드에서 감시합니다.
                  </p>
                  <button
                    className={`schedule-toggle-button ${selectedSummary.dbWatchEnabled ? 'danger' : 'primary'}`}
                    onClick={() => handleToggleDbWatch(!selectedSummary.dbWatchEnabled)}
                  >
                    <Activity size={14} />
                    {selectedSummary.dbWatchEnabled ? 'DB Watch 비활성화' : 'DB Watch 활성화'}
                  </button>
                </div>
              )}

              <div className="detail-section">
                <h4>수동 실행</h4>
                {successInstanceId ? (
                  <div className="launch-success">
                    <CheckCircle2 size={40} className="success-icon" />
                    <strong>실행 요청 완료</strong>
                    <span>신규 인스턴스가 엔진 큐에 배정되었습니다.</span>
                    <code className="instance-id-code">{successInstanceId}</code>
                  </div>
                ) : (
                  <div className="launch-form">
                    <p className="form-info-text">
                      관리자가 테스트나 운영 조치 목적으로 이 워크플로우를 즉시 시작합니다.
                    </p>
                    <InputFields
                      template={selectedTemplate}
                      formData={formData}
                      onInputChange={handleInputChange}
                      presets={selectedPresets}
                      presetsLoading={presetsLoading}
                      onApplyPreset={handleApplyPreset}
                      onSavePreset={handleSavePreset}
                      onDeletePreset={handleDeletePreset}
                    />
                    <button className="btn-launch-execute" onClick={handleLaunch}>
                      <Play size={14} fill="currentColor" />
                      즉시 실행
                    </button>
                  </div>
                )}
              </div>

              <div className="detail-section danger-section">
                <h4>워크플로우 삭제</h4>
                <p className="form-info-text">
                  삭제하면 목록에서 제거되고 연결된 스케줄/DB Watch job도 비활성화됩니다.
                </p>
                <button className="workflow-delete-button" onClick={handleDeleteTemplate}>
                  <Trash2 size={14} />
                  워크플로우 삭제
                </button>
              </div>
            </>
          ) : (
            <div className="detail-empty">
              <GitBranch size={26} />
              <strong>워크플로우를 선택하세요.</strong>
              <span>목록에서 템플릿을 선택하면 구성과 실행 옵션을 확인할 수 있습니다.</span>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
};

function MetricCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
}) {
  return (
    <div className="metric-card">
      <div className="metric-icon">{icon}</div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function ScheduleStatusSummary({
  loading,
  status,
}: {
  loading: boolean;
  status: ScheduleStatus | null;
}) {
  if (loading) {
    return <div className="schedule-status-grid compact">스케줄 상태를 불러오는 중입니다.</div>;
  }
  if (!status?.job) {
    return <div className="schedule-status-grid compact">아직 저장된 스케줄 job이 없습니다.</div>;
  }

  const job = status.job;
  return (
    <div className="schedule-status-grid">
      <DetailItem label="Job Status" value={job.status || (job.active ? 'WAITING' : 'DISABLED')} />
      <DetailItem
        label="Schedule"
        value={job.scheduleType === 'interval' ? `${job.intervalSeconds || '-'} sec` : job.cronExpression || '-'}
      />
      <DetailItem label="Next Run" value={formatDateTime(job.nextRunAt)} />
      <DetailItem label="Last Run" value={formatDateTime(job.lastRunAt)} />
      <DetailItem label="Last Instance" value={job.lastInstanceId || '-'} mono />
      <DetailItem label="Last Error" value={job.lastError || '-'} />
    </div>
  );
}

function ScheduleRunList({ status }: { status: ScheduleStatus | null }) {
  const runs = status?.runs || [];
  return (
    <div className="schedule-run-list">
      <div className="schedule-run-title">최근 스케줄 실행</div>
      {runs.length === 0 ? (
        <div className="schedule-run-empty">아직 실행 이력이 없습니다.</div>
      ) : (
        runs.map((run) => (
          <div className="schedule-run-row" key={run.id}>
            <span className={`schedule-run-status ${run.status.toLowerCase()}`}>{run.status}</span>
            <div>
              <strong>{formatDateTime(run.firedAt)}</strong>
              <span>
                {run.instanceId ? `instance ${shortId(run.instanceId)}` : run.error || 'instance 없음'}
              </span>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function TriggerBadge({ summary }: { summary: ReturnType<typeof buildTemplateSummary> }) {
  if (summary.triggerType === 'schedule') {
    return (
      <span className={`trigger-badge ${summary.scheduleEnabled ? 'enabled' : 'disabled'}`}>
        Schedule {summary.scheduleEnabled ? 'On' : 'Off'}
      </span>
    );
  }
  if (summary.triggerType === 'db_watch') {
    return (
      <span className={`trigger-badge db-watch ${summary.dbWatchEnabled ? 'enabled' : 'disabled'}`}>
        DB Watch {summary.dbWatchEnabled ? 'On' : 'Off'}
      </span>
    );
  }
  return <span className="trigger-badge manual">Manual/API</span>;
}

function DetailItem({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="detail-item">
      <span>{label}</span>
      <strong className={mono ? 'mono' : ''}>{value}</strong>
    </div>
  );
}

function InputFields({
  template,
  formData,
  onInputChange,
  presets,
  presetsLoading,
  onApplyPreset,
  onSavePreset,
  onDeletePreset,
}: {
  template: Template;
  formData: Record<string, any>;
  onInputChange: (key: string, value: any) => void;
  presets: InputPreset[];
  presetsLoading: boolean;
  onApplyPreset: (presetId: string) => void;
  onSavePreset: () => void | Promise<void>;
  onDeletePreset: (presetId: string) => void | Promise<void>;
}) {
  const fields = getStartFields(template);
  if (fields.length === 0) {
    return (
      <div className="form-info-text">
        이 워크플로우에는 Start 입력 폼이 없습니다. 빈 input으로 실행됩니다.
      </div>
    );
  }

  return (
    <>
      <div className="request-input-preset-bar">
        <div className="request-input-preset-header">
          <div>
            <strong>파라미터 세트</strong>
            <span>현재 입력값을 저장하거나 불러옵니다.</span>
          </div>
          <button type="button" onClick={onSavePreset}>
            현재 값 저장
          </button>
        </div>
        {presetsLoading ? (
          <p className="request-input-preset-empty">파라미터 세트를 불러오는 중입니다.</p>
        ) : presets.length > 0 ? (
          <div className="request-input-preset-list">
            {presets.map((preset) => (
              <div key={preset.id} className="request-input-preset-item">
                <button type="button" onClick={() => onApplyPreset(preset.id)}>
                  {preset.name}
                </button>
                <button
                  type="button"
                  className="request-input-preset-delete"
                  onClick={() => onDeletePreset(preset.id)}
                  aria-label={`${preset.name} 삭제`}
                  title="삭제"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="request-input-preset-empty">저장된 파라미터 세트가 없습니다.</p>
        )}
      </div>
      {fields.map((field: any) => {
        const id = field.id || field.name;
        return (
          <div key={id} className="form-group">
            <label>{field.label || id}</label>
            <input
              type={field.type === 'number' ? 'number' : 'text'}
              placeholder={field.placeholder || `${field.label || id} 입력`}
              value={formData[id] || ''}
              onChange={(event) => onInputChange(id, event.target.value)}
            />
          </div>
        );
      })}
    </>
  );
}

function buildTemplateSummary(template: Template) {
  const startNode = (template.nodes || []).find((node) => node.data?.nodeType === 'start');
  const rawTriggerType = startNode?.data?.triggerType;
  const triggerType =
    rawTriggerType === 'schedule' || rawTriggerType === 'db_watch'
      ? rawTriggerType
      : 'manual';
  return {
    triggerType,
    scheduleEnabled: triggerType === 'schedule' && startNode?.data?.scheduleEnabled === true,
    dbWatchEnabled: triggerType === 'db_watch' && startNode?.data?.dbWatchEnabled === true,
    nodeCount: template.nodes?.length || 0,
    edgeCount: template.edges?.length || 0,
    approvalNodes: (template.nodes || []).filter((node) => node.data?.nodeType === 'approval').length,
    serviceNodes: (template.nodes || []).filter((node) => node.data?.nodeType === 'service').length,
  };
}

function buildInitialInput(template: Template) {
  const fields = getStartFields(template);
  if (fields.length === 0) return {};

  return fields.reduce((acc: Record<string, any>, field) => {
    const id = field.id || field.name;
    if (id) acc[id] = field.defaultValue || '';
    return acc;
  }, {});
}

function getStartFields(template: Template): StartFormField[] {
  const startNode = (template.nodes || []).find((node) => node.data?.nodeType === 'start');
  return Array.isArray(startNode?.data?.formSchema?.fields)
    ? startNode.data.formSchema.fields
    : [];
}

function formatDate(value?: string) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleDateString();
}

function formatDateTime(value?: string | Date | null) {
  if (!value) return '-';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString();
}

function shortId(value: string) {
  return value.length > 10 ? `${value.slice(0, 8)}...` : value;
}
