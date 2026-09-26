/**
 * O PÚBLICO de uma campanha: quem pode receber um primeiro contato. TODAS as regras de elegibilidade moram aqui (uma
 * lista de regras e um conjunto de condições SQL), e são usadas por:
 * - a reserva do próximo lead (`queue.ts`), com `FOR UPDATE SKIP LOCKED`;
 * - a contagem de quem ainda falta e o fim natural da campanha;
 * - a prévia e o painel (contadores agregados numa consulta só, sem carregar nenhum lead).
 * Nem a interface nem a fila repetem essas regras: o backend é a autoridade.
 *
 * Um lead é elegível quando (alias da tabela: `l`): pertence à lista (ou a qualquer lista, na campanha automática), que
 * não está arquivada; tem a situação permitida (padrão: pendente, ou seja, na fila livre) e não tem atendente; não foi
 * anonimizado; tem telefone utilizável; não está em "não contatar"; não tem resultado "Sem WhatsApp"; passa pelos filtros (DDD, resultado, tipo de telefone, chamado
 * antes); nunca participou desta automação (nem desta campanha); não está no meio de uma execução de OUTRA campanha; e não
 * está em cooldown.
 *
 * COOLDOWN: quem recebeu um PRIMEIRO contato automático (a primeira etapa de uma participação de campanha, concluída)
 * há menos que `cooldown_hours` não é elegível para uma nova abordagem independente. Só vale para entrar no público:
 * as etapas seguintes da MESMA execução nunca são barradas por ele.
 */
import { type RawBuilder, sql } from 'kysely';
import type { CampaignAudience, CampaignFilters } from '../../../shared/campaign-plan';
import type { Db } from '../../db';
import type { AutomationCampaign } from '../../db/schema';

export interface AudienceConfig {
  /** A lista da campanha, ou null para a fila livre de TODAS as listas não arquivadas (campanha automática). */
  listId: string | null;
  automationId: number;
  /** A campanha já criada (quem já entrou nela sai do público). Vazio na prévia, antes de criar. */
  campaignId: number | null;
  filters: CampaignFilters;
  /** Horas de cooldown depois de um primeiro contato automático (0 = sem cooldown). */
  cooldownHours: number;
}

/** O público de uma campanha que já existe (vazio se a lista foi excluída; todas as listas em `all_lists`). */
export function audienceConfigOf(
  c: Pick<
    AutomationCampaign,
    'id' | 'automation_id' | 'list_id' | 'all_lists' | 'filters' | 'cooldown_hours'
  >,
): AudienceConfig | null {
  if (c.list_id === null && !c.all_lists) return null;
  return {
    listId: c.all_lists ? null : c.list_id,
    automationId: c.automation_id,
    campaignId: c.id,
    filters: c.filters,
    cooldownHours: c.cooldown_hours,
  };
}

type Cond = RawBuilder<boolean>;

