/**
 * Variáveis das mensagens: troca {{nome}}, {{empresa}}, {{telefone}}, {{atendente}} e {{numero}} pelos
 * dados reais do lead. Variável que não existe NÃO é trocada em silêncio: sai em `unknown` e quem chama
 * decide (o executor não envia uma mensagem com "{{nomee}}" escrito para o cliente).
 */
import { AUTOMATION_VARIABLES } from '../../../shared/automations';

/** Dados já prontos para o texto (o executor formata o telefone e escolhe o nome do atendente). */
export interface RenderData {
  /** Nome do sócio/contato do lead. */
  name: string | null;
  company: string | null;
  /** Telefone do lead, como se mostra (ex.: (41) 99876-5432). */
  phone: string;
  /** Quem chamou o lead (ou iniciou a execução). */
  attendant: string | null;
  /** O número de WhatsApp que está enviando, como se mostra. */
  number: string;
}

/**
 * O que aparece quando o dado do lead está vazio. Definido aqui para a mensagem nunca sair com buraco
 * ("Olá, !"): fica coerente e neutra.
 */
export const FALLBACKS = { nome: 'cliente', empresa: 'sua empresa', atendente: 'nossa equipe' } as const;

export interface RenderResult {
  text: string;
  /** Variáveis escritas na mensagem que não existem (sem repetir). Vazio = tudo certo. */
  unknown: string[];
}

const PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g;

function valueFor(name: string, data: RenderData): string | undefined {
  switch (name) {
    case 'nome':
      return data.name?.trim() || data.company?.trim() || FALLBACKS.nome;
    case 'empresa':
      return data.company?.trim() || FALLBACKS.empresa;
    case 'telefone':
      return data.phone;
    case 'atendente':
      return data.attendant?.trim() || FALLBACKS.atendente;
    case 'numero':
      return data.number;
    default:
      return undefined;
  }
}

/** Troca as variáveis conhecidas. O que foi inserido não é interpretado de novo (uma passada só). */
export function renderMessage(template: string, data: RenderData): RenderResult {
  const known = new Set<string>(AUTOMATION_VARIABLES.map((v) => v.name));
  const unknown = new Set<string>();
  const text = template.replace(PATTERN, (whole, raw: string) => {
    const name = raw.trim();
    const value = known.has(name) ? valueFor(name, data) : undefined;
    if (value === undefined) {
      unknown.add(name);
      return whole;
    }
    return value;
  });
  return { text, unknown: [...unknown] };
}
