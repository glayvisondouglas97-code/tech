import { type Kysely, sql } from 'kysely';
import type { AttendantStats, Dashboard, ListProgress } from '../../../shared/api';
import { RESULTS, type ResultId } from '../../../shared/results';
import { can } from '../../../shared/roles';
import type { AuthUser } from '../../auth/sessions';
import type { Database } from '../../db/schema';
import { spDayStart } from '../../lib/time';
import { getSettings } from '../settings/service';

type Db = Kysely<Database>;

/**
 * Painel. "Chamados" não conta "Sem WhatsApp" (número inválido não é contato).
 * Gestor e supervisor veem a equipe toda; o atendente vê só os próprios números.
 */
export async function getDashboard(db: Db, user: AuthUser): Promise<Dashboard> {
  const all = can.seeAllLeads(user.role);
  const onlyMe = all ? sql`` : sql`AND l.called_by = ${user.id}`;
  const onlyMeQueue = all ? sql`` : sql`AND l.assigned_to = ${user.id}`;

  const [per, queues, users, totals, results, lists, daily, settings, perDay] = await Promise.all([
    sql<{
      user_id: string;
      hoje: number;
      d7: number;
      d30: number;
      total: number;
      interessados: number;
      fechados: number;
      sem_whatsapp: number;
    }>`
      SELECT l.called_by AS user_id,
        count(*) FILTER (WHERE l.called_at >= ${spDayStart(0)} AND l.result <> 'sem_whatsapp') AS hoje,
        count(*) FILTER (WHERE l.called_at >= ${spDayStart(6)} AND l.result <> 'sem_whatsapp') AS d7,
        count(*) FILTER (WHERE l.called_at >= ${spDayStart(29)} AND l.result <> 'sem_whatsapp') AS d30,
        count(*) FILTER (WHERE l.result <> 'sem_whatsapp') AS total,
        count(*) FILTER (WHERE l.result = 'interessado') AS interessados,
        count(*) FILTER (WHERE l.result = 'fechou') AS fechados,
        count(*) FILTER (WHERE l.result = 'sem_whatsapp') AS sem_whatsapp
      FROM leads l
      WHERE l.called_at IS NOT NULL AND l.called_by IS NOT NULL ${onlyMe}
      GROUP BY l.called_by`.execute(db),
    sql<{ user_id: string; n: number }>`
      SELECT l.assigned_to AS user_id, count(*) AS n FROM leads l
      WHERE l.status = 'pendente' AND l.assigned_to IS NOT NULL ${onlyMeQueue}
      GROUP BY l.assigned_to`.execute(db),
    db.selectFrom('users').select(['id', 'name', 'role', 'active']).orderBy('name').execute(),
    sql<{
      leads: number;
      chamados: number;
      sem_whatsapp: number;
      com_atendentes: number;
      livres: number;
      bloqueados: number;
      hoje: number;
      listas: number;
    }>`
      SELECT count(*) AS leads,
        count(*) FILTER (WHERE l.called_at IS NOT NULL AND l.result <> 'sem_whatsapp') AS chamados,
        count(*) FILTER (WHERE l.called_at IS NOT NULL AND l.result = 'sem_whatsapp') AS sem_whatsapp,
        count(*) FILTER (WHERE l.status = 'pendente' AND l.assigned_to IS NOT NULL) AS com_atendentes,
        count(*) FILTER (WHERE l.status = 'pendente' AND l.assigned_to IS NULL) AS livres,
        count(*) FILTER (WHERE l.status = 'bloqueado' AND l.called_at IS NULL) AS bloqueados,
        count(*) FILTER (WHERE l.called_at >= ${spDayStart(0)} AND l.result <> 'sem_whatsapp') AS hoje,
        count(DISTINCT l.list_id) AS listas
      FROM leads l JOIN lists li ON li.id = l.list_id
      WHERE li.archived_at IS NULL`.execute(db),
    sql<{ result: ResultId; n: number }>`
      SELECT l.result, count(*) AS n FROM leads l
      WHERE l.called_at IS NOT NULL ${onlyMe}
      GROUP BY l.result`.execute(db),
    all ? listProgress(db, false) : Promise.resolve([] as ListProgress[]),
    sql<{ day: string; n: number; s: number }>`
      WITH c AS (
        SELECT (l.called_at AT TIME ZONE 'America/Sao_Paulo')::date AS day,
          count(*) FILTER (WHERE l.result <> 'sem_whatsapp') AS n,
          count(*) FILTER (WHERE l.result = 'sem_whatsapp') AS s
        FROM leads l
        WHERE l.called_at >= ${spDayStart(13)} ${onlyMe}
        GROUP BY 1
      )
      SELECT to_char(d.day, 'YYYY-MM-DD') AS day, coalesce(c.n, 0) AS n, coalesce(c.s, 0) AS s
      FROM generate_series(
        (date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') - interval '13 days')::date,
        date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo')::date, interval '1 day') AS d(day)
      LEFT JOIN c ON c.day = d.day::date
      ORDER BY d.day`.execute(db),
    getSettings(db),
    sql<{ user_id: string; day: string; n: number; s: number }>`
      SELECT l.called_by AS user_id,
        to_char((l.called_at AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS day,
        count(*) FILTER (WHERE l.result <> 'sem_whatsapp') AS n,
        count(*) FILTER (WHERE l.result = 'sem_whatsapp') AS s
      FROM leads l
      WHERE l.called_at >= ${spDayStart(13)} AND l.called_by IS NOT NULL ${onlyMe}
      GROUP BY 1, 2`.execute(db),
  ]);
  const days = daily.rows.map((d) => d.day);
  const sparkBy = new Map<string, { chamados: number[]; semWhatsapp: number[] }>();
  for (const r of perDay.rows) {
    const i = days.indexOf(r.day);
    if (i < 0) continue;
    let sp = sparkBy.get(r.user_id);
    if (!sp) {
      sp = { chamados: days.map(() => 0), semWhatsapp: days.map(() => 0) };
      sparkBy.set(r.user_id, sp);
    }
    sp.chamados[i] = r.n;
    sp.semWhatsapp[i] = r.s;
  }

  const staleHours = settings.expire_hours || 24;
  const stale = all
    ? await sql<{ n: number }>`
        SELECT count(*) AS n FROM leads
        WHERE status = 'pendente' AND assigned_to IS NOT NULL
          AND assigned_at < now() - make_interval(hours => ${staleHours}::int)`.execute(db)
    : { rows: [{ n: 0 }] };

  const queueBy = new Map(queues.rows.map((r) => [r.user_id, r.n]));
  const perBy = new Map(per.rows.map((r) => [r.user_id, r]));
  const perAttendant: AttendantStats[] = users
    .filter((u) => (all ? true : u.id === user.id))
    .map((u) => {
      const p = perBy.get(u.id);
      const total = p?.total ?? 0;
      return {
        user: { id: u.id, name: u.name, role: u.role, active: u.active },
        hoje: p?.hoje ?? 0,
        d7: p?.d7 ?? 0,
        d30: p?.d30 ?? 0,
        total,
        interessados: p?.interessados ?? 0,
        fechados: p?.fechados ?? 0,
        semWhatsapp: p?.sem_whatsapp ?? 0,
        conversao: total ? Math.round(((p?.fechados ?? 0) / total) * 1000) / 10 : null,
        fila: queueBy.get(u.id) ?? 0,
        spark: sparkBy.get(u.id) ?? { chamados: days.map(() => 0), semWhatsapp: days.map(() => 0) },
      };
    })
    .filter((a) => a.user.active || a.total || a.fila || a.semWhatsapp)
    .sort((a, b) => b.hoje - a.hoje || b.d7 - a.d7 || a.user.name.localeCompare(b.user.name, 'pt-BR'));

  const t = totals.rows[0];
  const resultCounts = new Map(results.rows.map((r) => [r.result, r.n]));
  return {
    totals: all
      ? {
          leads: t?.leads ?? 0,
          chamados: t?.chamados ?? 0,
          semWhatsapp: t?.sem_whatsapp ?? 0,
          comAtendentes: t?.com_atendentes ?? 0,
          livres: t?.livres ?? 0,
          bloqueados: t?.bloqueados ?? 0,
          hoje: t?.hoje ?? 0,
          listas: t?.listas ?? 0,
        }
      : {
          leads: 0,
          chamados: perAttendant[0]?.total ?? 0,
          semWhatsapp: perAttendant[0]?.semWhatsapp ?? 0,
          comAtendentes: perAttendant[0]?.fila ?? 0,
          livres: 0,
          bloqueados: 0,
          hoje: perAttendant[0]?.hoje ?? 0,
          listas: 0,
        },
    perAttendant,
    results: RESULTS.map((r) => ({ result: r.id, count: resultCounts.get(r.id) ?? 0 })),
    lists,
    daily: daily.rows.map((d) => ({ day: d.day, count: d.n, semWhatsapp: d.s })),
    stale: { count: stale.rows[0]?.n ?? 0, hours: staleHours },
    generatedAt: new Date().toISOString(),
  };
}

