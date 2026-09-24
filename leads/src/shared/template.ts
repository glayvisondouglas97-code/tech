import { normalizeText } from './text';

export const DEFAULT_TEMPLATE =
  'Olá, {nome}! Tudo bem? Aqui é {atendente}. Estou entrando em contato com a {empresa} porque temos uma proposta que pode interessar. Posso te passar mais informações?';

export interface TemplateLead {
  /** Nome do sócio / proprietário. */
  name: string | null;
  /** Nome da empresa. */
  company?: string | null;
  extra?: Record<string, string> | null;
}

/** Primeiro nome com a inicial maiúscula: "MARIA DA SILVA" → "Maria". */
export function firstName(name: string | null | undefined): string {
  const first =
    String(name ?? '')
      .trim()
      .split(/\s+/)[0] ?? '';
  if (!first) return '';
  return first.charAt(0).toLocaleUpperCase('pt-BR') + first.slice(1).toLocaleLowerCase('pt-BR');
}

/**
 * Preenche a mensagem pronta.
 * Variáveis: {nome} (primeiro nome do sócio), {nome_completo}, {empresa}, {atendente} e o título
 * de qualquer coluna extra da planilha (sem diferenciar maiúsculas nem acentos).
 * Variável desconhecida vira texto vazio. "Olá, {nome}!" sem nome vira "Olá!".
 */
export function fillTemplate(template: string, lead: TemplateLead, attendant: string): string {
  const extra = lead.extra ?? {};
  return String(template ?? '')
    .replace(/\{([^{}]{1,40})\}/g, (_m, rawKey: string) => {
      const key = normalizeText(rawKey).replace(/ /g, '_');
      if (key === 'nome') return firstName(lead.name);
      if (key === 'nome_completo') return String(lead.name ?? '').trim();
      if (key === 'empresa') return String(lead.company ?? '').trim();
      if (key === 'atendente') return attendant ?? '';
      for (const [k, v] of Object.entries(extra)) {
        if (normalizeText(k).replace(/ /g, '_') === key) return String(v);
      }
      return '';
    })
    .replace(/,\s*([!?.])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Variáveis fixas, na ordem em que aparecem nos botões de "Inserir". */
export const BASE_VARIABLES = ['{nome}', '{nome_completo}', '{empresa}', '{atendente}'];
