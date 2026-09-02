// 동적 폼 렌더러 컴포넌트
// apps/web/src/flow-designer/FormRenderer.tsx

import React, { useEffect, useState } from 'react';
import type { FormSchema, FormField, FormValues, ValidationResult } from './form-types';
import { Input } from '../components/Input';
import { Select } from '../components/Select';
import { Checkbox } from '../components/Checkbox';
import { Button } from '../components/Button';
import { useFeedback } from '../components/feedback/feedback-context';
import { errorMessage } from '../lib/error-message';
import { type InputPreset, listInputPresets, saveInputPreset } from '../input-presets';
import { InputPresetManager } from '../input-presets/InputPresetManager';
import './FormRenderer.css';

interface FormRendererProps {
  schema?: FormSchema;
  initialData?: FormValues;
  presetScopeId?: string;
  onSubmit: (data: FormValues) => void;
  onCancel?: () => void;
}

const EMPTY_FORM_VALUES: FormValues = {};

export const FormRenderer: React.FC<FormRendererProps> = ({
  schema,
  initialData = EMPTY_FORM_VALUES,
  presetScopeId,
  onSubmit,
  onCancel,
}) => {
  const { toast, prompt: promptDialog } = useFeedback();
  const [formData, setFormData] = useState<FormValues>(initialData);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [presetVersion, setPresetVersion] = useState(0);
  const [presets, setPresets] = useState<InputPreset[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(false);
  const [presetManagerOpen, setPresetManagerOpen] = useState(false);

  useEffect(() => {
    setFormData(initialData);
  }, [initialData]);

  useEffect(() => {
    if (!presetScopeId) {
      setPresets([]);
      return;
    }

    let cancelled = false;
    setPresetsLoading(true);
    listInputPresets(presetScopeId)
      .then((items) => {
        if (!cancelled) setPresets(items);
      })
      .catch((error) => {
        console.error('Failed to load input presets:', error);
        if (!cancelled) setPresets([]);
      })
      .finally(() => {
        if (!cancelled) setPresetsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [presetScopeId, presetVersion]);

  const refreshPresets = () => setPresetVersion((current) => current + 1);

  if (!schema || !schema.fields || schema.fields.length === 0) {
    return (
      <div className="form-renderer-empty">
        <p>이 워크플로우에는 입력 폼이 정의되지 않았습니다.</p>
        <Button onClick={() => onSubmit({})}>계속 진행</Button>
      </div>
    );
  }

  const handleFieldChange = (fieldId: string, value: any) => {
    setFormData(prev => ({
      ...prev,
      [fieldId]: value,
    }));
    
    // 에러 제거
    if (errors[fieldId]) {
      setErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors[fieldId];
        return newErrors;
      });
    }
  };

  const handleApplyPreset = (presetId: string) => {
    const preset = presets.find((item) => item.id === presetId);
    if (!preset) return;
    setFormData((current) => ({ ...current, ...preset.values }));
    setErrors({});
  };

  const handleSavePreset = async () => {
    if (!presetScopeId) return;
    const name = await promptDialog({
      title: '파라미터 세트 저장',
      label: '세트 이름',
      placeholder: '예: 운영계 기본값',
      confirmLabel: '저장',
    });
    if (!name?.trim()) return;
    try {
      await saveInputPreset(presetScopeId, name, formData, undefined, 'group');
      refreshPresets();
    } catch (error) {
      console.error('Failed to save input preset:', error);
      toast.error('파라미터 세트 저장에 실패했습니다.', { description: errorMessage(error) });
    }
  };

  const checkCondition = (field: FormField): boolean => {
    if (!field.condition) return true;

    const { field: targetFieldId, operator, value: targetValue } = field.condition;
    const actualValue = formData[targetFieldId];

    // 값 비교 (문자열로 변환하여 비교하는 것이 안전)
    const strActual = String(actualValue ?? '');
    const strTarget = String(targetValue);

    if (operator === 'eq') {
      return strActual === strTarget;
    }
    if (operator === 'neq') {
      return strActual !== strTarget;
    }

    return true;
  };

  const validateForm = (): ValidationResult => {
    const newErrors: Record<string, string> = {};

    schema.fields.forEach(field => {
      // 조건부 필드: 조건이 맞지 않으면 검증 스킵
      if (!checkCondition(field)) {
        return;
      }

      const value = formData[field.id];

      // 필수 필드 검증
      if (field.required && (value === undefined || value === null || value === '')) {
        newErrors[field.id] = `${field.label}은(는) 필수 입력 항목입니다.`;
        return;
      }

      // 값이 없으면 나머지 검증 스킵
      if (value === undefined || value === null || value === '') {
        return;
      }

      // 타입별 검증
      if (field.type === 'text' || field.type === 'textarea') {
        const strValue = String(value);
        
        if (field.minLength && strValue.length < field.minLength) {
          newErrors[field.id] = `최소 ${field.minLength}자 이상 입력해주세요.`;
        }
        
        if (field.maxLength && strValue.length > field.maxLength) {
          newErrors[field.id] = `최대 ${field.maxLength}자까지 입력 가능합니다.`;
        }
        
        if (field.pattern) {
          const regex = new RegExp(field.pattern);
          if (!regex.test(strValue)) {
            newErrors[field.id] = `올바른 형식으로 입력해주세요.`;
          }
        }
      }

      if (field.type === 'number') {
        const numValue = Number(value);
        
        if (isNaN(numValue)) {
          newErrors[field.id] = '숫자를 입력해주세요.';
          return;
        }
        
        if (field.min !== undefined && numValue < field.min) {
          newErrors[field.id] = `최소값은 ${field.min}입니다.`;
        }
        
        if (field.max !== undefined && numValue > field.max) {
          newErrors[field.id] = `최대값은 ${field.max}입니다.`;
        }
      }
    });

    return {
      valid: Object.keys(newErrors).length === 0,
      errors: newErrors,
    };
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const validation = validateForm();
    
    if (!validation.valid) {
      setErrors(validation.errors);
      return;
    }
    
    // formData를 깨끗하게 복사 (circular reference 제거)
    const cleanFormData: Record<string, any> = {};
    Object.keys(formData).forEach(key => {
      const value = formData[key];
      // 기본 타입만 복사
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
        cleanFormData[key] = value;
      } else {
        console.warn(`[FormRenderer] Skipping non-primitive value for key "${key}"`);
      }
    });
    
    onSubmit(cleanFormData);
  };

  const renderField = (field: FormField) => {
    // 조건부 필드: 조건이 맞지 않으면 렌더링 안 함
    if (!checkCondition(field)) {
      return null;
    }

    const value = formData[field.id] ?? field.defaultValue ?? '';
    const error = errors[field.id];

    switch (field.type) {
      case 'text':
        return (
          <Input
            key={field.id}
            label={field.label}
            value={value}
            onChange={(e) => handleFieldChange(field.id, e.target.value)}
            placeholder={field.placeholder}
            error={error}
            helperText={error || field.helperText}
            required={field.required}
            fullWidth
          />
        );

      case 'textarea':
        return (
          <div key={field.id} className="form-field">
            <label className="form-field-label">
              {field.label}
              {field.required && <span className="required-mark">*</span>}
            </label>
            <textarea
              className={`form-textarea ${error ? 'error' : ''}`}
              value={value}
              onChange={(e) => handleFieldChange(field.id, e.target.value)}
              placeholder={field.placeholder}
              rows={field.rows || 3}
            />
            {(error || field.helperText) && (
              <div className={`form-field-helper ${error ? 'error' : ''}`}>
                {error || field.helperText}
              </div>
            )}
          </div>
        );

      case 'number':
        return (
          <Input
            key={field.id}
            type="number"
            label={field.label}
            value={value}
            onChange={(e) => handleFieldChange(field.id, e.target.value === '' ? '' : Number(e.target.value))}
            placeholder={field.placeholder}
            error={error}
            helperText={error || field.helperText}
            required={field.required}
            fullWidth
          />
        );

      case 'select':
        return (
          <Select
            key={field.id}
            label={field.label}
            value={value}
            onChange={(e) => handleFieldChange(field.id, e.target.value)}
            options={(field.options || []).map(opt => ({ label: opt, value: opt }))}
            placeholder="선택하세요"
            error={error}
            helperText={error || field.helperText}
            required={field.required}
            fullWidth
          />
        );

      case 'checkbox':
        return (
          <Checkbox
            key={field.id}
            label={field.label}
            checked={!!value}
            onChange={(e) => handleFieldChange(field.id, e.target.checked)}
            helperText={error || field.helperText}
            error={error}
          />
        );

      case 'date':
        return (
          <Input
            key={field.id}
            type="date"
            label={field.label}
            value={value}
            onChange={(e) => handleFieldChange(field.id, e.target.value)}
            error={error}
            helperText={error || field.helperText}
            required={field.required}
            fullWidth
          />
        );

      case 'radio':
        return (
          <div key={field.id} className="form-field">
            <label className="form-field-label">
              {field.label}
              {field.required && <span className="required-mark">*</span>}
            </label>
            <div className="form-radio-group">
              {field.options?.map(option => (
                <label key={option} className="form-radio-label">
                  <input
                    type="radio"
                    name={field.id}
                    value={option}
                    checked={value === option}
                    onChange={(e) => handleFieldChange(field.id, e.target.value)}
                  />
                  <span>{option}</span>
                </label>
              ))}
            </div>
            {(error || field.helperText) && (
              <div className={`form-field-helper ${error ? 'error' : ''}`}>
                {error || field.helperText}
              </div>
            )}
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <form className="form-renderer" onSubmit={handleSubmit}>
      {presetScopeId && (
        <div className="input-preset-bar">
          <div className="input-preset-header">
            <div>
              <strong>파라미터 세트</strong>
              <span>저장된 Start 입력값을 아래 폼에 적용합니다.</span>
            </div>
            <div className="input-preset-actions">
              <Button type="button" variant="ghost" size="sm" onClick={() => setPresetManagerOpen(true)}>관리</Button>
            </div>
          </div>
          {presetsLoading ? (
            <p className="input-preset-empty">파라미터 세트를 불러오는 중입니다.</p>
          ) : presets.length > 0 ? (
            <div className="input-preset-list">
              {presets.map((preset) => (
                <div key={preset.id} className="input-preset-item">
                  <button type="button" onClick={() => handleApplyPreset(preset.id)}>
                    {preset.name}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="input-preset-empty">저장된 파라미터 세트가 없습니다.</p>
          )}
        </div>
      )}
      {presetScopeId && (
        <InputPresetManager
          open={presetManagerOpen}
          workflowId={presetScopeId}
          presets={presets}
          onClose={() => setPresetManagerOpen(false)}
          onChanged={refreshPresets}
        />
      )}
      <div className="form-fields">
        {schema.fields.map(field => renderField(field))}
      </div>
      {presetScopeId && (
        <div className="input-preset-save-row">
          <span>위 Start 입력값을 API 실행 프리셋으로 재사용할 수 있습니다.</span>
          <Button type="button" variant="secondary" size="sm" onClick={handleSavePreset}>입력값을 새 프리셋으로 저장</Button>
        </div>
      )}
      
      <div className="form-actions">
        {onCancel && (
          <Button type="button" variant="secondary" onClick={onCancel}>
            취소
          </Button>
        )}
        <Button type="submit" variant="primary">
          제출
        </Button>
      </div>
    </form>
  );
};
