/**
 * Agenda do executor: constantes e contas de data. Tudo é guardado no PostgreSQL (`next_run_at`); nenhum
 * timer é criado por lead nem por etapa. Um único job (em `jobs/scheduler.ts`) procura o que venceu.
 */

/** De quantos em quantos segundos o job procura participações vencidas. */
export const CYCLE_SECONDS = 10;

/**
 * Quantas participações o job atende por ciclo (uma de cada vez, em fila). É um limite de vazão de
 * propósito: a fila prioriza controle, não velocidade. Com 10 a cada 10 segundos, no máximo ~60 envios por
 * minuto para todo o sistema; se sobrar, o resto espera o ciclo seguinte.
 */
export const BATCH_SIZE = 10;

/** Espera antes de tentar de novo quando o número está desconectado ou não deu para conferir o lead. */
export const RETRY_SECONDS = 300;

/** Tentativas de uma etapa que NÃO chegou a ser enviada (número desconectado). Depois disso, falha. */
export const MAX_ATTEMPTS = 3;

/**
 * Uma participação "em execução" há mais que isso está abandonada (o processo caiu no meio). Fica bem acima
 * do tempo máximo de um envio (a Evolution tem limite de 60 segundos).
 */
export const STUCK_AFTER_MINUTES = 10;

/** Quando a etapa deve agir: a base (fim da etapa anterior ou início da automação) mais a espera. */
export function scheduleAfter(base: Date, delaySeconds: number): Date {
  return new Date(base.getTime() + Math.max(0, delaySeconds) * 1000);
}

/** A etapa já venceu? */
export function isDue(nextRunAt: Date | null, now: Date): boolean {
  return nextRunAt !== null && nextRunAt.getTime() <= now.getTime();
}
