const fs = require('fs');
const ed = (p, pairs) => {
  let s = fs.readFileSync(p, 'utf8');
  for (const [a, b] of pairs) {
    if (!s.includes(a)) throw new Error(`${p}: não achei ${a.slice(0, 60)}`);
    s = s.replace(a, b);
  }
  fs.writeFileSync(p, s);
};
ed('src/shared/api.ts', [
  [
    '  conversao: number | null;\n  fila: number;\n}',
    '  conversao: number | null;\n  fila: number;\n  /** Últimos 14 dias, do mais antigo para hoje: chamados e "sem WhatsApp" por dia. */\n  spark: { chamados: number[]; semWhatsapp: number[] };\n}',
  ],
  [
    '  daily: { day: string; count: number }[];',
    '  daily: { day: string; count: number; semWhatsapp: number }[];',
  ],
]);
const p = 'src/server/modules/dashboard/service.ts';
ed(p, [
  [
    '  const [per, queues, users, totals, results, lists, daily, settings] = await Promise.all([',
    '  const [per, queues, users, totals, results, lists, daily, settings, perDay] = await Promise.all([',
  ],
  [
    `    sql<{ day: string; n: number }>\`
      WITH c AS (
        SELECT (l.called_at AT TIME ZONE 'America/Sao_Paulo')::date AS day, count(*) AS n
        FROM leads l
        WHERE l.called_at >= \${spDayStart(13)} AND l.result <> 'sem_whatsapp' \${onlyMe}
        GROUP BY 1
      )
      SELECT to_char(d.day, 'YYYY-MM-DD') AS day, coalesce(c.n, 0) AS n`,
    `    sql<{ day: string; n: number; s: number }>\`
      WITH c AS (
        SELECT (l.called_at AT TIME ZONE 'America/Sao_Paulo')::date AS day,
          count(*) FILTER (WHERE l.result <> 'sem_whatsapp') AS n,
          count(*) FILTER (WHERE l.result = 'sem_whatsapp') AS s
        FROM leads l
        WHERE l.called_at >= \${spDayStart(13)} \${onlyMe}
        GROUP BY 1
      )
      SELECT to_char(d.day, 'YYYY-MM-DD') AS day, coalesce(c.n, 0) AS n, coalesce(c.s, 0) AS s`,
  ],
  [
    '    getSettings(db),\n  ]);',
    `    getSettings(db),
    sql<{ user_id: string; day: string; n: number; s: number }>\`
      SELECT l.called_by AS user_id,
        to_char((l.called_at AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS day,
        count(*) FILTER (WHERE l.result <> 'sem_whatsapp') AS n,
        count(*) FILTER (WHERE l.result = 'sem_whatsapp') AS s
      FROM leads l
      WHERE l.called_at >= \${spDayStart(13)} AND l.called_by IS NOT NULL \${onlyMe}
      GROUP BY 1, 2\`.execute(db),
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
  }`,
  ],
  [
    '        fila: queueBy.get(u.id) ?? 0,\n      };',
    '        fila: queueBy.get(u.id) ?? 0,\n        spark: sparkBy.get(u.id) ?? { chamados: days.map(() => 0), semWhatsapp: days.map(() => 0) },\n      };',
  ],
  [
    '    daily: daily.rows.map((d) => ({ day: d.day, count: d.n })),',
    '    daily: daily.rows.map((d) => ({ day: d.day, count: d.n, semWhatsapp: d.s })),',
  ],
]);
console.log('ok');
