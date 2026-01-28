import React, { useEffect, useState } from 'react';
import { templatesApi } from '../api/templates';
import type { WorkflowTemplate } from '../api/templates';
import { Button } from '../components/Button';
import { X, FileText, Calendar, Hash } from 'lucide-react';
import './TemplateListModal.css';

export interface TemplateListModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (template: WorkflowTemplate) => void;
}

export const TemplateListModal: React.FC<TemplateListModalProps> = ({
  isOpen,
  onClose,
  onSelect,
}) => {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      loadTemplates();
    }
  }, [isOpen]);

  const loadTemplates = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await templatesApi.list(true);
      setTemplates(data);
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
                <div key={template.id} className="template-item">
                  <div className="template-info" onClick={() => handleSelect(template)}>
                    <div className="template-header">
                      <h3 className="template-name">{template.name}</h3>
                      <span className="template-version">v{template.version}</span>
                    </div>
                    {template.description && (
                      <p className="template-description">{template.description}</p>
                    )}
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
                      onClick={() => handleDelete(template.id, template.name)}
                      variant="ghost"
                      size="sm"
                    >
                      삭제
                    </Button>
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
