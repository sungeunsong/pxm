import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { Button } from '../Button';
import {
  FeedbackContext,
  type ConfirmOptions,
  type FeedbackApi,
  type PromptOptions,
  type ToastKind,
  type ToastOptions,
} from './feedback-context';
import './feedback.css';
import { isTopModalLayer, popModalLayer, pushModalLayer } from '../../lib/modal-layer';

/**
 * 브라우저 기본 alert/confirm/prompt를 대체하는 공용 피드백 레이어.
 *
 * - toast.success / toast.error / toast.info : 비차단 알림 (구 alert)
 * - confirm(...)  : Promise<boolean>          (구 window.confirm)
 * - prompt(...)   : Promise<string | null>    (구 window.prompt)
 */

interface ToastItem extends ToastOptions {
  id: number;
  kind: ToastKind;
  title: string;
  leaving?: boolean;
}

type PendingDialog =
  | { kind: 'confirm'; options: ConfirmOptions; resolve: (value: boolean) => void }
  | { kind: 'prompt'; options: PromptOptions; resolve: (value: string | null) => void };

const DEFAULT_DURATION: Record<ToastKind, number> = {
  success: 3200,
  info: 3600,
  // 실패는 원인을 읽어야 하므로 더 오래 남긴다.
  error: 6000,
};

const TOAST_ICON: Record<ToastKind, React.ReactNode> = {
  success: <CheckCircle2 size={16} />,
  error: <AlertTriangle size={16} />,
  info: <Info size={16} />,
};

