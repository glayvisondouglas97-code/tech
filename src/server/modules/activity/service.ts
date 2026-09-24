import { type Kysely, type RawBuilder, sql } from 'kysely';
import { z } from 'zod';
import { ACTIVITY_CATEGORIES, actionLabel } from '../../../shared/activity';
import type { ActivityItem, ActivitySummary, ActivityUserRow, Page } from '../../../shared/api';
import { resultLabel } from '../../../shared/results';
import type { AuthUser } from '../../auth/sessions';
import type { Database } from '../../db/schema';
import { CSV_BOM, csvLine } from '../../lib/csv';
import { formatDateTimeSP, spDateEnd, spDateStart, todayStampSP } from '../../lib/time';

type Db = Kysely<Database>;

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'data inválida');

export const periodSchema = z.object({
  from: ymd.optional(),
  to: ymd.optional(),
});

export const feedSchema = periodSchema.extend({
  userId: z.string().uuid().optional(),
  category: z.enum(Object.keys(ACTIVITY_CATEGORIES) as [string, ...string[]]).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** Linhas de donos ficam escondidas de quem não é dono (o dono tem privilégio master). */
export function hideOwnerRows(column: string): RawBuilder<boolean> {
  return sql<boolean>`(${sql.ref(column)} IS NULL OR ${sql.ref(column)} NOT IN (SELECT id FROM users WHERE role = 'dono'))`;
}

function period(p: { from?: string; to?: string }) {
  const from = p.from ?? todayStampSP();
  const to = p.to ?? from;
  return { from, to, start: spDateStart(from), end: spDateEnd(to) };
}

/**
 * Resumo por pessoa no período: pedidos de leads, leads puxados e recebidos, WhatsApp aberto,
 * chamados, resultados, observações, devoluções e bloqueios; mais o quadro por dia e o ranking.
 */
export async function activitySummary(
  db: Db,
  viewer: AuthUser,
  p: { from?: string; to?: string },
): Promise<ActivitySummary> {
  const { from, to, start, end } = period(p);
  const [events, received, requests, denied, daily, users] = await Promise.all([
    sql<{ user_id: string; type: string; n: number; sem_wa: number }>`
      SELECT e.user_id, e.type, count(*) AS n,
        count(*) FILTER (WHERE e.type = 'chamado' AND e.data->>'resultado' = 'sem_whatsapp') AS sem_wa
      FROM lead_events e
      WHERE e.created_at >= ${start} AND e.created_at < ${end} AND e.user_id IS NOT NULL
      GROUP BY e.user_id, e.type`.execute(db),
    sql<{ user_id: string; n: number }>`
      SELECT (e.data->>'para')::uuid AS user_id, count(*) AS n
      FROM lead_events e
      WHERE e.created_at >= ${start} AND e.created_at < ${end}
        AND e.type IN ('importado', 'atribuido') AND e.data->>'para' IS NOT NULL
      GROUP BY 1`.execute(db),
    sql<{ user_id: string; n: number }>`
      SELECT a.user_id, count(*) AS n FROM audit_log a
      WHERE a.action = 'pediu_leads' AND a.created_at >= ${start} AND a.created_at < ${end}
      GROUP BY a.user_id`.execute(db),
    sql<{ user_id: string; n: number }>`
      SELECT a.user_id, count(*) AS n FROM audit_log a
      WHERE a.action = 'acesso_negado' AND a.created_at >= ${start} AND a.created_at < ${end}
      GROUP BY a.user_id`.execute(db),
    sql<{ day: string; user_id: string; puxados: number; chamados: number }>`
      SELECT to_char((e.created_at AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS day, e.user_id,
        count(*) FILTER (WHERE e.type = 'pegou') AS puxados,
        count(*) FILTER (WHERE e.type = 'chamado' AND e.data->>'resultado' <> 'sem_whatsapp') AS chamados
      FROM lead_events e
      WHERE e.created_at >= ${start} AND e.created_at < ${end} AND e.user_id IS NOT NULL
        AND e.type IN ('pegou', 'chamado')
      GROUP BY 1, 2
      ORDER BY 1 DESC, 3 DESC`.execute(db),
    db.selectFrom('users').select(['id', 'name', 'role', 'active']).orderBy('name').execute(),
  ]);

  const visible = users.filter((u) => viewer.role === 'dono' || u.role !== 'dono');
  const visibleIds = new Set(visible.map((u) => u.id));
  const rows = new Map<string, ActivityUserRow>();
  for (const u of visible) {
    rows.set(u.id, {
      user: { id: u.id, name: u.name, role: u.role, active: u.active },
      pedidos: 0,
      puxados: 0,
      recebidos: 0,
      abriuWhatsapp: 0,
      chamados: 0,
      semWhatsapp: 0,
      resultados: 0,
      observacoes: 0,
      devolvidos: 0,
      bloqueios: 0,
      acessosNegados: 0,
      acoes: 0,
    });
  }
  for (const e of events.rows) {
    const r = rows.get(e.user_id);
    if (!r) continue;
    r.acoes += e.n;
    if (e.type === 'pegou') r.puxados += e.n;
    else if (e.type === 'abriu_whatsapp') r.abriuWhatsapp += e.n;
    else if (e.type === 'chamado') {
      r.chamados += e.n - e.sem_wa;
      r.semWhatsapp += e.sem_wa;
    } else if (e.type === 'resultado') r.resultados += e.n;
    else if (e.type === 'observacao') r.observacoes += e.n;
    else if (e.type === 'devolvido' || e.type === 'desfeito') r.devolvidos += e.n;
    else if (e.type === 'bloqueado') r.bloqueios += e.n;
  }
  for (const x of received.rows) {
    const r = rows.get(x.user_id);
    if (r) r.recebidos += x.n;
  }
  for (const x of requests.rows) {
    const r = rows.get(x.user_id);
    if (r) {
      r.pedidos += x.n;
      r.acoes += x.n;
    }
  }
  for (const x of denied.rows) {
    const r = rows.get(x.user_id);
    if (r) {
      r.acessosNegados += x.n;
      r.acoes += x.n;
    }
  }
  const list = [...rows.values()]
    .filter((r) => r.acoes > 0 || r.recebidos > 0 || (r.user.active && r.user.role === 'atendente'))
    .sort(
      (a, b) => b.puxados - a.puxados || b.chamados - a.chamados || a.user.name.localeCompare(b.user.name),
    );
  const top = (key: 'puxados' | 'chamados') => {
    const best = [...list].sort((a, b) => b[key] - a[key])[0];
    return best && best[key] > 0
      ? { user: { id: best.user.id, name: best.user.name }, count: best[key] }
      : null;
  };
  const names = new Map(users.map((u) => [u.id, u.name]));
  return {
    from,
    to,
    users: list,
    daily: daily.rows
      .filter((d) => visibleIds.has(d.user_id))
      .map((d) => ({
        day: d.day,
        user: { id: d.user_id, name: names.get(d.user_id) ?? 'Usuário removido' },
        puxados: d.puxados,
        chamados: d.chamados,
      })),
    topPuller: top('puxados'),
    topCaller: top('chamados'),
  };
}

function feedQuery(viewer: AuthUser, f: z.infer<typeof feedSchema>) {
  const { start, end } = period(f);
  const actions = f.category
    ? (ACTIVITY_CATEGORIES[f.category as keyof typeof ACTIVITY_CATEGORIES].actions as readonly string[])
    : null;
  const byUser = (col: string) => (f.userId ? sql`AND ${sql.ref(col)} = ${f.userId}::uuid` : sql``);
  const byAction = (col: string) =>
    actions ? sql`AND ${sql.ref(col)} = ANY(${[...actions]}::text[])` : sql``;
  const owners = viewer.role === 'dono' ? sql`` : sql`WHERE ${hideOwnerRows('x.user_id')}`;
  return sql`
    SELECT x.* FROM (
      SELECT 'e' || e.id AS id, e.created_at, e.user_id, e.type AS action, e.data AS details,
        e.lead_id, l.company AS lead_company, l.name AS lead_name, NULL::text AS ip
      FROM lead_events e LEFT JOIN leads l ON l.id = e.lead_id
      WHERE e.created_at >= ${start} AND e.created_at < ${end} ${byUser('e.user_id')} ${byAction('e.type')}
      UNION ALL
      SELECT 'a' || a.id, a.created_at, a.user_id, a.action, a.details, NULL, NULL, NULL, a.ip
      FROM audit_log a
      WHERE a.created_at >= ${start} AND a.created_at < ${end} ${byUser('a.user_id')} ${byAction('a.action')}
    ) x ${owners}`;
}

interface FeedRow {
  id: string;
  created_at: Date;
  user_id: string | null;
  action: string;
  details: Record<string, unknown> | null;
  lead_id: number | null;
  lead_company: string | null;
  lead_name: string | null;
  ip: string | null;
}

async function withUserNames(db: Db, rows: FeedRow[]): Promise<ActivityItem[]> {
  const ids = [...new Set(rows.map((r) => r.user_id).filter((x): x is string => !!x))];
  const users = ids.length
    ? await db.selectFrom('users').select(['id', 'name']).where('id', 'in', ids).execute()
    : [];
  const names = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at.toISOString(),
    user: r.user_id ? { id: r.user_id, name: names.get(r.user_id) ?? 'Usuário removido' } : null,
    action: r.action,
    details: r.details ?? {},
    lead: r.lead_id ? { id: r.lead_id, company: r.lead_company ?? '', name: r.lead_name ?? '' } : null,
    ip: r.ip,
  }));
}

