import { type ReactNode, useEffect, useRef, useState } from 'react';
import { RESULTS, type ResultId, resultInfo } from '../../shared/results';
import { initials } from '../../shared/text';
import { fmtN } from '../lib/format';
import { IconInbox, IconX } from './Icons';

/** Matiz fixo por nome: cada pessoa ganha sempre a mesma cor de avatar. */
export function hue(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export function Avatar({ name, large }: { name: string | null | undefined; large?: boolean }) {
  return (
    <span
      className={`avatar${large ? ' lg' : ''}${name ? '' : ' empty'}`}
      style={name ? ({ '--h': hue(name) } as React.CSSProperties) : undefined}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

export function ResultPill({ result }: { result: string | null }) {
  const r = resultInfo(result);
  return <span className={`pill t-${r.tone}`}>{r.label}</span>;
}

export function ResultSelect({
  value,
  onChange,
  disabled,
  id,
}: {
  value: ResultId;
  onChange: (v: ResultId) => void;
  disabled?: boolean;
  id?: string;
}) {
  const r = resultInfo(value);
  return (
    <select
      id={id}
      className={`res-select t-${r.tone}`}
      value={value}
      disabled={disabled}
      aria-label="Resultado"
      onChange={(e) => onChange(e.target.value as ResultId)}
    >
      {RESULTS.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Skeleton({ rows = 5 }: { rows?: number }) {
  return (
    <ul className="leads" aria-busy="true" aria-label="Carregando">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: linhas fixas de carregamento
        <li key={i} className="skel" />
      ))}
    </ul>
  );
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-ic" aria-hidden="true">
        {icon ?? <IconInbox size={22} />}
      </span>
      <h2>{title}</h2>
      {children}
    </div>
  );
}

/** Janela modal acessível (usa <dialog> nativo: foco preso e Esc para fechar). */
export function Dialog({
  open,
  onClose,
  title,
  children,
  drawer,
  labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  drawer?: boolean;
  labelledBy?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={drawer ? 'drawer' : 'dlg'}
      aria-label={labelledBy ? undefined : title}
      aria-labelledby={labelledBy}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className={drawer ? 'drawer-in' : 'dlg-in'}>
          {title && (
            <div className="dlg-head">
              <h2>{title}</h2>
              <button type="button" className="icon-btn" onClick={onClose} aria-label="Fechar">
                <IconX />
              </button>
            </div>
          )}
          {children}
        </div>
      )}
    </dialog>
  );
}

/** Menu suspenso simples: fecha ao escolher um item, ao clicar fora ou ao apertar Esc. */
export function Menu({ label, icon, children }: { label: string; icon: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      <button
        type="button"
        className="icon-btn"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {icon}
      </button>
      {open && (
        <div
          className="menu"
          role="menu"
          onClick={(e) => {
            if ((e.target as HTMLElement).closest('button, a')) setOpen(false);
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function Pager({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav className="pager" aria-label="Páginas">
      <span>
        {fmtN(from)}–{fmtN(to)} de {fmtN(total)}
      </span>
      <div className="row">
        <button
          type="button"
          className="btn btn-line btn-sm"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          Anterior
        </button>
        <span>
          Página {fmtN(page)} de {fmtN(pages)}
        </span>
        <button
          type="button"
          className="btn btn-line btn-sm"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
        >
          Próxima
        </button>
      </div>
    </nav>
  );
}

/** Confirmação dentro de um diálogo, com botão perigoso opcional. */
export function Confirm({
  open,
  title,
  children,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <div className="stack" style={{ gap: 12 }}>
        {children}
      </div>
      <div className="row end">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Cancelar
        </button>
        <button
          type="button"
          className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? 'Aguarde…' : confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}

/** Copia texto para a área de transferência, com alternativa para navegadores antigos. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/** Baixa um conteúdo gerado no próprio navegador (ex.: planilha modelo). */
export function downloadText(fileName: string, content: string, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
