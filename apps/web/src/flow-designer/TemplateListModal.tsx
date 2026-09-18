import React, { useEffect, useMemo, useRef, useState } from 'react';
import { templatesApi } from '../api/templates';
import type { WorkflowTemplate } from '../api/templates';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { X, FileText, Search, Copy, Check, RotateCw } from 'lucide-react';
import './TemplateListModal.css';

export interface TemplateListModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (template: WorkflowTemplate) => boolean | void | Promise<boolean | void>;
  allowedGroupIds?: string[];
}

type LifecycleFilter = 'ALL' | WorkflowTemplate['lifecycle_status'];

const LIFECYCLE_FILTERS: Array<{ value: LifecycleFilter; label: string }> = [
  { value: 'ALL', label: '전체' },
  { value: 'PUBLISHED', label: '배포됨' },
  { value: 'DRAFT', label: '초안' },
  { value: 'DISABLED', label: '배포 중지' },
];

export const TemplateListModal: React.FC<TemplateListModalProps> = ({
  isOpen,
  onClose,
  onSelect,
  allowedGroupIds,
}) => {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [lifecycleFilter, setLifecycleFilter] = useState<LifecycleFilter>('ALL');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const allowedGroupKey = allowedGroupIds?.join(',');

  useEffect(() => {
    if (isOpen) {
      loadTemplates();
    } else {
      // 다음에 열 때 이전 검색어가 남아 빈 목록으로 보이지 않게 한다.
      setKeyword('');
      setLifecycleFilter('ALL');
      setCopiedId(null);
    }
  }, [isOpen, allowedGroupKey]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    searchRef.current?.focus();
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!copiedId) return;
    const timer = window.setTimeout(() => setCopiedId(null), 1500);
    return () => window.clearTimeout(timer);
  }, [copiedId]);

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

  const visibleTemplates = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    return templates.filter((template) => {
      if (lifecycleFilter !== 'ALL' && template.lifecycle_status !== lifecycleFilter) return false;
      if (!needle) return true;
      return [template.name, template.description, template.id, ...(template.tags ?? [])]
        .some((value) => value?.toLowerCase().includes(needle));
    });
  }, [templates, keyword, lifecycleFilter]);

  const handleSelect = async (template: WorkflowTemplate) => {
    const selected = await onSelect(template);
    if (selected !== false) {
      onClose();
    }
  };

  const handleCopyId = async (event: React.MouseEvent, id: string) => {
    event.stopPropagation();
    await navigator.clipboard.writeText(id);
    setCopiedId(id);
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content template-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="template-modal-heading">
            <h2 className="modal-title">템플릿 불러오기</h2>
            {!loading && !error && (
              <span className="template-modal-count">
                {keyword.trim() || lifecycleFilter !== 'ALL'
                  ? `${visibleTemplates.length} / ${templates.length}개`
                  : `${templates.length}개`}
              </span>
            )}
          </div>
          <button className="modal-close" onClick={onClose} aria-label="닫기">
            <X size={20} />
          </button>
        </div>

        {!loading && !error && templates.length > 0 && (
          <div className="template-toolbar">
            <Input
              ref={searchRef}
              size="sm"
              fullWidth
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="이름, 설명, Template ID로 검색"
              leftIcon={<Search size={15} />}
              aria-label="템플릿 검색"
            />
            <div className="template-filter-group" role="group" aria-label="배포 상태 필터">
              {LIFECYCLE_FILTERS.map((filter) => (
                <button
                  key={filter.value}
                  type="button"
                  className={`template-filter-chip${lifecycleFilter === filter.value ? ' is-active' : ''}`}
                  onClick={() => setLifecycleFilter(filter.value)}
                  aria-pressed={lifecycleFilter === filter.value}
                >
                  {filter.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="modal-body">
          {loading && (
            <div className="template-loading">
              <RotateCw size={20} className="template-spinner" />
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
              <FileText size={40} />
              <p>저장된 템플릿이 없습니다.</p>
              <p className="template-empty-hint">워크플로우를 만들고 저장해보세요.</p>
            </div>
          )}

          {!loading && !error && templates.length > 0 && visibleTemplates.length === 0 && (
            <div className="template-empty">
              <Search size={40} />
              <p>조건에 맞는 템플릿이 없습니다.</p>
              <p className="template-empty-hint">검색어나 배포 상태 필터를 바꿔보세요.</p>
            </div>
          )}

          {!loading && !error && visibleTemplates.length > 0 && (
            <ul className="template-list">
              {visibleTemplates.map((template) => (
                <li key={template.id}>
                  {/* 카드 전체가 클릭 영역이고, 키보드 사용자는 안쪽 '불러오기' 버튼으로 실행한다. */}
                  <div className="template-item" onClick={() => handleSelect(template)}>
                    <div className="template-info">
                      <div className="template-header">
                        <h3 className="template-name">{template.name}</h3>
                        <span className="template-version">v{template.version}</span>
                        <span className={`template-badge lifecycle-${template.lifecycle_status.toLowerCase()}`}>
                          {lifecycleLabel(template.lifecycle_status)}
                        </span>
                        {template.has_unpublished_changes && (
                          <span className="template-badge template-unpublished">미배포 변경</span>
                        )}
                      </div>

                      {template.description && (
                        <p className="template-description">{template.description}</p>
                      )}

                      <div className="template-meta">
                        <span className="template-meta-item">노드 {template.nodes.length}</span>
                        <span className="template-meta-sep" aria-hidden="true">·</span>
                        <span className="template-meta-item">
                          수정 {formatDate(template.updated_at)} {template.updated_by || '확인 불가'}
                        </span>
                        <span className="template-meta-sep" aria-hidden="true">·</span>
                        <span className="template-meta-item">
                          생성 {formatDate(template.created_at)} {template.created_by || '확인 불가'}
                        </span>
                        <button
                          type="button"
                          className={`template-id-chip${copiedId === template.id ? ' is-copied' : ''}`}
                          onClick={(event) => handleCopyId(event, template.id)}
                          title={`Template ID ${template.id} 복사`}
                          aria-label={`Template ID ${template.id} 복사`}
                        >
                          {copiedId === template.id ? <Check size={12} /> : <Copy size={12} />}
                          <code>{copiedId === template.id ? '복사됨' : shortId(template.id)}</code>
                        </button>
                      </div>
                    </div>

                    <div className="template-actions">
                      <Button
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleSelect(template);
                        }}
                        variant="primary"
                        size="sm"
                      >
                        불러오기
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
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

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '확인 불가';
  return date.toLocaleDateString('ko-KR', { year: '2-digit', month: '2-digit', day: '2-digit' });
}

// 전체 UUID는 줄을 길게 차지하므로 앞 8자만 보여주고 클릭 시 원문을 복사한다.
function shortId(id: string) {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}
