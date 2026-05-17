import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

const DialogContext = createContext(null);

export function useDialog() {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('useDialog phải gọi trong DialogProvider');
  return ctx;
}

export function DialogProvider({ children }) {
  const [config, setConfig] = useState(null);
  const resolverRef = useRef(null);

  const show = useCallback((opts) => {
    return new Promise((resolve) => {
      resolverRef.current = resolve;
      setConfig({ variant: 'info', primaryLabel: 'OK', ...opts });
    });
  }, []);

  const close = useCallback((value) => {
    resolverRef.current?.(value);
    resolverRef.current = null;
    setConfig(null);
  }, []);

  const api = useMemo(
    () => ({
      show,
      info:    (title, body) => show({ title, body, variant: 'info' }),
      success: (title, body) => show({ title, body, variant: 'success' }),
      error:   (title, body) => show({ title, body, variant: 'error' }),
      // confirm — opts:
      //   { danger, confirmLabel, cancelLabel,
      //     requireType: string  // bắt user gõ chuỗi này để enable confirm
      //   }
      confirm: (title, body, opts = {}) =>
        show({
          title,
          body,
          variant: opts.danger ? 'error' : 'info',
          primaryLabel: opts.confirmLabel ?? 'Đồng ý',
          secondaryLabel: opts.cancelLabel ?? 'Huỷ',
          danger: !!opts.danger,
          requireType: opts.requireType,
        }),
    }),
    [show]
  );

  return (
    <DialogContext.Provider value={api}>
      {children}
      {config && <DialogView config={config} close={close} />}
    </DialogContext.Provider>
  );
}

function DialogView({ config, close }) {
  const [typed, setTyped] = useState('');
  const requireType = config.requireType;
  const canConfirm = !requireType || typed === requireType;

  // Esc đóng dialog (cancel). Enter chỉ confirm khi không yêu cầu type-to-confirm.
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') close(false);
      else if (e.key === 'Enter' && canConfirm && !requireType) close(true);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, canConfirm, requireType]);

  const accent =
    config.variant === 'success' ? 'var(--success)'
    : config.variant === 'error' ? 'var(--danger)'
    : 'var(--brand)';

  const icon =
    config.variant === 'success' ? '✓'
    : config.variant === 'error' ? '✕'
    : 'i';

  // Body có thể là string hoặc React node. String → <p> với pre-wrap. Node → div bọc.
  const isStringBody = typeof config.body === 'string';

  return (
    <div className="modal-scrim dialog-scrim" onClick={() => close(false)}>
      <div className="modal-card dialog-card" onClick={(e) => e.stopPropagation()}>
        <div
          className="dialog-icon"
          style={{ background: `color-mix(in srgb, ${accent} 14%, transparent)`, color: accent }}
          aria-hidden
        >
          {icon}
        </div>

        {config.title && <h3 className="dialog-title">{config.title}</h3>}
        {config.body && (isStringBody
          ? <p className="dialog-body">{config.body}</p>
          : <div className="dialog-body dialog-body--rich">{config.body}</div>
        )}

        {requireType && (
          <div style={{ marginTop: 12 }}>
            <input
              className={`mushy-input ${typed && !canConfirm ? 'mushy-input--error' : ''}`}
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={`Gõ "${requireType}" để xác nhận`}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
            />
          </div>
        )}

        <div className="form-actions">
          {config.secondaryLabel && (
            <button
              className="mushy-btn mushy-btn--ghost"
              onClick={() => close(false)}
              style={{ flex: 1 }}
              autoFocus={!requireType}
            >
              {config.secondaryLabel}
            </button>
          )}
          <button
            className={`mushy-btn ${config.danger ? 'mushy-btn--danger' : 'mushy-btn--primary'}`}
            onClick={() => close(true)}
            style={{ flex: 1 }}
            disabled={!canConfirm}
            autoFocus={!config.secondaryLabel && !requireType}
          >
            {config.primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
