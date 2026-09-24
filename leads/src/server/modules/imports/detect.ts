import { columnLetter, normalizeText } from '../../../shared/text';
import { normalizePhones } from './phone';

const CPF = /^\d{3}\.\d{3}\.\d{3}-\d{2}$/;
const CNPJ = /^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/;
const DATE = /^\d{1,4}[/-]\d{1,2}[/-]\d{1,4}( \d{1,2}:\d{2}(:\d{2})?)?$/;
// Só o CEP com hífen: "80010-000". Sem hífen ele é igual a um telefone sem DDD.
const CEP = /^\d{5}-\d{3}$/;

/** Parece telefone? (com ou sem DDD). CPF, CNPJ, CEP, datas e e-mails não contam. */
export function looksLikePhone(value: string): boolean {
  const s = String(value ?? '').trim();
  if (!s || s.includes('@') || /[a-z]{3,}/i.test(s)) return false;
  if (CPF.test(s) || CNPJ.test(s) || DATE.test(s) || CEP.test(s)) return false;
  const r = normalizePhones(s);
  return r.phones.length > 0 || r.error === 'sem_ddd';
}

const HAS_LETTERS = /[a-zà-ÿ]{2,}/i;
const PHONE_HEADER = /(tel|fone|cel|whats|zap|wpp|numero|phone|mobile|contato)/;
const NAME_HEADER = /(nome|name|cliente|lead|responsavel|socio|proprietario|dono|titular)/;
const NOT_NAME_HEADER =
  /(mail|cidade|estado|uf|produto|origem|obs|data|status|campanha|endereco|bairro|cpf|cnpj|cep|valor|tel|fone|cel|whats|empresa|razao|fantasia)/;
const COMPANY_HEADER = /(empresa|razao|fantasia|companhia|estabelecimento|negocio|firma|pj)/;
/** Palavras típicas de nome de empresa (valor já sem acento e minúsculo). */
const COMPANY_WORDS =
  /\b(ltda|me|eireli|epp|mei|s\/?a|s\.a|cia|comercio|comercial|servicos|industria|distribuidora|restaurante|padaria|clinica|academia|transportes|construtora|consultoria|associacao|mercado|farmacia|oficina|auto pecas|atacado)\b/;

/** A primeira linha é cabeçalho quando nenhuma célula dela parece telefone e há algum texto. */
export function detectHeader(rows: string[][]): boolean {
  const first = rows[0] ?? [];
  if (!first.some((v) => String(v).trim())) return false;
  if (first.some(looksLikePhone)) return false;
  return first.some((v) => HAS_LETTERS.test(String(v)));
}

export interface DetectedColumns {
  phone: number;
  /** Coluna do nome da empresa (-1 se não achou). */
  company: number;
  /** Coluna do nome do sócio / proprietário (-1 se não achou). */
  name: number;
}

function argmax(scores: number[], min: number, skip: number[]): number {
  let idx = -1;
  let best = min;
  scores.forEach((v, i) => {
    if (!skip.includes(i) && v > best) {
      best = v;
      idx = i;
    }
  });
  return idx;
}

/**
 * Escolhe as colunas de telefone, empresa e nome do sócio por pontuação:
 * proporção de valores que parecem telefone, empresa ou nome na amostra + bônus pelo título da coluna.
 */
export function detectColumns(rows: string[][], hasHeader: boolean): DetectedColumns {
  const sample = rows.slice(hasHeader ? 1 : 0, (hasHeader ? 1 : 0) + 200);
  const width = Math.max(0, ...rows.slice(0, 300).map((r) => r.length));
  const heads = hasHeader ? (rows[0] ?? []) : [];
  const phoneScore: number[] = [];
  const nameScore: number[] = [];
  const companyScore: number[] = [];
  for (let i = 0; i < width; i++) {
    const h = normalizeText(heads[i]);
    let phones = 0;
    let names = 0;
    let companies = 0;
    let filled = 0;
    for (const r of sample) {
      const v = String(r[i] ?? '').trim();
      if (!v) continue;
      filled++;
      if (looksLikePhone(v)) phones++;
      else if (HAS_LETTERS.test(v) && !v.includes('@')) {
        if (COMPANY_WORDS.test(normalizeText(v))) companies++;
        else if (!/\d{3,}/.test(v)) names++;
      }
    }
    let p = filled ? phones / filled : 0;
    let n = filled ? names / filled : 0;
    let c = filled ? companies / filled : 0;
    if (h && PHONE_HEADER.test(h)) p += 0.6;
    // O título "Nome"/"Sócio"/"Responsável" pesa mais que o conteúdo (colunas como "Interesse" também têm só texto).
    if (h && NAME_HEADER.test(h)) n += 1;
    if (h && NOT_NAME_HEADER.test(h)) n -= 0.5;
    if (h === 'nome' || h === 'nome completo') n += 0.3;
    if (h && COMPANY_HEADER.test(h)) c += 0.8;
    phoneScore.push(p);
    nameScore.push(n);
    companyScore.push(c);
  }
  const phone = argmax(phoneScore, 0, []);
  const company = argmax(companyScore, 0.5, [phone]);
  const name = argmax(nameScore, 0.15, [phone, company]);
  return { phone, company, name };
}

export interface ColumnInfo {
  index: number;
  letter: string;
  label: string;
  /** Título original (vazio quando não há cabeçalho). */
  header: string;
}

/** Colunas com rótulo: o título do cabeçalho ou "Coluna C". Títulos repetidos ganham " (2)". */
export function describeColumns(rows: string[][], hasHeader: boolean, width: number): ColumnInfo[] {
  const seen = new Map<string, number>();
  return Array.from({ length: width }, (_, i) => {
    const header = hasHeader ? String(rows[0]?.[i] ?? '').trim() : '';
    let label = header ? header.slice(0, 40) : `Coluna ${columnLetter(i)}`;
    const key = normalizeText(label);
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count > 1) label = `${label} (${count})`;
    return { index: i, letter: columnLetter(i), label, header };
  });
}
