// Peças visuais usadas em várias telas: avatar, janela, menu, avisos rápidos e estado vazio.
import { CircleAlert, CircleCheckBig, UserRound, X, type LucideIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { hueOf, initials, instanceColor } from '../format.ts';

// ---------- Avatar ----------

export function Avatar({ name, seed, size }: { name: string | null | undefined; seed?: string | null; size?: 'sm' | 'lg' }) {
  const letters = initials(name);
  const style = { '--h': hueOf(seed || name || '') } as CSSProperties;
  return (
    <span className={`avatar ${size ?? ''}`} style={style} aria-hidden>
      {letters || <UserRound />}
    </span>
  );
}

// ---------- Selo do número (WhatsApp) ----------

type ChipProps = { id: number; label: string; pill?: boolean; prefix?: string; title?: string };

export function InstanceChip({ id, label, pill, prefix, title }: ChipProps) {
  return (
    <span className={`chip ${pill ? 'pill' : ''}`} title={title} style={{ '--instance-color': instanceColor(id) } as CSSProperties}>
      <span className="chip-dot" aria-hidden />
      <span className="chip-label">
        {prefix}
        {label}
      </span>
    </span>
  );
}

// ---------- Estado vazio ----------

type EmptyStateProps = { icon: LucideIcon; title: string; children?: ReactNode; action?: ReactNode };

export function EmptyState({ icon: Icon, title, children, action }: EmptyStateProps) {
  return (
    <div className="empty">
      <span className="empty-icon" aria-hidden>
        <Icon />
      </span>
      <strong>{title}</strong>
      {children && <p>{children}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function Spinner() {
  return (
    <svg className="spinner" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function FormError({ children }: { children: ReactNode }) {
  return (
    <p className="form-error" role="alert">
      <CircleAlert aria-hidden />
      {children}
    </p>
  );
}

// ---------- Janela (no celular, sobe de baixo) ----------

type ModalProps = { title: string; description?: ReactNode; wide?: boolean; onClose: () => void; children: ReactNode };

export function Modal({ title, description, wide, onClose, children }: ModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    // Foca o primeiro campo (ou a própria janela), para o teclado já funcionar.
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) {
      (dialog.querySelector<HTMLElement>('input:not([type=checkbox]), textarea') ?? dialog).focus();
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, []);

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialogRef} className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="modal-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Fechar">
            <X />
          </button>
        </header>
        {children}
      </div>
    </div>,
    document.body,
  );
}

// ---------- Menu suspenso ----------

export type MenuItem = { label: string; icon: LucideIcon; onSelect: () => void; danger?: boolean };

type MenuProps = {
  label: string;
  buttonClassName: string;
  button: ReactNode;
  placement: 'up-right' | 'down-left';
  header?: ReactNode;
  items: MenuItem[];
};

export function Menu({ label, buttonClassName, button, placement, header, items }: MenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => !rootRef.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="menu" ref={rootRef}>
      <button
        type="button"
        className={buttonClassName}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {button}
      </button>
      {open && (
        <div className={`menu-list ${placement}`} role="menu">
          {header && <div className="menu-head">{header}</div>}
          {items.map(({ label: itemLabel, icon: Icon, onSelect, danger }) => (
            <button
              key={itemLabel}
              type="button"
              role="menuitem"
              className={`menu-item ${danger ? 'danger' : ''}`}
              onClick={() => {
                setOpen(false);
                onSelect();
              }}
            >
              <Icon aria-hidden />
              {itemLabel}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Avisos rápidos ("toasts") ----------

type ToastItem = { id: number; text: string; kind: 'success' | 'error' };
let showToast: ((item: ToastItem) => void) | null = null;
let toastSeq = 0;

export function toast(text: string, kind: ToastItem['kind'] = 'success'): void {
  showToast?.({ id: ++toastSeq, text, kind });
}

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    showToast = (item) => {
      setItems((prev) => [...prev.slice(-2), item]);
      setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== item.id)), 3500);
    };
    return () => {
      showToast = null;
    };
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === 'success' ? <CircleCheckBig aria-hidden /> : <CircleAlert aria-hidden />}
          {t.text}
        </div>
      ))}
    </div>
  );
}

// ---------- Aparelho ----------

// Celular/tablet (tela de toque): Enter quebra a linha em vez de enviar, e o teclado não abre sozinho.
export const isTouchDevice = window.matchMedia('(pointer: coarse)').matches;
