import React, { useEffect, useState } from 'react';
import { templatesApi } from '../api/templates';
import type { WorkflowTemplate } from '../api/templates';
import { Button } from '../components/Button';
import { X, FileText, Calendar, Clock3, Hash, Copy } from 'lucide-react';
import './TemplateListModal.css';

export interface TemplateListModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (template: WorkflowTemplate) => boolean | void | Promise<boolean | void>;
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

  const handleSelect = async (template: WorkflowTemplate) => {
    const selected = await onSelect(template);
    if (selected !== false) {
      onClose();
    }
  };

  const handleCopyId = async (event: React.MouseEvent, id: string) => {
    event.stopPropagation();
    await navigator.clipboard.writeText(id);
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
                  className="template-item-group"
                >
                  <div className="template-item">
                    <div className="template-info" onClick={() => handleSelect(template)}>
                      <div className="template-header">
                        <h3 className="template-name">{template.name}</h3>
                        <span className="template-version">v{template.version}</span>
                        <span className={`template-lifecycle ${template.lifecycle_status.toLowerCase()}`}>
                          {lifecycleLabel(template.lifecycle_status)}
                        </span>
                        {template.has_unpublished_changes && (
                          <span className="template-unpublished">미배포 변경</span>
                        )}
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
                          생성 {new Date(template.created_at).toLocaleDateString('ko-KR')} · 생성자 ID: {template.created_by || '확인 불가'}
                        </span>
                        <span className="template-meta-item">
                          <Clock3 size={14} />
                          최근 수정 {new Date(template.updated_at).toLocaleDateString('ko-KR')} · 수정자 ID: {template.updated_by || '확인 불가'}
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
                    </div>
                  </div>
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

function lifecycleLabel(status: WorkflowTemplate['lifecycle_status']) {
  return status === 'PUBLISHED' ? '배포됨' : status === 'DISABLED' ? '배포 중지' : '초안';
}