/** As condições, uma por regra, sobre o lead `l`. Cada uma responde "este lead TEM esta característica?". */
function conditions(cfg: AudienceConfig, now: Date) {
  const f = cfg.filters;
  const statuses = f.status?.length ? f.status : ['pendente'];
  // Só "pendente" (o padrão) vira texto fixo: assim o PostgreSQL usa o índice da fila livre (`leads_free_idx`), que é o
  // que mantém rápida a busca na base inteira da campanha automática.
  const onlyPending = statuses.length === 1 && statuses[0] === 'pendente';
  const phone: Cond = f.phoneType?.length
    ? sql<boolean>`(l.phone <> '' AND l.phone_type = ANY(${[...f.phoneType]}::text[]))`
    : // Sem escolha: celular ou tipo desconhecido (telefone fixo raramente tem WhatsApp).
      sql<boolean>`(l.phone <> '' AND l.phone_type IS DISTINCT FROM 'fixo')`;
  return {
    listArchived: sql<boolean>`NOT EXISTS (SELECT 1 FROM lists li WHERE li.id = l.list_id AND li.archived_at IS NULL)`,
    statusOk: onlyPending
      ? sql<boolean>`(l.status = 'pendente')`
      : sql<boolean>`(l.status = ANY(${[...statuses]}::text[]) AND l.status <> 'bloqueado')`,
    unassigned: sql<boolean>`(l.assigned_to IS NULL)`,
    anonymized: sql<boolean>`(l.anonymized_at IS NOT NULL)`,
    phoneOk: phone,
    blocked: sql<boolean>`(l.status = 'bloqueado' OR EXISTS (SELECT 1 FROM blocked_phones b WHERE b.phone = l.phone))`,
    noWhatsapp: sql<boolean>`(COALESCE(l.result = 'sem_whatsapp', false))`,
    dddOk: f.ddd?.length ? sql<boolean>`(l.ddd = ANY(${[...f.ddd]}::text[]))` : sql<boolean>`(true)`,
    resultOk: f.result?.length
      ? sql<boolean>`(COALESCE(l.result = ANY(${[...f.result]}::text[]), false))`
      : sql<boolean>`(true)`,
    calledOk:
      f.calledBefore === 'never'
        ? sql<boolean>`(l.called_at IS NULL)`
        : f.calledBefore === 'already'
          ? sql<boolean>`(l.called_at IS NOT NULL)`
          : sql<boolean>`(true)`,
    participated: sql<boolean>`EXISTS (
      SELECT 1 FROM automation_runs r
      WHERE r.lead_id = l.id
        AND ((r.automation_id = ${cfg.automationId} AND r.status IN ('pending', 'running', 'completed'))
             ${cfg.campaignId === null ? sql`` : sql`OR r.campaign_id = ${cfg.campaignId}`}))`,
    // No meio de uma execução de outra automação em campanha (esperando o primeiro contato ou as etapas seguintes): quem já
    // está sendo abordado por uma campanha não entra em outra ao mesmo tempo, com ou sem cooldown.
    inOtherCampaign: sql<boolean>`EXISTS (
      SELECT 1 FROM automation_runs o
      WHERE o.lead_id = l.id AND o.campaign_id IS NOT NULL AND o.automation_id <> ${cfg.automationId}
        AND o.status IN ('pending', 'running'))`,
    cooldown:
      cfg.cooldownHours > 0
        ? sql<boolean>`EXISTS (
            SELECT 1 FROM automation_runs r2
            JOIN automation_step_runs sr ON sr.automation_run_id = r2.id
            WHERE r2.lead_id = l.id AND r2.campaign_id IS NOT NULL AND sr.status = 'completed'
              AND sr.id = (SELECT min(x.id) FROM automation_step_runs x WHERE x.automation_run_id = r2.id)
              AND sr.finished_at > ${now}::timestamptz - make_interval(hours => ${cfg.cooldownHours}::int))`
        : sql<boolean>`(false)`,
  };
}

type Key = keyof ReturnType<typeof conditions>;

/** A regra de elegibilidade, UMA só: cada item diz se o lead precisa (true) ou não pode (false) ter a característica. */
const ELIGIBLE: readonly (readonly [Key, boolean])[] = [
  ['listArchived', false],
  ['statusOk', true],
  ['unassigned', true],
  ['anonymized', false],
  ['phoneOk', true],
  ['blocked', false],
  ['noWhatsapp', false],
  ['dddOk', true],
  ['resultOk', true],
  ['calledOk', true],
  ['participated', false],
  ['inOtherCampaign', false],
  ['cooldown', false],
];

/** Sobre os filtros que o gestor escolhe (e a validade do telefone): fora disto o lead está "fora do filtro". */
const FILTER_KEYS: readonly Key[] = ['statusOk', 'phoneOk', 'dddOk', 'resultOk', 'calledOk'];

const and = (list: Cond[]): Cond => sql<boolean>`(${sql.join(list, sql` AND `)})`;

/** A lista da campanha, ou todas (a regra `listArchived` já tira as listas arquivadas). */
const inList = (cfg: AudienceConfig): Cond =>
  cfg.listId === null ? sql<boolean>`(true)` : sql<boolean>`(l.list_id = ${cfg.listId})`;

/** A condição de elegibilidade montada com as condições dadas (as reais, ou as colunas de uma CTE). */
function eligibleWith(get: (key: Key) => Cond): Cond {
  return and(ELIGIBLE.map(([key, wanted]) => (wanted ? get(key) : sql<boolean>`NOT ${get(key)}`)));
}

