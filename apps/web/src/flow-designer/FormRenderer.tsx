// 동적 폼 렌더러 컴포넌트
// apps/web/src/flow-designer/FormRenderer.tsx

import React, { useState } from 'react';
import type { FormSchema, FormField, FormValues, ValidationResult } from './form-types';
import { Input } from '../components/Input';
import { Select } from '../components/Select';
import { Checkbox } from '../components/Checkbox';
import { Button } from '../components/Button';
import './FormRenderer.css';

interface FormRendererProps {
  schema?: FormSchema;
  initialData?: FormValues;
  onSubmit: (data: FormValues) => void;
  onCancel?: () => void;
}

export const FormRenderer: React.FC<FormRendererProps> = ({
  schema,
  initialData = {},
  onSubmit,
  onCancel,
}) => {
  const [formData, setFormData] = useState<FormValues>(initialData);
  const [errors, setErrors] = useState<Record<string, string>>({});

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

  const validateForm = (): ValidationResult => {
    const newErrors: Record<string, string> = {};

    schema.fields.forEach(field => {
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
            onChange={(e) => handleFieldChange(field.id, e.target.value)}
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
            error={error}
            helperText={error || field.helperText}
            required={field.required}
            fullWidth
          >
            <option value="">선택하세요</option>
            {field.options?.map(option => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
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
      <div className="form-fields">
        {schema.fields.map(field => renderField(field))}
      </div>
      
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
