import React, { forwardRef } from 'react';
import './Input.css';

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string;
  error?: string;
  helperText?: string;
  size?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(({
  label,
  error,
  helperText,
  size = 'md',
  fullWidth = false,
  leftIcon,
  rightIcon,
  className = '',
  disabled,
  ...props
}, ref) => {
  const containerClassNames = [
    'input-container',
    fullWidth && 'input-container-full',
    className,
  ].filter(Boolean).join(' ');

  const inputClassNames = [
    'input',
    `input-${size}`,
    error && 'input-error',
    leftIcon && 'input-with-left-icon',
    rightIcon && 'input-with-right-icon',
    disabled && 'input-disabled',
  ].filter(Boolean).join(' ');

  return (
    <div className={containerClassNames}>
      {label && (
        <label className="input-label">
          {label}
          {props.required && <span className="input-required">*</span>}
        </label>
      )}
      <div className="input-wrapper">
        {leftIcon && <span className="input-icon input-icon-left">{leftIcon}</span>}
        <input
          ref={ref}
          className={inputClassNames}
          disabled={disabled}
          {...props}
        />
        {rightIcon && <span className="input-icon input-icon-right">{rightIcon}</span>}
      </div>
      {(error || helperText) && (
        <div className={error ? 'input-error-text' : 'input-helper-text'}>
          {error || helperText}
        </div>
      )}
    </div>
  );
});

Input.displayName = 'Input';
