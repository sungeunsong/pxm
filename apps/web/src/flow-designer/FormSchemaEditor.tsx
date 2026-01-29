// Start 노드의 폼 스키마를 편집하는 컴포넌트
// apps/web/src/flow-designer/FormSchemaEditor.tsx

import React, { useState } from 'react';
import type { FormSchema, FormField } from './form-types';
import { Button } from '../components/Button';
import { ChevronUp, ChevronDown, Edit2, Trash2, Plus } from 'lucide-react';
import './FormSchemaEditor.css';

interface FormSchemaEditorProps {
  schema?: FormSchema;
  onChange: (schema: FormSchema) => void;
}

export const FormSchemaEditor: React.FC<FormSchemaEditorProps> = ({
  schema,
  onChange,
}) => {
  const [editingField, setEditingField] = useState<FormField | null>(null);
  const [isAddingField, setIsAddingField] = useState(false);

  const fields = schema?.fields || [];

  const handleAddField = () => {
    setIsAddingField(true);
    setEditingField({
      id: '',
      type: 'text',
      label: '',
      required: false,
    });
  };

  const handleSaveField = (field: FormField) => {
    const newFields = editingField && fields.find(f => f.id === editingField.id)
      ? fields.map(f => f.id === editingField.id ? field : f)
      : [...fields, field];

    onChange({ fields: newFields });
    setEditingField(null);
    setIsAddingField(false);
  };

  const handleCancelEdit = () => {
    setEditingField(null);
    setIsAddingField(false);
  };

  const handleEditField = (field: FormField) => {
    setEditingField(field);
    setIsAddingField(false);
  };

  const handleDeleteField = (fieldId: string) => {
    if (confirm('이 필드를 삭제하시겠습니까?')) {
      onChange({ fields: fields.filter(f => f.id !== fieldId) });
    }
  };

  const handleMoveField = (index: number, direction: 'up' | 'down') => {
    const newFields = [...fields];
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    
    if (targetIndex < 0 || targetIndex >= newFields.length) return;
    
    [newFields[index], newFields[targetIndex]] = [newFields[targetIndex], newFields[index]];
    onChange({ fields: newFields });
  };

  const getFieldTypeLabel = (type: string) => {
    const labels: Record<string, string> = {
      text: '텍스트',
      textarea: '여러 줄 텍스트',
      number: '숫자',
      select: '선택',
      checkbox: '체크박스',
      radio: '라디오',
      date: '날짜',
      file: '파일',
    };
    return labels[type] || type;
  };

  return (
    <div className="form-schema-editor">
      <div className="form-schema-header">
        <h3>폼 필드 구성</h3>
        <Button
          variant="primary"
          size="sm"
          onClick={handleAddField}
          disabled={isAddingField || !!editingField}
        >
          <Plus size={16} />
          필드 추가
        </Button>
      </div>

      {fields.length === 0 && !isAddingField && (
        <div className="form-schema-empty">
          <p>폼 필드가 없습니다.</p>
          <p className="helper-text">필드 추가 버튼을 클릭하여 폼을 구성하세요.</p>
        </div>
      )}

      <div className="form-fields-list">
        {fields.map((field, index) => (
          <div key={field.id} className="form-field-item">
            <div className="form-field-info">
              <div className="form-field-header">
                <span className="form-field-number">{index + 1}.</span>
                <span className="form-field-label">{field.label || '(레이블 없음)'}</span>
                <span className="form-field-type">({getFieldTypeLabel(field.type)})</span>
                {field.required && <span className="required-badge">필수</span>}
              </div>
              <div className="form-field-id">ID: {field.id}</div>
              {field.options && field.options.length > 0 && (
                <div className="form-field-options">
                  옵션: {field.options.join(', ')}
                </div>
              )}
            </div>

            <div className="form-field-actions">
              <button
                className="icon-button"
                onClick={() => handleMoveField(index, 'up')}
                disabled={index === 0}
                title="위로 이동"
              >
                <ChevronUp size={16} />
              </button>
              <button
                className="icon-button"
                onClick={() => handleMoveField(index, 'down')}
                disabled={index === fields.length - 1}
                title="아래로 이동"
              >
                <ChevronDown size={16} />
              </button>
              <button
                className="icon-button"
                onClick={() => handleEditField(field)}
                title="편집"
              >
                <Edit2 size={16} />
              </button>
              <button
                className="icon-button danger"
                onClick={() => handleDeleteField(field.id)}
                title="삭제"
              >
                <Trash2 size={16} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {(editingField || isAddingField) && (
        <FieldEditor
          field={editingField!}
          existingFields={fields.filter(f => f.id !== editingField?.id)}
          onSave={handleSaveField}
          onCancel={handleCancelEdit}
        />
      )}
    </div>
  );
};

// 태그 입력 컴포넌트
interface TagInputProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  error?: string;
}

const TagInput: React.FC<TagInputProps> = ({ tags, onChange, placeholder, error }) => {
  const [inputValue, setInputValue] = useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const value = inputValue.trim();

    // Enter 또는 Space로 태그 추가
    if ((e.key === 'Enter' || e.key === ' ') && value) {
      e.preventDefault();
      if (!tags.includes(value)) {
        onChange([...tags, value]);
      }
      setInputValue('');
    }

    // Backspace로 마지막 태그 삭제 (입력값이 비어있을 때만)
    if (e.key === 'Backspace' && !inputValue && tags.length > 0) {
      onChange(tags.slice(0, -1));
    }
  };

  const handleRemoveTag = (indexToRemove: number) => {
    onChange(tags.filter((_, index) => index !== indexToRemove));
  };

  const handleContainerClick = () => {
    inputRef.current?.focus();
  };

  return (
    <div
      className={`tag-input-container ${error ? 'error' : ''}`}
      onClick={handleContainerClick}
    >
      <div className="tag-list">
        {tags.map((tag, index) => (
          <span key={index} className="tag-item">
            <span className="tag-text">{tag}</span>
            <button
              type="button"
              className="tag-remove"
              onClick={(e) => {
                e.stopPropagation();
                handleRemoveTag(index);
              }}
              aria-label={`${tag} 삭제`}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={tags.length === 0 ? placeholder : ''}
          className="tag-input"
        />
      </div>
    </div>
  );
};

// 필드 편집 인라인 컴포넌트
interface FieldEditorProps {
  field: FormField;
  existingFields: FormField[];
  onSave: (field: FormField) => void;
  onCancel: () => void;
}

const FieldEditor: React.FC<FieldEditorProps> = ({
  field: initialField,
  existingFields,
  onSave,
  onCancel,
}) => {
  const [field, setField] = useState<FormField>(initialField);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const handleChange = (key: keyof FormField, value: any) => {
    setField(prev => ({ ...prev, [key]: value }));
    if (errors[key]) {
      setErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors[key];
        return newErrors;
      });
    }
  };

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!field.id) {
      newErrors.id = '필드 ID는 필수입니다.';
    } else if (!/^[a-z_][a-z0-9_]*$/i.test(field.id)) {
      newErrors.id = '영문, 숫자, 언더스코어(_)만 사용 가능합니다.';
    } else if (existingFields.some(f => f.id === field.id)) {
      newErrors.id = '이미 사용 중인 ID입니다.';
    }

    if (!field.label) {
      newErrors.label = '레이블은 필수입니다.';
    }

    if ((field.type === 'select' || field.type === 'radio') && (!field.options || field.options.length === 0)) {
      newErrors.options = '옵션을 하나 이상 입력해주세요.';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSave = () => {
    if (validate()) {
      onSave(field);
    }
  };

  const getFieldTypeDescription = (type: string) => {
    const descriptions: Record<string, string> = {
      text: '한 줄 텍스트 입력',
      textarea: '여러 줄 텍스트 입력',
      number: '숫자 입력',
      select: '드롭다운 선택',
      checkbox: '체크박스 (예/아니오)',
      radio: '라디오 버튼 (하나만 선택)',
      date: '날짜 선택',
    };
    return descriptions[type] || '';
  };

  return (
    <div className="field-editor">
      <div className="field-editor-overlay" onClick={onCancel} />
      <div className="field-editor-content">
        <div className="field-editor-header">
          <h4>{initialField.id ? '필드 편집' : '새 필드 추가'}</h4>
          <button className="close-button" onClick={onCancel}>×</button>
        </div>

        <div className="field-editor-body">
          {/* 기본 정보 섹션 */}
          <div className="editor-section">
            <h5 className="section-title">기본 정보</h5>
            
            <div className="form-group">
              <label className="form-label">
                필드 ID <span className="required">*</span>
              </label>
              <input
                type="text"
                value={field.id}
                onChange={(e) => handleChange('id', e.target.value)}
                placeholder="예: requester_name"
                className={`form-input ${errors.id ? 'error' : ''}`}
                disabled={!!initialField.id}
              />
              {errors.id && <span className="error-text">{errors.id}</span>}
              {!errors.id && (
                <span className="helper-text">영문, 숫자, 언더스코어(_)만 사용 가능</span>
              )}
            </div>

            <div className="form-group">
              <label className="form-label">
                레이블 <span className="required">*</span>
              </label>
              <input
                type="text"
                value={field.label}
                onChange={(e) => handleChange('label', e.target.value)}
                placeholder="예: 요청자 이름"
                className={`form-input ${errors.label ? 'error' : ''}`}
              />
              {errors.label && <span className="error-text">{errors.label}</span>}
              <span className="helper-text">사용자에게 표시될 필드 이름</span>
            </div>

            <div className="form-group">
              <label className="form-label">
                필드 타입 <span className="required">*</span>
              </label>
              <select
                value={field.type}
                onChange={(e) => handleChange('type', e.target.value)}
                className="form-select"
              >
                <option value="text">텍스트</option>
                <option value="textarea">여러 줄 텍스트</option>
                <option value="number">숫자</option>
                <option value="select">선택 (드롭다운)</option>
                <option value="checkbox">체크박스</option>
                <option value="radio">라디오 버튼</option>
                <option value="date">날짜</option>
              </select>
              <span className="helper-text type-description">
                {getFieldTypeDescription(field.type)}
              </span>
            </div>
          </div>

          {/* 옵션 섹션 (select, radio만) */}
          {(field.type === 'select' || field.type === 'radio') && (
            <div className="editor-section">
              <h5 className="section-title">선택 옵션</h5>
              
              <div className="form-group">
                <label className="form-label">
                  옵션 목록 <span className="required">*</span>
                </label>
                <TagInput
                  tags={field.options || []}
                  onChange={(tags) => handleChange('options', tags)}
                  placeholder="옵션을 입력하고 Enter 또는 Space를 누르세요"
                  error={errors.options}
                />
                {errors.options && <span className="error-text">{errors.options}</span>}
                <span className="helper-text">Enter 또는 Space로 옵션 추가, X 버튼으로 삭제</span>
              </div>
            </div>
          )}

          {/* 검증 규칙 섹션 */}
          <div className="editor-section">
            <h5 className="section-title">검증 규칙</h5>
            
            <div className="form-group checkbox-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={field.required || false}
                  onChange={(e) => handleChange('required', e.target.checked)}
                />
                <span className="checkbox-text">필수 입력</span>
              </label>
              <span className="helper-text">사용자가 반드시 입력해야 하는 필드</span>
            </div>

            {field.type === 'number' && (
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">최소값</label>
                  <input
                    type="number"
                    value={field.min ?? ''}
                    onChange={(e) => handleChange('min', e.target.value ? Number(e.target.value) : undefined)}
                    className="form-input"
                    placeholder="제한 없음"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">최대값</label>
                  <input
                    type="number"
                    value={field.max ?? ''}
                    onChange={(e) => handleChange('max', e.target.value ? Number(e.target.value) : undefined)}
                    className="form-input"
                    placeholder="제한 없음"
                  />
                </div>
              </div>
            )}

            {(field.type === 'text' || field.type === 'textarea') && (
              <>
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">최소 길이</label>
                    <input
                      type="number"
                      value={field.minLength ?? ''}
                      onChange={(e) => handleChange('minLength', e.target.value ? Number(e.target.value) : undefined)}
                      className="form-input"
                      placeholder="제한 없음"
                      min={0}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">최대 길이</label>
                    <input
                      type="number"
                      value={field.maxLength ?? ''}
                      onChange={(e) => handleChange('maxLength', e.target.value ? Number(e.target.value) : undefined)}
                      className="form-input"
                      placeholder="제한 없음"
                      min={0}
                    />
                  </div>
                </div>

                <div className="form-group" style={{ marginTop: 'var(--space-sm)' }}>
                  <label className="form-label">입력 형식 (정규식)</label>
                  <input
                    type="text"
                    value={field.pattern || ''}
                    onChange={(e) => handleChange('pattern', e.target.value)}
                    className="form-input"
                    style={{ fontFamily: 'var(--font-mono)', fontSize: '13px' }}
                    placeholder="예: ^[0-9]+$ (숫자만)"
                  />
                  <span className="helper-text">
                    입력값 검증을 위한 정규식 (예: 이메일 <code>^[^\s@]+@[^\s@]+\.[^\s@]+$</code>)
                  </span>
                </div>
              </>
            )}
          </div>

          {/* 추가 설정 섹션 */}
          <div className="editor-section">
            <h5 className="section-title">추가 설정</h5>
            
            <div className="form-group">
              <label className="form-label">플레이스홀더</label>
              <input
                type="text"
                value={field.placeholder || ''}
                onChange={(e) => handleChange('placeholder', e.target.value)}
                placeholder="예: 홍길동"
                className="form-input"
              />
              <span className="helper-text">입력 필드에 표시될 힌트 텍스트</span>
            </div>

            {field.type === 'textarea' && (
              <div className="form-group">
                <label className="form-label">행 수</label>
                <input
                  type="number"
                  value={field.rows ?? 3}
                  onChange={(e) => handleChange('rows', Number(e.target.value))}
                  min={1}
                  max={20}
                  className="form-input"
                />
                <span className="helper-text">텍스트 영역의 기본 높이</span>
              </div>
            )}

            <div className="form-group">
              <label className="form-label">도움말 텍스트</label>
              <input
                type="text"
                value={field.helperText || ''}
                onChange={(e) => handleChange('helperText', e.target.value)}
                placeholder="예: 이름을 입력해주세요"
                className="form-input"
              />
              <span className="helper-text">필드 아래에 표시될 설명</span>
            </div>
          </div>

          {/* 표시 조건 섹션 */}
          <div className="editor-section">
            <h5 className="section-title">표시 조건 (옵션)</h5>
            
            <div className="form-group checkbox-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={!!field.condition}
                  onChange={(e) => {
                    if (e.target.checked) {
                      handleChange('condition', {
                        field: existingFields[0]?.id || '',
                        operator: 'eq',
                        value: ''
                      });
                    } else {
                      handleChange('condition', undefined);
                    }
                  }}
                  disabled={existingFields.length === 0}
                />
                <span className="checkbox-text">조건부 표시 활성화</span>
              </label>
              {existingFields.length === 0 && (
                <span className="helper-text error-text">참조할 수 있는 다른 필드가 없습니다.</span>
              )}
            </div>

            {field.condition && (
              <div className="condition-settings p-sm bg-tertiary rounded-md mt-sm">
                <div className="form-group">
                  <label className="form-label">참조 필드</label>
                  <select
                    value={field.condition.field}
                    onChange={(e) => handleChange('condition', { ...field.condition!, field: e.target.value })}
                    className="form-select"
                  >
                    {existingFields.map(f => (
                      <option key={f.id} value={f.id}>
                        {f.label} ({f.id})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-row">
                  <div className="form-group flex-1">
                    <label className="form-label">조건</label>
                    <select
                      value={field.condition.operator}
                      onChange={(e) => handleChange('condition', { ...field.condition!, operator: e.target.value as any })}
                      className="form-select"
                    >
                      <option value="eq">같음 (Errors)</option>
                      <option value="neq">다름 (Not Equals)</option>
                    </select>
                  </div>
                  <div className="form-group flex-1">
                    <label className="form-label">값</label>
                    <input
                      type="text"
                      value={String(field.condition.value)}
                      onChange={(e) => handleChange('condition', { ...field.condition!, value: e.target.value })}
                      className="form-input"
                      placeholder="비교할 값"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="field-editor-footer">
          <Button variant="secondary" onClick={onCancel}>
            취소
          </Button>
          <Button variant="primary" onClick={handleSave}>
            {initialField.id ? '수정 완료' : '필드 추가'}
          </Button>
        </div>
      </div>
    </div>
  );
};