/** Registro detalhado: histórico de todos os leads + acessos e ações de gestão, do mais novo para o mais antigo. */
export async function activityFeed(
  db: Db,
  viewer: AuthUser,
  f: z.infer<typeof feedSchema>,
): Promise<Page<ActivityItem>> {
  const base = feedQuery(viewer, f);
  const [rows, count] = await Promise.all([
    sql<FeedRow>`${base} ORDER BY x.created_at DESC, x.id DESC LIMIT ${f.pageSize} OFFSET ${(f.page - 1) * f.pageSize}`.execute(
      db,
    ),
    sql<{ n: number }>`SELECT count(*) AS n FROM (${base}) c`.execute(db),
  ]);
  return {
    items: await withUserNames(db, rows.rows),
    total: count.rows[0]?.n ?? 0,
    page: f.page,
    pageSize: f.pageSize,
  };
}

/** Texto curto dos detalhes de uma ação, para a planilha. */
export function describeDetails(action: string, d: Record<string, unknown>): string {
  const parts: string[] = [];
  if (action === 'pediu_leads') parts.push(`pediu ${d.solicitados}, recebeu ${d.recebidos}, DDD ${d.ddd}`);
  else if (action === 'chamado') parts.push(resultLabel(String(d.resultado ?? 'enviado')));
  else if (action === 'resultado')
    parts.push(`${d.de ? resultLabel(String(d.de)) : '—'} → ${resultLabel(String(d.para))}`);
  else if (action === 'atribuido' || action === 'importado') {
    if (d.para_nome) parts.push(`para ${d.para_nome}`);
    if (d.de_nome) parts.push(`estava com ${d.de_nome}`);
    if (d.lista) parts.push(`lista ${d.lista}`);
  } else if (action === 'devolvido' || action === 'expirado') {
    if (d.de_nome) parts.push(`estava com ${d.de_nome}`);
    if (d.motivo) parts.push(String(d.motivo));
  } else if (action === 'observacao') parts.push(String(d.texto ?? ''));
  else if (action === 'acesso_negado') parts.push(`${d.metodo} ${d.rota}`);
  else {
    for (const [k, v] of Object.entries(d)) {
      if (v === null || v === undefined || typeof v === 'object') continue;
      parts.push(`${k.replace(/_/g, ' ')}: ${v}`);
    }
  }
  return parts.join(' · ');
}

/** Planilha da auditoria (CSV com ; e BOM). Até 100 mil linhas por vez. */
export async function activityCsv(
  db: Db,
  viewer: AuthUser,
  f: z.infer<typeof feedSchema>,
): Promise<{ fileName: string; body: string }> {
  const rows =
    await sql<FeedRow>`${feedQuery(viewer, f)} ORDER BY x.created_at DESC, x.id DESC LIMIT 100000`.execute(
      db,
    );
  const items = await withUserNames(db, rows.rows);
  let body = CSV_BOM + csvLine(['Quando', 'Quem', 'Ação', 'Empresa', 'Sócio', 'Detalhes', 'IP']);
  for (const i of items) {
    body += csvLine([
      formatDateTimeSP(i.createdAt),
      i.user?.name ?? 'Sistema',
      actionLabel(i.action),
      i.lead?.company ?? '',
      i.lead?.name ?? '',
      describeDetails(i.action, i.details),
      i.ip ?? '',
    ]);
  }
  const p = period(f);
  return { fileName: `auditoria-${p.from}${p.to !== p.from ? `-a-${p.to}` : ''}.csv`, body };
}
