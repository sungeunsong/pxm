import React, { forwardRef } from 'react';
import { ChevronDown } from 'lucide-react';
import './Select.css';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  label?: string;
  error?: string;
  helperText?: string;
  size?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
  options: SelectOption[];
  placeholder?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(({
  label,
  error,
  helperText,
  size = 'md',
  fullWidth = false,
  options,
  placeholder,
  className = '',
  disabled,
  ...props
}, ref) => {
  const containerClassNames = [
    'select-container',
    fullWidth && 'select-container-full',
    className,
  ].filter(Boolean).join(' ');

  const selectClassNames = [
    'select',
    `select-${size}`,
    error && 'select-error',
    disabled && 'select-disabled',
  ].filter(Boolean).join(' ');

  return (
    <div className={containerClassNames}>
      {label && (
        <label className="select-label">
          {label}
          {props.required && <span className="select-required">*</span>}
        </label>
      )}
      <div className="select-wrapper">
        <select
          ref={ref}
          className={selectClassNames}
          disabled={disabled}
          {...props}
        >
          {placeholder && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {options.map((option) => (
            <option
              key={option.value}
              value={option.value}
              disabled={option.disabled}
            >
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown className="select-icon" size={16} />
      </div>
      {(error || helperText) && (
        <div className={error ? 'select-error-text' : 'select-helper-text'}>
          {error || helperText}
        </div>
      )}
    </div>
  );
});

Select.displayName = 'Select';