/**
 * Os ids dos leads elegíveis, do menor para o maior id (ordem previsível, sem sorteio). Com `lock`, trava os leads
 * escolhidos (`FOR UPDATE SKIP LOCKED`): dois processos nunca reservam o mesmo lead.
 */
export async function getCampaignEligibleLeads(
  db: Db,
  cfg: AudienceConfig,
  now: Date,
  opts: { limit: number; lock?: boolean },
): Promise<number[]> {
  const c = conditions(cfg, now);
  const rows = await sql<{ id: number }>`
    SELECT l.id FROM leads l
    WHERE ${inList(cfg)} AND ${eligibleWith((k) => c[k])}
    ORDER BY l.id
    LIMIT ${opts.limit}
    ${opts.lock ? sql`FOR UPDATE OF l SKIP LOCKED` : sql``}`.execute(db);
  return rows.rows.map((r) => Number(r.id));
}

/**
 * Depois de travar o lead: ele continua livre de outra campanha? A pergunta usa uma consulta NOVA (o mesmo instante em que
 * a outra reserva já foi confirmada, se ela terminou antes de a trava soltar), o que fecha a corrida entre duas campanhas
 * que escolhem o mesmo lead no mesmo momento.
 */
export async function leadFreeOfOtherCampaign(
  db: Db,
  automationId: number,
  leadId: number,
): Promise<boolean> {
  const r = await sql<{ busy: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM automation_runs o
      WHERE o.lead_id = ${leadId} AND o.campaign_id IS NOT NULL AND o.automation_id <> ${automationId}
        AND o.status IN ('pending', 'running')) AS busy`.execute(db);
  return !r.rows[0]?.busy;
}

/** Quantos leads ainda podem entrar. */
export async function countCampaignEligibleLeads(db: Db, cfg: AudienceConfig, now: Date): Promise<number> {
  const c = conditions(cfg, now);
  const r = await sql<{ n: number }>`
    SELECT count(*) AS n FROM leads l WHERE ${inList(cfg)} AND ${eligibleWith((k) => c[k])}`.execute(db);
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * O público em números, numa consulta agregada (nenhum lead é carregado): cada condição é avaliada UMA vez por lead e
 * os contadores saem das colunas. `eligible` usa a mesma regra da reserva.
 */
export async function campaignAudienceSummary(
  db: Db,
  cfg: AudienceConfig,
  now: Date,
): Promise<CampaignAudience> {
  const c = conditions(cfg, now);
  const keys = Object.keys(c) as Key[];
  const columns = sql.join(
    keys.map((k) => sql`${c[k]} AS ${sql.ref(k)}`),
    sql`, `,
  );
  const ref = (k: Key): Cond => sql<boolean>`${sql.ref(`f.${k}`)}`;
  const filteredOut = sql<boolean>`NOT ${and(FILTER_KEYS.map((k) => ref(k)))}`;
  const r = await sql<Record<keyof CampaignAudience, number>>`
    WITH f AS (SELECT ${columns} FROM leads l WHERE ${inList(cfg)})
    SELECT
      count(*) AS "total",
      count(*) FILTER (WHERE ${eligibleWith(ref)}) AS "eligible",
      count(*) FILTER (WHERE ${ref('blocked')}) AS "blocked",
      count(*) FILTER (WHERE ${ref('noWhatsapp')}) AS "noWhatsapp",
      count(*) FILTER (WHERE ${ref('participated')} OR ${ref('inOtherCampaign')}) AS "participated",
      count(*) FILTER (WHERE ${ref('cooldown')}) AS "inCooldown",
      count(*) FILTER (WHERE ${ref('anonymized')}) AS "anonymized",
      count(*) FILTER (WHERE ${filteredOut}) AS "filteredOut"
    FROM f`.execute(db);
  const row = r.rows[0];
  return {
    total: Number(row?.total ?? 0),
    eligible: Number(row?.eligible ?? 0),
    blocked: Number(row?.blocked ?? 0),
    noWhatsapp: Number(row?.noWhatsapp ?? 0),
    participated: Number(row?.participated ?? 0),
    inCooldown: Number(row?.inCooldown ?? 0),
    anonymized: Number(row?.anonymized ?? 0),
    filteredOut: Number(row?.filteredOut ?? 0),
  };
}
