/**
 * Link click-to-chat oficial (wa.me). O atendente envia a mensagem manualmente.
 * No celular abre direto o aplicativo do WhatsApp; no computador abre o WhatsApp Desktop ou o Web.
 * O telefone vai só com dígitos, com o código do país (formato E.164 sem o "+").
 */
export function whatsappLink(phoneE164: string, text: string | null): string {
  const digits = String(phoneE164 ?? '').replace(/\D/g, '');
  if (!text) return `https://wa.me/${digits}`;
  // encodeURIComponent troca espaço por %20 (o "+" do URLSearchParams aparece literal em alguns aparelhos).
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
