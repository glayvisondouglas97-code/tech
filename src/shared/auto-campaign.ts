/**
 * Campanha automática: a ÚNICA campanha do sistema, pré-definida pelo backend. O gestor só ativa ou pausa.
 *
 * Quando ativa, em dias úteis das 10:00 às 16:00 (São Paulo), o sistema pega um lead da fila livre (qualquer lista não
 * arquivada), sorteia um áudio ativo da biblioteca (rodízio: todos saem antes de repetir) e escolhe um número conectado
 * (o menos usado no dia; empate por sorteio), respeitando a cota de 20 contatos novos por número por dia (manual +
 * automático). Nada aqui é configurável pela tela: estes valores são a regra.
 */
import { INSTANCE_DAILY_CONTACT_LIMIT } from './quota';

export const AUTO_CAMPAIGN = {
  name: 'Campanha automática',
  description:
    'Envia um áudio sorteado da biblioteca para os leads da fila livre, por um número sorteado entre os conectados.',
  /** Janela de envio, em minutos desde a meia-noite de São Paulo: [10:00, 16:00). */
  windowStartMin: 10 * 60,
  windowEndMin: 16 * 60,
  /** Segunda a sexta (ISO: 1 = segunda ... 7 = domingo). */
  days: [1, 2, 3, 4, 5] as readonly number[],
  /** Contatos novos por número por dia: a própria cota do número. */
  dailyLimitPerNumber: INSTANCE_DAILY_CONTACT_LIMIT,
  /** Depois de um primeiro contato automático, o mesmo lead não recebe nova abordagem de campanha antes disto. */
  cooldownHours: 24,
} as const;

/** `off` = nunca ativada; `active` = ligada (envia só dentro do horário); `paused` = desligada pelo gestor. */
export type AutoCampaignStatus = 'off' | 'active' | 'paused';

/** O que a campanha está fazendo agora em relação ao horário. */
export type AutoCampaignPhase = 'off' | 'sending' | 'before_window' | 'after_window' | 'not_a_run_day';

export interface AutoCampaignCounts {
  /** Leads que receberam o áudio. */
  sent: number;
  /** Leads cujo telefone não tem WhatsApp (conferido antes de enviar). */
  noWhatsapp: number;
  /** Dos que receberam, quantos já responderam. */
  replied: number;
  /** Dos que receberam, quantos ainda não responderam. */
  notReplied: number;
}

export interface AutoCampaignNumber {
  id: number;
  label: string;
  connected: boolean;
  /** Contatos novos de hoje (manual + automático + incerto) e o teto (20). */
  usedToday: number;
  limit: number;
  remainingToday: number;
  automaticToday: number;
}

export interface AutoCampaignState {
  status: AutoCampaignStatus;
  phase: AutoCampaignPhase;
  /** Texto curto do que está acontecendo (vem do servidor). */
  headline: string;
  /** Próximo instante em que pode enviar (ISO), se estiver ativa e fora do horário. */
  nextOpening: string | null;
  activatedAt: string | null;
  activatedBy: string | null;
  /** Regra fixa, para a tela mostrar. */
  rules: { windowStart: string; windowEnd: string; days: string; dailyLimitPerNumber: number };
  metrics: {
    /** Quantos leads ainda devem sair hoje: o menor entre os disponíveis e as vagas de hoje. */
    toSendToday: number;
    /** Leads na fila livre que ainda podem receber (inclui os já reservados para sair). */
    available: number;
    /** Vagas que ainda cabem hoje nos números conectados (20 por número, menos o que já foi feito hoje). */
    capacityToday: number;
    today: AutoCampaignCounts;
    total: AutoCampaignCounts;
  };
  activeAudios: number;
  numbers: AutoCampaignNumber[];
  /** O que impede ou atrapalha o envio agora (sem áudio, sem número conectado, sem leads...). */
  warnings: string[];
}

/** Taxa de resposta em %, arredondada (0 quando nada foi enviado). */
export const replyRate = (c: Pick<AutoCampaignCounts, 'sent' | 'replied'>): number =>
  c.sent > 0 ? Math.round((c.replied / c.sent) * 100) : 0;
