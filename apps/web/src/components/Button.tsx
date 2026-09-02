import React from 'react';
import './Button.css';

/**
 * 공용 버튼.
 *
 * native <button> 속성(aria-*, title, form, name, onFocus…)을 그대로 전달한다.
 * 이전에는 지정한 몇 개만 받고 나머지를 조용히 버려서,
 * `aria-label`을 넘겨도 접근성 tree에 이름이 남지 않았다.
 * (JSX는 하이픈이 들어간 속성명을 타입 검사 없이 통과시키므로 컴파일 에러도 나지 않는다.)
 *
 * 아이콘만 있고 글자가 없는 버튼은 타입 수준에서 `aria-label`을 요구한다.
 */

type ButtonBaseProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  icon?: React.ReactNode;
  iconPosition?: 'left' | 'right';
};

export type ButtonProps =
  | (ButtonBaseProps & { children: React.ReactNode })
  // 아이콘 전용 버튼: 읽어줄 글자가 없으므로 이름을 반드시 받는다.
  | (ButtonBaseProps & { children?: undefined; 'aria-label': string });

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    icon,
    iconPosition = 'left',
    children,
    className = '',
    type = 'button',
    ...rest
  },
  ref,
) {
  const classNames = [
    'btn',
    `btn-${variant}`,
    `btn-${size}`,
    !children && 'btn-icon-only',
    className,
  ].filter(Boolean).join(' ');

  return (
    <button ref={ref} type={type} className={classNames} {...rest}>
      {icon && iconPosition === 'left' && (
        <span className="btn-icon btn-icon-left" aria-hidden="true">{icon}</span>
      )}
      {children && <span className="btn-text">{children}</span>}
      {icon && iconPosition === 'right' && (
        <span className="btn-icon btn-icon-right" aria-hidden="true">{icon}</span>
      )}
    </button>
  );
});
