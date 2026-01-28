import React, { forwardRef } from 'react';
import { Check } from 'lucide-react';
import './Checkbox.css';

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  label?: string;
  helperText?: string;
  error?: string;
  size?: 'sm' | 'md' | 'lg';
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(({
  label,
  helperText,
  error,
  size = 'md',
  className = '',
  disabled,
  checked,
  ...props
}, ref) => {
  const containerClassNames = [
    'checkbox-container',
    disabled && 'checkbox-container-disabled',
    className,
  ].filter(Boolean).join(' ');

  const checkboxClassNames = [
    'checkbox',
    `checkbox-${size}`,
    error && 'checkbox-error',
  ].filter(Boolean).join(' ');

  return (
    <div className={containerClassNames}>
      <label className="checkbox-label-wrapper">
        <div className="checkbox-input-wrapper">
          <input
            ref={ref}
            type="checkbox"
            className={checkboxClassNames}
            disabled={disabled}
            checked={checked}
            {...props}
          />
          <span className={`checkbox-custom ${checked ? 'checkbox-custom-checked' : ''}`}>
            {checked && <Check className="checkbox-check-icon" size={size === 'sm' ? 12 : size === 'lg' ? 18 : 14} />}
          </span>
        </div>
        {label && <span className="checkbox-label">{label}</span>}
      </label>
      {(error || helperText) && (
        <div className={error ? 'checkbox-error-text' : 'checkbox-helper-text'}>
          {error || helperText}
        </div>
      )}
    </div>
  );
});

Checkbox.displayName = 'Checkbox';
