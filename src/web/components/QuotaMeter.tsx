/** Barra da cota diária de contatos de um número (contatos de hoje ÷ limite). Só mostra: quem conta é o servidor. */
export function QuotaMeter({ total, limit, label }: { total: number; limit: number; label: string }) {
  const percent = limit > 0 ? Math.min(100, (total / limit) * 100) : 0;
  return (
    <div
      className={`quota-meter${total >= limit ? ' full' : ''}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={limit}
      aria-valuenow={total}
      aria-label={label}
    >
      <span style={{ width: `${percent}%` }} />
    </div>
  );
}