export const FeedbackProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [dialog, setDialog] = useState<PendingDialog | null>(null);
  const [promptValue, setPromptValue] = useState('');
  const promptValueRef = useRef('');
  const nextId = useRef(1);
  const timers = useRef<number[]>([]);
  const pendingDialogRef = useRef<PendingDialog | null>(null);
  const dialogElementRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => () => {
    timers.current.forEach((timer) => window.clearTimeout(timer));
    const pending = pendingDialogRef.current;
    if (pending?.kind === 'confirm') pending.resolve(false);
    if (pending?.kind === 'prompt') pending.resolve(null);
    pendingDialogRef.current = null;
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.map((item) => (item.id === id ? { ...item, leaving: true } : item)));
    timers.current.push(
      window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 140),
    );
  }, []);

  const pushToast = useCallback(
    (kind: ToastKind, title: string, options?: ToastOptions) => {
      const id = nextId.current++;
      const duration = options?.duration ?? DEFAULT_DURATION[kind];
      setToasts((current) => [...current.slice(-3), { id, kind, title, ...options }]);
      if (duration > 0) {
        timers.current.push(window.setTimeout(() => dismissToast(id), duration));
      }
    },
    [dismissToast],
  );

  const api = useMemo<FeedbackApi>(
    () => ({
      toast: {
        success: (title, options) => pushToast('success', title, options),
        error: (title, options) => pushToast('error', title, options),
        info: (title, options) => pushToast('info', title, options),
      },
      confirm: (options) =>
        new Promise<boolean>((resolve) => {
          const nextDialog: PendingDialog = { kind: 'confirm', options, resolve };
          const pending = pendingDialogRef.current;
          if (pending?.kind === 'confirm') pending.resolve(false);
          if (pending?.kind === 'prompt') pending.resolve(null);
          if (!pending) previousFocusRef.current = document.activeElement as HTMLElement | null;
          pendingDialogRef.current = nextDialog;
          setDialog(nextDialog);
        }),
      prompt: (options) =>
        new Promise<string | null>((resolve) => {
          const nextDialog: PendingDialog = { kind: 'prompt', options, resolve };
          const pending = pendingDialogRef.current;
          if (pending?.kind === 'confirm') pending.resolve(false);
          if (pending?.kind === 'prompt') pending.resolve(null);
          if (!pending) previousFocusRef.current = document.activeElement as HTMLElement | null;
          const initialValue = options.defaultValue ?? '';
          promptValueRef.current = initialValue;
          setPromptValue(initialValue);
          pendingDialogRef.current = nextDialog;
          setDialog(nextDialog);
        }),
    }),
    [pushToast],
  );

  const closeDialog = useCallback(
    (accepted: boolean) => {
      const current = pendingDialogRef.current;
      if (!current) return;
      pendingDialogRef.current = null;
      setDialog(null);
      if (current.kind === 'confirm') current.resolve(accepted);
      else current.resolve(accepted ? promptValueRef.current : null);

      const previousFocus = previousFocusRef.current;
      previousFocusRef.current = null;
      window.requestAnimationFrame(() => previousFocus?.focus());
    },
    [],
  );

  useEffect(() => {
    if (!dialog) return;
    const dialogElement = dialogElementRef.current;
    const initialFocus = dialogElement?.querySelector<HTMLElement>('[data-dialog-initial-focus]');
    initialFocus?.focus();

    // Drawer 위에 열릴 수 있다. 나중에 push되므로 이 다이얼로그가 최상단이 된다.
    const layer = pushModalLayer('dialog');

    const handleKey = (event: KeyboardEvent) => {
      if (!isTopModalLayer(layer)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeDialog(false);
        return;
      }
      if (event.key !== 'Tab' || !dialogElement) return;

      const focusable = Array.from(
        dialogElement.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialogElement.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement;
      if (!dialogElement.contains(activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('keydown', handleKey);
      popModalLayer(layer);
    };
  }, [dialog, closeDialog]);

  const promptRequired = dialog?.kind === 'prompt' ? dialog.options.required !== false : false;
  const promptInvalid = promptRequired && promptValue.trim().length === 0;

  return (
    <FeedbackContext.Provider value={api}>
      {children}

      <div className="pxm-toast-viewport" role="region" aria-live="polite" aria-label="알림">
        {toasts.map((item) => (
          <div key={item.id} className={`pxm-toast pxm-toast-${item.kind}${item.leaving ? ' leaving' : ''}`}>
            <span className="pxm-toast-icon" aria-hidden="true">
              {TOAST_ICON[item.kind]}
            </span>
            <div className="pxm-toast-body">
              <span className="pxm-toast-title">{item.title}</span>
              {item.description && <span className="pxm-toast-description">{item.description}</span>}
            </div>
            <button type="button" className="pxm-toast-close" onClick={() => dismissToast(item.id)} aria-label="알림 닫기">
              <X size={13} />
            </button>
          </div>
        ))}
      </div>

      {dialog && (
        <div className="pxm-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && closeDialog(false)}>
          <div
            ref={dialogElementRef}
            className="pxm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="pxm-dialog-title"
            aria-describedby={dialog.options.description ? 'pxm-dialog-description' : undefined}
            tabIndex={-1}
          >
            <h2 className="pxm-dialog-title" id="pxm-dialog-title">
              {dialog.options.title}
            </h2>
            {dialog.options.description && <p className="pxm-dialog-description" id="pxm-dialog-description">{dialog.options.description}</p>}

            {dialog.kind === 'prompt' && (
              <label className="pxm-dialog-field">
                {dialog.options.label && <span className="pxm-dialog-label">{dialog.options.label}</span>}
                <input
                  className="pxm-dialog-input"
                  autoFocus
                  data-dialog-initial-focus
                  value={promptValue}
                  placeholder={dialog.options.placeholder}
                  onChange={(event) => {
                    promptValueRef.current = event.target.value;
                    setPromptValue(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !promptInvalid) {
                      event.preventDefault();
                      closeDialog(true);
                    }
                  }}
                />
              </label>
            )}

            <div className="pxm-dialog-actions">
              <Button
                variant="secondary"
                onClick={() => closeDialog(false)}
                {...(dialog.kind === 'confirm' ? { 'data-dialog-initial-focus': true } : {})}
              >
                {dialog.options.cancelLabel ?? '취소'}
              </Button>
              <Button
                variant={dialog.kind === 'confirm' && dialog.options.tone === 'danger' ? 'danger' : 'primary'}
                disabled={promptInvalid}
                onClick={() => closeDialog(true)}
              >
                {dialog.options.confirmLabel ?? '확인'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </FeedbackContext.Provider>
  );
};
