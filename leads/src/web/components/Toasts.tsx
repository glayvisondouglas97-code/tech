import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from 'react';

interface ToastOpts {
  tone?: 'bad' | 'warn';
  action?: { label: string; fn: () => void };
  ms?: number;
}
interface Toast extends ToastOpts {
  id: number;
  msg: string;
}

const Ctx = createContext<(msg: string, opts?: ToastOpts) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const seq = useRef(0);
  const remove = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (msg: string, opts: ToastOpts = {}) => {
      const id = ++seq.current;
      setItems((xs) => [...xs.slice(-2), { id, msg, ...opts }]);
      setTimeout(() => remove(id), opts.ms ?? (opts.action ? 7000 : 5000));
    },
    [remove],
  );
  const value = useMemo(() => push, [push]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => (
          <div
            key={t.id}
            className={`toast${t.tone ? ` ${t.tone}` : ''}`}
            role={t.tone === 'bad' ? 'alert' : 'status'}
          >
            <span>{t.msg}</span>
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  remove(t.id);
                  t.action?.fn();
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  return useContext(Ctx);
}
