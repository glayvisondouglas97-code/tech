/**
 * Formata um telefone brasileiro guardado como E.164 sem "+" (5541998765432) para exibição:
 * "(41) 99876-5432". Outros países: "+" e os dígitos (o servidor formata melhor quando pode).
 */
export function formatPhoneBR(e164: string | null | undefined): string {
  const d = String(e164 ?? '').replace(/\D/g, '');
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
    const ddd = d.slice(2, 4);
    const n = d.slice(4);
    return `(${ddd}) ${n.slice(0, n.length - 4)}-${n.slice(-4)}`;
  }
  return d ? `+${d}` : '';
}
