import React, { useEffect, useState } from 'react';
import { templatesApi } from '../api/templates';
import type { WorkflowTemplate, WorkflowTemplateVersion, WorkflowVersionDiff } from '../api/templates';
import { Button } from '../components/Button';
import { X, FileText, Calendar, Hash, Copy, GitCompare, RotateCcw } from 'lucide-react';
import './TemplateListModal.css';

export interface TemplateListModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (template: WorkflowTemplate) => void;
  allowedGroupIds?: string[];
}

export const TemplateListModal: React.FC<TemplateListModalProps> = ({
  isOpen,
  onClose,
  onSelect,
  allowedGroupIds,
}) => {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [versionTemplate, setVersionTemplate] = useState<WorkflowTemplate | null>(null);
  const [versions, setVersions] = useState<WorkflowTemplateVersion[]>([]);
  const [versionDiff, setVersionDiff] = useState<WorkflowVersionDiff | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const allowedGroupKey = allowedGroupIds?.join(',');

  useEffect(() => {
    if (isOpen) {
      loadTemplates();
    }
  }, [isOpen, allowedGroupKey]);

  const loadTemplates = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await templatesApi.list(true);
      setTemplates(allowedGroupIds ? data.filter((template) => template.group_id && allowedGroupIds.includes(template.group_id)) : data);
    } catch (err) {
      console.error('Failed to load templates:', err);
      setError('템플릿 목록을 불러오는데 실패했습니다.');
    } finally {
      setLoading(false);
    }
  };

  const handleSelect = (template: WorkflowTemplate) => {
    onSelect(template);
    onClose();
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`"${name}" 템플릿을 삭제하시겠습니까?`)) {
      return;
    }

    try {
      await templatesApi.delete(id);
      setTemplates(templates.filter((t) => t.id !== id));
    } catch (err) {
      console.error('Failed to delete template:', err);
      alert('템플릿 삭제에 실패했습니다.');
    }
  };

  const handleCopyId = async (event: React.MouseEvent, id: string) => {
    event.stopPropagation();
    await navigator.clipboard.writeText(id);
  };

  const handleShowVersions = async (event: React.MouseEvent, template: WorkflowTemplate) => {
    event.stopPropagation();
    setVersionTemplate(template);
    setVersionDiff(null);
    setVersionsLoading(true);
    setVersionsError(null);
    try {
      const data = await templatesApi.listVersions(template.id);
      setVersions(data);
    } catch (err) {
      console.error('Failed to load template versions:', err);
      setVersionsError('버전 목록을 불러오는데 실패했습니다.');
    } finally {
      setVersionsLoading(false);
    }
  };

  const handleDiffVersion = async (event: React.MouseEvent, version: number) => {
    event.stopPropagation();
    if (!versionTemplate) return;

    setVersionsLoading(true);
    setVersionsError(null);
    try {
      const diff = await templatesApi.diffVersions(versionTemplate.id, version);
      setVersionDiff(diff);
    } catch (err) {
      console.error('Failed to diff template versions:', err);
      setVersionsError('버전 비교에 실패했습니다.');
    } finally {
      setVersionsLoading(false);
    }
  };

  const handleRollbackVersion = async (event: React.MouseEvent, version: number) => {
    event.stopPropagation();
    if (!versionTemplate) return;
    if (!confirm(`"${versionTemplate.name}" 템플릿을 v${version} 상태로 롤백하시겠습니까? 새 버전으로 저장됩니다.`)) {
      return;
    }

    setVersionsLoading(true);
    setVersionsError(null);
    try {
      const updated = await templatesApi.rollbackVersion(versionTemplate.id, version);
      setTemplates((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      setVersionTemplate(updated);
      setVersions(await templatesApi.listVersions(updated.id));
      setVersionDiff(null);
      onSelect(updated);
      alert(`v${version} 기준으로 v${updated.version} 롤백 버전이 생성되었습니다.`);
    } catch (err) {
      console.error('Failed to rollback template version:', err);
      setVersionsError('롤백에 실패했습니다.');
    } finally {
      setVersionsLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">템플릿 불러오기</h2>
          <button className="modal-close" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className="modal-body">
          {loading && (
            <div className="template-loading">
              <p>템플릿 목록을 불러오는 중...</p>
            </div>
          )}

          {error && (
            <div className="template-error">
              <p>{error}</p>
              <Button onClick={loadTemplates} variant="secondary" size="sm">
                다시 시도
              </Button>
            </div>
          )}

          {!loading && !error && templates.length === 0 && (
            <div className="template-empty">
              <FileText size={48} />
              <p>저장된 템플릿이 없습니다.</p>
              <p className="text-secondary">워크플로우를 만들고 저장해보세요.</p>
            </div>
          )}

          {!loading && !error && templates.length > 0 && (
            <div className="template-list">
              {templates.map((template) => (
                <div
                  key={template.id}
                  className={`template-item-group ${versionTemplate?.id === template.id ? 'is-expanded' : ''}`}
                >
                  <div className={`template-item ${versionTemplate?.id === template.id ? 'is-selected' : ''}`}>
                    <div className="template-info" onClick={() => handleSelect(template)}>
                      <div className="template-header">
                        <h3 className="template-name">{template.name}</h3>
                        <span className="template-version">v{template.version}</span>
                      </div>
                      {template.description && (
                        <p className="template-description">{template.description}</p>
                      )}
                      <div className="template-id-row">
                        <span className="template-id-label">Template ID</span>
                        <code className="template-id-value">{template.id}</code>
                        <button
                          type="button"
                          className="id-copy-button"
                          onClick={(event) => handleCopyId(event, template.id)}
                          title="Template ID 복사"
                          aria-label="Template ID 복사"
                        >
                          <Copy size={13} />
                        </button>
                      </div>
                      <div className="template-meta">
                        <span className="template-meta-item">
                          <Hash size={14} />
                          {template.nodes.length} 노드
                        </span>
                        <span className="template-meta-item">
                          <Calendar size={14} />
                          {new Date(template.created_at).toLocaleDateString('ko-KR')}
                        </span>
                      </div>
                    </div>
                    <div className="template-actions">
                      <Button
                        onClick={() => handleSelect(template)}
                        variant="primary"
                        size="sm"
                      >
                        불러오기
                      </Button>
                      <Button
                        onClick={(event) => handleShowVersions(event, template)}
                        variant="secondary"
                        size="sm"
                      >
                        버전
                      </Button>
                      <Button
                        onClick={() => handleDelete(template.id, template.name)}
                        variant="ghost"
                        size="sm"
                      >
                        삭제
                      </Button>
                    </div>
                  </div>
                  {versionTemplate?.id === template.id && (
                    <TemplateVersionPanel
                      versionTemplate={versionTemplate}
                      versions={versions}
                      versionDiff={versionDiff}
                      versionsLoading={versionsLoading}
                      versionsError={versionsError}
                      onClose={() => {
                        setVersionTemplate(null);
                        setVersions([]);
                        setVersionDiff(null);
                        setVersionsError(null);
                      }}
                      onDiffVersion={handleDiffVersion}
                      onRollbackVersion={handleRollbackVersion}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <Button onClick={onClose} variant="secondary">
            닫기
          </Button>
        </div>
      </div>
    </div>
  );
};

function TemplateVersionPanel({
  versionTemplate,
  versions,
  versionDiff,
  versionsLoading,
  versionsError,
  onClose,
  onDiffVersion,
  onRollbackVersion,
}: {
  versionTemplate: WorkflowTemplate;
  versions: WorkflowTemplateVersion[];
  versionDiff: WorkflowVersionDiff | null;
  versionsLoading: boolean;
  versionsError: string | null;
  onClose: () => void;
  onDiffVersion: (event: React.MouseEvent, version: number) => void;
  onRollbackVersion: (event: React.MouseEvent, version: number) => void;
}) {
  return (
    <div className="template-version-panel">
      <div className="template-version-panel-header">
        <div>
          <h3>{versionTemplate.name} 버전</h3>
          <p>현재 v{versionTemplate.version}</p>
        </div>
        <button
          type="button"
          className="template-version-panel-close"
          onClick={onClose}
          aria-label="버전 패널 닫기"
        >
          <X size={16} />
        </button>
      </div>

      {versionsLoading && <p className="template-version-state">처리 중...</p>}
      {versionsError && <p className="template-version-error">{versionsError}</p>}

      <div className="template-version-list">
        {versions.map((item) => (
          <div key={item.version} className="template-version-row">
            <div>
              <div className="template-version-row-title">
                v{item.version}
                {item.version === versionTemplate.version && (
                  <span className="template-version-current">현재</span>
                )}
              </div>
              <div className="template-version-row-meta">
                {item.node_count} 노드 · {item.edge_count} 엣지
                {item.created_at ? ` · ${new Date(item.created_at).toLocaleString('ko-KR')}` : ''}
              </div>
              {item.version_note && (
                <div className="template-version-note">{item.version_note}</div>
              )}
            </div>
            <div className="template-version-actions">
              <button
                type="button"
                className="template-version-icon-button"
                onClick={(event) => onDiffVersion(event, item.version)}
                title="현재 버전과 비교"
                aria-label="현재 버전과 비교"
              >
                <GitCompare size={15} />
                <span>비교</span>
              </button>
              {item.version !== versionTemplate.version && (
                <button
                  type="button"
                  className="template-version-icon-button"
                  onClick={(event) => onRollbackVersion(event, item.version)}
                  title="이 버전으로 롤백"
                  aria-label="이 버전으로 롤백"
                >
                  <RotateCcw size={15} />
                  <span>롤백</span>
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {versionDiff && (
        <div className="template-version-diff">
          <div className="template-version-diff-header">
            <span>v{versionDiff.from_version} → v{versionDiff.to_version ?? versionTemplate.version}</span>
            <span>{versionDiff.changes.length} changes</span>
          </div>
          <div className="template-version-diff-list">
            {versionDiff.changes.length === 0 ? (
              <p>변경 사항이 없습니다.</p>
            ) : (
              versionDiff.changes.slice(0, 40).map((change, index) => (
                <div key={`${change.path}-${index}`} className="template-version-diff-row">
                  <span className={`template-version-diff-type ${change.type}`}>{change.type}</span>
                  <code>{change.path}</code>
                </div>
              ))
            )}
            {versionDiff.changes.length > 40 && (
              <p className="template-version-diff-more">
                나머지 {versionDiff.changes.length - 40}개 변경은 API 응답에서 확인할 수 있습니다.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
