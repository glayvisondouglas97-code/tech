/** Resultados possíveis de um contato. A ordem é a mesma dos menus. */
export const RESULTS = [
  { id: 'enviado', label: 'Mensagem enviada', tone: 'neutral' },
  { id: 'respondeu', label: 'Respondeu', tone: 'info' },
  { id: 'nao_respondeu', label: 'Cliente não respondeu', tone: 'neutral' },
  { id: 'interessado', label: 'Interessado', tone: 'warn' },
  { id: 'fechou', label: 'Fechou negócio', tone: 'ok' },
  { id: 'sem_conta', label: 'Cliente não tem conta no banco', tone: 'mute' },
  { id: 'nao_correntista', label: 'Cliente não é correntista', tone: 'mute' },
  { id: 'sem_interesse', label: 'Sem interesse', tone: 'mute' },
  { id: 'sem_whatsapp', label: 'Sem WhatsApp', tone: 'bad' },
] as const;

export type ResultId = (typeof RESULTS)[number]['id'];
export type Tone = (typeof RESULTS)[number]['tone'];

export const RESULT_IDS = RESULTS.map((r) => r.id) as [ResultId, ...ResultId[]];

const byId = new Map<string, (typeof RESULTS)[number]>(RESULTS.map((r) => [r.id, r]));

export function resultInfo(id: string | null | undefined) {
  return byId.get(id ?? '') ?? RESULTS[0];
}

export function resultLabel(id: string | null | undefined): string {
  return resultInfo(id).label;
}

/** "Sem WhatsApp" não é um contato de verdade: fica fora das métricas de chamados. */
export const NOT_A_CONTACT: ResultId = 'sem_whatsapp';
