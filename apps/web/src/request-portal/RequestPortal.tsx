import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Ban,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Download,
  Edit3,
  FileText,
  GitBranch,
  GitCompare,
  History,
  Play,
  RefreshCw,
  Rocket,
  RotateCcw,
  Search,
  Trash2,
} from 'lucide-react';
import { type InputPreset, listInputPresets, saveInputPreset } from '../input-presets';
import { InputPresetManager } from '../input-presets/InputPresetManager';
import { authzApi, type PxmGroup } from '../api/authz';
import type { SessionUser } from '../api/session';
import './RequestPortal.css';
import { WorkflowAttribution } from '../flow-designer/WorkflowAttribution';
import { useFeedback } from '../components/feedback/feedback-context';
import { errorMessage } from '../lib/error-message';
import { templatesApi } from '../api/templates';
import type { WorkflowTemplate, WorkflowTemplateVersion, WorkflowVersionDiff } from '../api/templates';
import { Drawer } from '../components/ui/Drawer';
import { Button } from '../components/Button';

type Template = WorkflowTemplate;

type MetadataForm = {
  name: string;
  description: string;
  tags: string;
  groupId: string;
  versionNote: string;
};

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

export const RequestPortal: React.FC<{
  currentUser: SessionUser;
  onRequestStarted?: (instanceId: string) => void;
}> = ({ currentUser, onRequestStarted }) => {
  const { toast, confirm: confirmDialog, prompt: promptDialog } = useFeedback();
  const isRequester = currentUser.role === 'user';
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [groupFilter, setGroupFilter] = useState('all');
  const [groups, setGroups] = useState<PxmGroup[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null);
  const [formData, setFormData] = useState<Record<string, any>>({});
  const [presetVersion, setPresetVersion] = useState(0);
  const [selectedPresets, setSelectedPresets] = useState<InputPreset[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(false);
  const [presetManagerOpen, setPresetManagerOpen] = useState(false);
  const [successInstanceId, setSuccessInstanceId] = useState<string | null>(null);
  const [scheduleStatus, setScheduleStatus] = useState<ScheduleStatus | null>(null);
  const [scheduleStatusLoading, setScheduleStatusLoading] = useState(false);
  const [metadataEditorOpen, setMetadataEditorOpen] = useState(false);
  const [metadataSaving, setMetadataSaving] = useState(false);
  const [metadataForm, setMetadataForm] = useState<MetadataForm>({ name: '', description: '', tags: '', groupId: '', versionNote: '' });
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versions, setVersions] = useState<WorkflowTemplateVersion[]>([]);
  const [versionDiff, setVersionDiff] = useState<WorkflowVersionDiff | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState<string | null>(null);

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

  useEffect(() => {
    authzApi.listGroups(false).then((items) => setGroups(items.filter((item) => item.status === 'active'))).catch((error) => console.error('Failed to load groups:', error));
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
      const matchesGroup = groupFilter === 'all' || (groupFilter === 'unassigned' ? !template.group_id : template.group_id === groupFilter);

      return matchesQuery && matchesFilter && matchesGroup;
    });
  }, [filterMode, groupFilter, query, templates]);

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
    const name = await promptDialog({
      title: '파라미터 세트 저장',
      label: '세트 이름',
      placeholder: '예: 운영계 기본값',
      confirmLabel: '저장',
    });
    if (!name?.trim()) return;
    try {
      await saveInputPreset(selectedTemplate.id, name, formData, undefined, currentUser.role === 'user' ? 'private' : 'group');
      refreshPresets();
    } catch (error) {
      console.error('Failed to save input preset:', error);
      toast.error('파라미터 세트 저장에 실패했습니다.', { description: errorMessage(error) });
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
      onRequestStarted?.(data.instance_id);
    } catch (error) {
      console.error('Failed to launch workflow:', error);
      toast.error('워크플로우 실행에 실패했습니다.', { description: errorMessage(error) });
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
      toast.error('스케줄 상태 변경에 실패했습니다.', { description: errorMessage(error) });
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
      toast.error('DB Watch 상태 변경에 실패했습니다.', { description: errorMessage(error) });
    }
  };

  const applyTemplateUpdate = (updated: Template) => {
    setTemplates((current) => current.map((template) => (template.id === updated.id ? updated : template)));
    setSelectedTemplate(updated);
    setFormData(buildInitialInput(updated));
  };

  const handleLifecycle = async (action: 'publish' | 'disable' | 'reactivate') => {
    if (!selectedTemplate) return;
    const dialog = action === 'publish'
      ? {
          title: `v${selectedTemplate.version}을 배포할까요?`,
          description: '배포하면 이 버전이 API·수동 실행의 대상이 됩니다.',
          confirmLabel: '배포',
        }
      : action === 'disable'
        ? {
            title: '워크플로우 실행을 중지할까요?',
            description: '신규 API 실행과 자동 실행이 중지됩니다. 이미 진행 중인 인스턴스는 계속 처리됩니다.',
            confirmLabel: '중지',
            tone: 'danger' as const,
          }
        : {
            title: typeof selectedTemplate.active_published_version === 'number'
              ? `배포 버전 v${selectedTemplate.active_published_version}을 다시 활성화할까요?`
              : '기존 배포 버전을 다시 활성화할까요?',
            confirmLabel: '재활성화',
          };
    if (!(await confirmDialog(dialog))) return;
    try {
      const updated = await templatesApi[action](selectedTemplate.id);
      applyTemplateUpdate(updated);
      toast.success(action === 'publish' ? '워크플로우를 배포했습니다.' : action === 'disable' ? '워크플로우 실행을 중지했습니다.' : '워크플로우를 재활성화했습니다.');
    } catch (error) {
      console.error(`Failed to ${action} workflow:`, error);
      toast.error('배포 상태 변경에 실패했습니다.', { description: errorMessage(error) });
    }
  };

  const openMetadataEditor = () => {
    if (!selectedTemplate) return;
    setMetadataForm({
      name: selectedTemplate.name,
      description: selectedTemplate.description || '',
      tags: (selectedTemplate.tags || []).join(', '),
      groupId: selectedTemplate.group_id || '',
      versionNote: '',
    });
    setMetadataEditorOpen(true);
  };

  const handleSaveMetadata = async () => {
    if (!selectedTemplate || !metadataForm.name.trim() || !metadataForm.versionNote.trim()) return;
    const group = groups.find((item) => item.id === metadataForm.groupId);
    setMetadataSaving(true);
    try {
      const updated = await templatesApi.update(selectedTemplate.id, {
        name: metadataForm.name.trim(),
        description: metadataForm.description.trim(),
        tags: parseTags(metadataForm.tags),
        version_note: metadataForm.versionNote.trim(),
        ...(currentUser.role === 'admin' && group
          ? { group_id: group.id, group: group.name }
          : {}),
      });
      applyTemplateUpdate(updated);
      setMetadataEditorOpen(false);
      toast.success('워크플로우 메타데이터를 저장했습니다.', { description: `${updated.name} · v${updated.version}` });
    } catch (error) {
      console.error('Failed to update workflow metadata:', error);
      toast.error('메타데이터 저장에 실패했습니다.', { description: errorMessage(error) });
    } finally {
      setMetadataSaving(false);
    }
  };

  const handleExportTemplate = async () => {
    if (!selectedTemplate) return;
    try {
      const document = await templatesApi.export(selectedTemplate.id);
      downloadJson(document, `${safeFileName(document.workflow.name)}.pxm-workflow.json`);
      toast.success('워크플로우 파일을 내보냈습니다.', { description: `v${document.workflow.version || selectedTemplate.version}` });
    } catch (error) {
      console.error('Failed to export workflow:', error);
      toast.error('워크플로우 내보내기에 실패했습니다.', { description: errorMessage(error) });
    }
  };

  const loadVersions = async (template: Template) => {
    setVersionsLoading(true);
    setVersionsError(null);
    try {
      setVersions(await templatesApi.listVersions(template.id));
    } catch (error) {
      console.error('Failed to load workflow versions:', error);
      setVersionsError('버전 목록을 불러오지 못했습니다.');
    } finally {
      setVersionsLoading(false);
    }
  };

  const openVersionHistory = () => {
    if (!selectedTemplate) return;
    setVersionsOpen(true);
    setVersionDiff(null);
    void loadVersions(selectedTemplate);
  };

  const handleDiffVersion = async (version: number) => {
    if (!selectedTemplate) return;
    setVersionsLoading(true);
    setVersionsError(null);
    try {
      setVersionDiff(await templatesApi.diffVersions(selectedTemplate.id, version));
    } catch (error) {
      console.error('Failed to compare workflow versions:', error);
      setVersionsError('버전 비교에 실패했습니다.');
    } finally {
      setVersionsLoading(false);
    }
  };

  const handleRollbackVersion = async (version: number) => {
    if (!selectedTemplate) return;
    const confirmed = await confirmDialog({
      title: `v${version} 상태로 롤백할까요?`,
      description: `"${selectedTemplate.name}"의 v${version} 내용으로 새 버전이 만들어집니다. 기존 버전은 그대로 남습니다.`,
      confirmLabel: '롤백',
    });
    if (!confirmed) return;
    setVersionsLoading(true);
    try {
      const updated = await templatesApi.rollbackVersion(selectedTemplate.id, version);
      applyTemplateUpdate(updated);
      setVersionDiff(null);
      await loadVersions(updated);
      toast.success('롤백 버전을 만들었습니다.', { description: `v${version} 기준 → v${updated.version}` });
    } catch (error) {
      console.error('Failed to rollback workflow:', error);
      setVersionsError('롤백에 실패했습니다.');
    } finally {
      setVersionsLoading(false);
    }
  };

  const handleDeleteTemplate = async () => {
    if (!selectedTemplate) return;
    const confirmed = await confirmDialog({
      title: '워크플로우를 삭제할까요?',
      description: `"${selectedTemplate.name}"이(가) 목록에서 제거됩니다. 이 작업은 되돌릴 수 없습니다.`,
      confirmLabel: '삭제',
      tone: 'danger',
    });
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
      toast.error('워크플로우 삭제에 실패했습니다.', { description: errorMessage(error) });
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
          <p>{isRequester
            ? '필요한 요청을 선택하고 내용을 입력해 제출하세요.'
            : '배포된 워크플로우를 한눈에 보고, 트리거 상태와 구성을 확인하며 필요 시 수동 실행합니다.'}</p>
        </div>
        <button className="workflow-refresh-button" onClick={fetchTemplates} disabled={loading}>
          <RefreshCw size={15} />
          새로고침
        </button>
      </div>

      {!isRequester && <div className="workflow-metrics">
        <MetricCard icon={<FileText size={18} />} label="전체 템플릿" value={metrics.total} />
        <MetricCard icon={<CalendarClock size={18} />} label="스케줄 타입" value={metrics.schedule} />
        <MetricCard icon={<Activity size={18} />} label="DB Watch 타입" value={metrics.dbWatch} />
        <MetricCard icon={<CheckCircle2 size={18} />} label="승인 포함" value={metrics.approval} />
      </div>}

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
            {!isRequester && <div className="workflow-filter-tabs">
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
            </div>}
            <select className="workflow-group-filter" value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)} aria-label="관리 그룹 필터">
              <option value="all">모든 관리 그룹</option>
              {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
              {currentUser.role === 'admin' && <option value="unassigned">미지정 (Legacy)</option>}
            </select>
          </div>

          <div className="workflow-table-wrap">
            <table className="workflow-table">
              <thead>
                <tr>
                  <th>워크플로우</th>
                  {!isRequester && <th>트리거</th>}
                  {!isRequester && <th>구성</th>}
                  <th>관리 그룹</th>
                  <th>태그</th>
                  <th>업데이트</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {loading && filteredTemplates.length === 0 ? (
                  <tr>
                    <td colSpan={isRequester ? 5 : 7} className="workflow-empty">템플릿 목록을 불러오는 중입니다.</td>
                  </tr>
                ) : filteredTemplates.length === 0 ? (
                  <tr>
                    <td colSpan={isRequester ? 5 : 7} className="workflow-empty">조건에 맞는 워크플로우가 없습니다.</td>
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
                        {!isRequester && <td>
                          <TriggerBadge summary={summary} />
                        </td>}
                        {!isRequester && <td>
                          <div className="workflow-structure">
                            <span>노드 {summary.nodeCount}개</span>
                            <span>연결 {summary.edgeCount}개</span>
                          </div>
                        </td>}
                        <td>
                          <span className={`workflow-group-badge${template.group_id ? '' : ' legacy'}`}>{template.group || '미지정'}</span>
                        </td>
                        <td>
                          <div className="workflow-tags">
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
                  <span className="detail-kicker">{isRequester ? '요청 상세' : 'Workflow Detail'}</span>
                  <h3>{selectedTemplate.name}</h3>
                </div>
                {!isRequester && <TriggerBadge summary={selectedSummary} />}
              </div>

              {isRequester ? (
                <p className="form-info-text">{selectedTemplate.description || '요청 내용을 입력해 신청할 수 있습니다.'}</p>
              ) : (
                <div className="detail-grid">
                  <DetailItem label="Template ID" value={selectedTemplate.id} mono />
                  <DetailItem label="Version" value={`v${selectedTemplate.version || 1}`} />
                  <DetailItem label="배포 버전" value={selectedTemplate.active_published_version ? `v${selectedTemplate.active_published_version}` : '없음'} />
                  <DetailItem label="운영 상태" value={workflowLifecycleLabel(selectedTemplate)} />
                  <DetailItem label="Nodes" value={String(selectedSummary.nodeCount)} />
                  <DetailItem label="Edges" value={String(selectedSummary.edgeCount)} />
                  <DetailItem label="Approval Nodes" value={String(selectedSummary.approvalNodes)} />
                  <DetailItem label="Service Nodes" value={String(selectedSummary.serviceNodes)} />
                </div>
              )}

              {!isRequester && <div className="detail-section workflow-management-section">
                <div className="workflow-management-heading">
                  <div>
                    <h4>워크플로우 관리</h4>
                    <p className="form-info-text">설계 저장과 별도로 배포 상태, 메타데이터와 버전을 관리합니다.</p>
                  </div>
                  {selectedTemplate.has_unpublished_changes && <span className="workflow-unpublished-badge">미배포 변경</span>}
                </div>
                <div className="workflow-management-actions">
                  {(selectedTemplate.lifecycle_status === 'DRAFT' || selectedTemplate.has_unpublished_changes) && (
                    <Button size="sm" onClick={() => void handleLifecycle('publish')} icon={<Rocket size={14} />}>
                      v{selectedTemplate.version} 배포
                    </Button>
                  )}
                  {selectedTemplate.lifecycle_status === 'PUBLISHED' && !selectedTemplate.has_unpublished_changes && (
                    <Button size="sm" variant="secondary" onClick={() => void handleLifecycle('disable')} icon={<Ban size={14} />}>
                      배포 중지
                    </Button>
                  )}
                  {selectedTemplate.lifecycle_status === 'DISABLED' && (
                    <Button size="sm" variant="secondary" onClick={() => void handleLifecycle('reactivate')} icon={<Rocket size={14} />}>
                      재활성화
                    </Button>
                  )}
                  <Button size="sm" variant="secondary" onClick={openMetadataEditor} icon={<Edit3 size={14} />}>
                    메타데이터 수정
                  </Button>
                  <Button size="sm" variant="secondary" onClick={openVersionHistory} icon={<History size={14} />}>
                    버전 이력
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => void handleExportTemplate()} icon={<Download size={14} />}>
                    파일로 내보내기
                  </Button>
                </div>
              </div>}

              {!isRequester && <WorkflowAttribution workflowId={selectedTemplate.id} updatedAt={selectedTemplate.updated_at} />}

              {!isRequester && <div className="detail-section workflow-group-section">
                <h4>관리 그룹</h4>
                <div className="workflow-group-readonly">{selectedTemplate.group || '미지정'}<small>{selectedTemplate.group_id || 'Legacy workflow'}</small></div>
                {currentUser.role === 'admin' && <p className="form-info-text">그룹 변경은 위의 메타데이터 수정에서 새 버전으로 저장합니다.</p>}
              </div>}

              {!isRequester && selectedSummary.triggerType === 'schedule' && (
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

              {!isRequester && selectedSummary.triggerType === 'db_watch' && (
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
                <h4>{isRequester ? '요청 내용' : '수동 실행'}</h4>
                {successInstanceId ? (
                  <div className="launch-success">
                    <CheckCircle2 size={40} className="success-icon" />
                    <strong>실행 요청 완료</strong>
                    <span>신규 인스턴스가 엔진 큐에 배정되었습니다.</span>
                    <code className="instance-id-code">{successInstanceId}</code>
                  </div>
                ) : (
                  <div className="launch-form">
                    <p className="form-info-text">{isRequester
                      ? '필요한 내용을 입력하고 요청을 제출하세요.'
                      : '관리자가 테스트나 운영 조치 목적으로 이 워크플로우를 즉시 시작합니다.'}</p>
                    <InputFields
                      template={selectedTemplate}
                      formData={formData}
                      onInputChange={handleInputChange}
                      presets={selectedPresets}
                      presetsLoading={presetsLoading}
                      onApplyPreset={handleApplyPreset}
                      onSavePreset={handleSavePreset}
                      onManagePresets={() => currentUser.role === 'user'
                        ? setPresetManagerOpen(true)
                        : (window.location.hash = `#/presets?workflow=${encodeURIComponent(selectedTemplate.id)}`)}
                    />
                    <button className="btn-launch-execute" onClick={handleLaunch}>
                      <Play size={14} fill="currentColor" />
                      {isRequester ? '요청 제출' : '즉시 실행'}
                    </button>
                  </div>
                )}
              </div>

              {currentUser.role === 'admin' && <div className="detail-section danger-section">
                <h4>워크플로우 삭제</h4>
                <p className="form-info-text">
                  삭제하면 목록에서 제거되고 연결된 스케줄/DB Watch job도 비활성화됩니다.
                </p>
                <button className="workflow-delete-button" onClick={handleDeleteTemplate}>
                  <Trash2 size={14} />
                  워크플로우 삭제
                </button>
              </div>}
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
      {selectedTemplate && (
        <InputPresetManager
          open={presetManagerOpen}
          workflowId={selectedTemplate.id}
          presets={selectedPresets}
          onClose={() => setPresetManagerOpen(false)}
          onChanged={refreshPresets}
        />
      )}
      {selectedTemplate && metadataEditorOpen && (
        <Drawer
          title="워크플로우 메타데이터 수정"
          eyebrow={`${selectedTemplate.name} · v${selectedTemplate.version}`}
          width="md"
          className="workflow-management-drawer"
          closeOnBackdrop={false}
          onClose={() => setMetadataEditorOpen(false)}
          footer={<>
            <Button variant="secondary" onClick={() => setMetadataEditorOpen(false)}>취소</Button>
            <Button
              onClick={() => void handleSaveMetadata()}
              disabled={metadataSaving || !metadataForm.name.trim() || !metadataForm.versionNote.trim()}
            >
              {metadataSaving ? '저장 중…' : '새 버전으로 저장'}
            </Button>
          </>}
        >
          <div className="workflow-metadata-form">
            <p className="workflow-drawer-intro">이름·설명·태그 변경도 워크플로우 이력에 남도록 새 버전으로 저장됩니다. 노드와 연결은 변경하지 않습니다.</p>
            <label>
              <span>이름 <b>필수</b></span>
              <input value={metadataForm.name} onChange={(event) => setMetadataForm((current) => ({ ...current, name: event.target.value }))} />
            </label>
            <label>
              <span>설명</span>
              <textarea rows={4} value={metadataForm.description} onChange={(event) => setMetadataForm((current) => ({ ...current, description: event.target.value }))} />
            </label>
            <label>
              <span>태그</span>
              <input value={metadataForm.tags} onChange={(event) => setMetadataForm((current) => ({ ...current, tags: event.target.value }))} placeholder="쉼표로 구분" />
            </label>
            <label>
              <span>관리 그룹</span>
              {currentUser.role === 'admin' ? (
                <select value={metadataForm.groupId} onChange={(event) => setMetadataForm((current) => ({ ...current, groupId: event.target.value }))}>
                  <option value="" disabled>관리 그룹을 선택하세요</option>
                  {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                </select>
              ) : (
                <div className="workflow-metadata-readonly">{selectedTemplate.group || '미지정'}<small>{selectedTemplate.group_id || 'Legacy workflow'}</small></div>
              )}
            </label>
            <label>
              <span>변경 메모 <b>필수</b></span>
              <textarea
                rows={3}
                value={metadataForm.versionNote}
                onChange={(event) => setMetadataForm((current) => ({ ...current, versionNote: event.target.value }))}
                placeholder="예: 발표용 설명과 태그 정리"
              />
              <small>저장 후 Version Note와 Export 파일에 기록됩니다.</small>
            </label>
          </div>
        </Drawer>
      )}
      {selectedTemplate && versionsOpen && (
        <Drawer
          title="워크플로우 버전 이력"
          eyebrow={`${selectedTemplate.name} · 현재 v${selectedTemplate.version}`}
          width="lg"
          className="workflow-management-drawer"
          onClose={() => setVersionsOpen(false)}
        >
          <div className="workflow-version-drawer">
            <p className="workflow-drawer-intro">이전 저장본을 현재 버전과 비교합니다. 롤백해도 기존 이력은 지워지지 않고 새 버전이 만들어집니다.</p>
            {versionsLoading && <p className="workflow-version-state">처리 중…</p>}
            {versionsError && <p className="workflow-version-error" role="status">{versionsError}</p>}
            <div className="workflow-version-list">
              {versions.map((item) => (
                <div className="workflow-version-row" key={item.version}>
                  <div>
                    <div className="workflow-version-title">
                      v{item.version}
                      {item.version === selectedTemplate.version && <span>현재</span>}
                      {item.version === selectedTemplate.active_published_version && <span className="published">배포</span>}
                    </div>
                    <p>{item.node_count} 노드 · {item.edge_count} 연결{item.created_at ? ` · ${formatDateTime(item.created_at)}` : ''}</p>
                    {item.version_note && <strong>{item.version_note}</strong>}
                  </div>
                  <div className="workflow-version-actions">
                    <Button size="sm" variant="secondary" onClick={() => void handleDiffVersion(item.version)} icon={<GitCompare size={14} />}>
                      비교
                    </Button>
                    {item.version !== selectedTemplate.version && (
                      <Button size="sm" variant="ghost" onClick={() => void handleRollbackVersion(item.version)} icon={<RotateCcw size={14} />}>
                        롤백
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {versionDiff && (
              <section className="workflow-version-diff" aria-label="버전 비교 결과">
                <header><strong>v{versionDiff.from_version} → v{versionDiff.to_version ?? selectedTemplate.version}</strong><span>{versionDiff.changes.length}개 변경</span></header>
                {versionDiff.changes.length === 0 ? <p>변경 사항이 없습니다.</p> : versionDiff.changes.slice(0, 50).map((change, index) => (
                  <div className="workflow-version-change" key={`${change.path}-${index}`}>
                    <span className={change.type}>{change.type}</span>
                    <code>{change.path}</code>
                  </div>
                ))}
              </section>
            )}
          </div>
        </Drawer>
      )}
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
  onManagePresets,
}: {
  template: Template;
  formData: Record<string, any>;
  onInputChange: (key: string, value: any) => void;
  presets: InputPreset[];
  presetsLoading: boolean;
  onApplyPreset: (presetId: string) => void;
  onSavePreset: () => void | Promise<void>;
  onManagePresets: () => void;
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
            <span>저장된 Start 입력값을 아래 폼에 적용합니다.</span>
          </div>
          <div className="request-input-preset-actions">
            <button type="button" className="secondary" onClick={onManagePresets}>프리셋 관리</button>
          </div>
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
              onChange={(event) => onInputChange(id, field.type === 'number' && event.target.value !== '' ? Number(event.target.value) : event.target.value)}
            />
          </div>
        );
      })}
      <div className="request-input-preset-save">
        <span>위 입력값을 다음 API 실행에서도 재사용할 수 있습니다.</span>
        <button type="button" onClick={onSavePreset}>입력값을 새 프리셋으로 저장</button>
      </div>
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

function parseTags(value: string) {
  return value.split(',').map((tag) => tag.trim()).filter(Boolean);
}

function workflowLifecycleLabel(template: Template) {
  if (template.lifecycle_status === 'DISABLED') return '배포 중지';
  if (template.lifecycle_status === 'DRAFT') return '초안';
  return template.has_unpublished_changes ? '배포됨 · 미배포 변경' : '배포됨';
}

function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function safeFileName(value: string) {
  const trimmed = value.trim().replace(/[^a-zA-Z0-9가-힣._-]+/g, '-').replace(/^-+|-+$/g, '');
  return trimmed || 'workflow';
}
