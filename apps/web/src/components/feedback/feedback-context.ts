import { createContext, useContext } from 'react';

/**
 * 피드백 레이어의 계약.
 * 컴포넌트(FeedbackProvider)와 분리해 두어야 Fast Refresh가 정상 동작한다.
 */

export type ToastKind = 'success' | 'error' | 'info';

export interface ToastOptions {
  /** 본문. 제목만으로 부족할 때 두 번째 줄로 표시된다. */
  description?: string;
  /** 자동 닫힘까지의 ms. 0이면 수동으로만 닫힌다. */
  duration?: number;
}

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** danger면 확인 버튼이 파괴적 액션 색으로 표시된다. */
  tone?: 'default' | 'danger';
}

export interface PromptOptions {
  title: string;
  description?: string;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** true면 공백 입력으로 확인할 수 없다. (기본 true) */
  required?: boolean;
}

export interface ToastApi {
  success(title: string, options?: ToastOptions): void;
  error(title: string, options?: ToastOptions): void;
  info(title: string, options?: ToastOptions): void;
}

export interface FeedbackApi {
  toast: ToastApi;
  confirm(options: ConfirmOptions): Promise<boolean>;
  prompt(options: PromptOptions): Promise<string | null>;
}

export const FeedbackContext = createContext<FeedbackApi | null>(null);

export function useFeedback(): FeedbackApi {
  const context = useContext(FeedbackContext);
  if (!context) {
    throw new Error('useFeedback must be used within a FeedbackProvider');
  }
  return context;
}
