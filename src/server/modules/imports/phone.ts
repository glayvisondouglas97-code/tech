import { type PhoneNumber, parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { formatPhoneBR } from '../../../shared/phone-format';

export type PhoneKind = 'movel' | 'fixo' | null;

/** Telefone normalizado: E.164 só com dígitos (sem "+"), ex.: 5541998765432. */
export interface Phone {
  e164: string;
  kind: PhoneKind;
}

export type PhoneError = 'vazio' | 'sem_ddd' | 'invalido';

export interface PhoneParse {
  /** Todos os números válidos da célula; o primeiro é o principal (celulares vêm antes de fixos). */
  phones: Phone[];
  error: PhoneError | null;
}

export const PHONE_ERROR_LABEL: Record<PhoneError, string> = {
  vazio: 'Sem telefone',
  sem_ddd: 'Telefone sem DDD (preencha o DDD padrão)',
  invalido: 'Telefone inválido',
};

// Separadores entre vários números na mesma célula: / ; | , quebra de linha, " ou ", " e ".
const SEPARATORS = /\s*(?:[/;|,\n\r]|\s(?:ou|e|or)\s)\s*/i;
const ALLOWED_TYPES = new Set(['MOBILE', 'FIXED_LINE', 'FIXED_LINE_OR_MOBILE']);

function kindOf(p: PhoneNumber): PhoneKind | 'rejeitar' {
  const t = p.getType();
  if (t === undefined) return null;
  if (!ALLOWED_TYPES.has(t)) return 'rejeitar'; // 0800, tarifado, etc.: não têm WhatsApp
  if (t === 'MOBILE') return 'movel';
  if (t === 'FIXED_LINE') return 'fixo';
  return null;
}

function fromParsed(p: PhoneNumber | undefined): Phone | null {
  if (!p?.isValid()) return null;
  const kind = kindOf(p);
  if (kind === 'rejeitar') return null;
  return { e164: p.number.slice(1), kind };
}

/** Número nacional brasileiro (DDD + número, 10 ou 11 dígitos). */
function brazilian(national: string): Phone | null {
  let n = national;
  // Celular antigo, sem o 9 na frente (DDD + 8 dígitos começando com 6 a 9): acrescenta o 9.
  if (n.length === 10 && /[6-9]/.test(n.charAt(2))) n = `${n.slice(0, 2)}9${n.slice(2)}`;
  return fromParsed(parsePhoneNumberFromString(n, 'BR'));
}

function international(digits: string): Phone | null {
  if (digits.length < 8 || digits.length > 15) return null;
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    return brazilian(digits.slice(2));
  }
  return fromParsed(parsePhoneNumberFromString(`+${digits}`));
}

function normalizeOne(part: string, ddd: string | null): Phone | null | 'sem_ddd' {
  const hasPlus = /^\s*\+/.test(part);
  let d = part.replace(/\D/g, '');
  if (!d) return null;
  if (hasPlus) return international(d);
  if (d.startsWith('00')) return international(d.slice(2)); // prefixo internacional "00"
  const hadTrunkPrefix = d.startsWith('0');
  d = d.replace(/^0+/, ''); // prefixo de longa distância: 041 99876-5432
  if (d.length === 8 || d.length === 9) {
    if (!ddd) return 'sem_ddd';
    d = ddd + d;
  }
  if (d.length === 10 || d.length === 11) return brazilian(d);
  if (d.length === 12 || d.length === 13) {
    if (d.startsWith('55')) {
      const r = brazilian(d.slice(2));
      if (r) return r;
    }
    // 0 + código da operadora + DDD + número: 0 15 41 99876-5432
    if (hadTrunkPrefix) {
      const r = brazilian(d.slice(2));
      if (r) return r;
    }
  }
  // Sem "+" ou "00" o número é tratado como brasileiro. Interpretar como estrangeiro
  // deixaria passar número brasileiro digitado errado (ex.: virar um número dos EUA).
  return null;
}

function splitCandidates(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(SEPARATORS)) {
    const digits = part.replace(/\D/g, '');
    if (!digits) continue;
    // "41998765432 41988887777": dois números só separados por espaço.
    if (digits.length > 15 && /\s/.test(part.trim())) {
      const tokens = part.trim().split(/\s+/);
      if (tokens.every((t) => t.replace(/\D/g, '').length >= 8)) {
        out.push(...tokens);
        continue;
      }
    }
    out.push(part);
  }
  return out;
}

/**
 * Normaliza o conteúdo de uma célula de telefone para E.164.
 * Aceita formatos como "(41) 99876-5432", "41998765432", "+55 41 99876-5432", "041 99876-5432",
 * "5541998765432", "9876-5432" (com DDD padrão) e vários números na mesma célula.
 */
export function normalizePhones(raw: unknown, defaultDdd?: string | null): PhoneParse {
  const text = String(raw ?? '').trim();
  if (!text) return { phones: [], error: 'vazio' };
  if (!/\d/.test(text)) return { phones: [], error: 'invalido' };
  const ddd = defaultDdd && /^[1-9][0-9]$/.test(defaultDdd) ? defaultDdd : null;
  const phones: Phone[] = [];
  const seen = new Set<string>();
  let missingDdd = false;
  for (const part of splitCandidates(text)) {
    const r = normalizeOne(part, ddd);
    if (r === 'sem_ddd') missingDdd = true;
    else if (r && !seen.has(r.e164)) {
      seen.add(r.e164);
      phones.push(r);
    }
  }
  if (!phones.length) return { phones: [], error: missingDdd ? 'sem_ddd' : 'invalido' };
  // Celulares primeiro: são os que costumam ter WhatsApp.
  const ordered = [...phones.filter((p) => p.kind !== 'fixo'), ...phones.filter((p) => p.kind === 'fixo')];
  return { phones: ordered, error: null };
}

/** Telefone para exibição: "(41) 99876-5432" no Brasil, formato internacional nos outros países. */
export function displayPhone(e164: string): string {
  const d = String(e164 ?? '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('55')) return formatPhoneBR(d);
  return parsePhoneNumberFromString(`+${d}`)?.formatInternational() ?? `+${d}`;
}