export async function listProgress(db: Db, includeArchived: boolean): Promise<ListProgress[]> {
  const rows = await sql<{
    id: string;
    name: string;
    created_at: Date;
    archived_at: Date | null;
    total: number;
    empresas: number;
    telefones: number;
    empresas_livres: number;
    chamados: number;
    sem_whatsapp: number;
    com_atendentes: number;
    livres: number;
    bloqueados: number;
  }>`
    SELECT li.id, li.name, li.created_at, li.archived_at,
      count(l.id) AS total,
      count(DISTINCT CASE WHEN l.company_search <> '' THEN l.company_search ELSE 'lead:' || l.id END) AS empresas,
      count(l.id) + coalesce(sum(cardinality(l.extra_phones)), 0) AS telefones,
      count(DISTINCT CASE WHEN l.company_search <> '' THEN l.company_search ELSE 'lead:' || l.id END)
        FILTER (WHERE l.status = 'pendente' AND l.assigned_to IS NULL) AS empresas_livres,
      count(l.id) FILTER (WHERE l.called_at IS NOT NULL AND l.result <> 'sem_whatsapp') AS chamados,
      count(l.id) FILTER (WHERE l.called_at IS NOT NULL AND l.result = 'sem_whatsapp') AS sem_whatsapp,
      count(l.id) FILTER (WHERE l.status = 'pendente' AND l.assigned_to IS NOT NULL) AS com_atendentes,
      count(l.id) FILTER (WHERE l.status = 'pendente' AND l.assigned_to IS NULL) AS livres,
      count(l.id) FILTER (WHERE l.status = 'bloqueado' AND l.called_at IS NULL) AS bloqueados
    FROM lists li LEFT JOIN leads l ON l.list_id = li.id
    ${includeArchived ? sql`` : sql`WHERE li.archived_at IS NULL`}
    GROUP BY li.id
    ORDER BY li.created_at DESC`.execute(db);
  return rows.rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at.toISOString(),
    archived: !!r.archived_at,
    total: r.total,
    empresas: r.empresas,
    telefones: r.telefones,
    empresasLivres: r.empresas_livres,
    chamados: r.chamados,
    semWhatsapp: r.sem_whatsapp,
    comAtendentes: r.com_atendentes,
    livres: r.livres,
    bloqueados: r.bloqueados,
  }));
}
