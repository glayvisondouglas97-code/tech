import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Guardas de arquitetura da cota e do envio automático: as regras que a auditoria final conferiu no código e que não
// podem voltar atrás sem um teste falhar. São leituras do código-fonte, não do banco.

const ROOT = join(__dirname, '..', '..', 'src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}
const text = (path: string) => readFileSync(path, 'utf-8');
const rel = (path: string) => relative(ROOT, path).replaceAll('\\', '/');
const allSources = sources(ROOT);

describe('cota: um único contador, no banco, e uma única regra', () => {
  it('só `whatsapp/quota.ts` grava em wa_instance_daily_usage (fora as migrações); os outros só leem', () => {
    const writers = allSources
      .filter((file) => !rel(file).startsWith('server/db/migrations/'))
      .filter((file) =>
        /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+wa_instance_daily_usage|(insertInto|updateTable|deleteFrom)\(\s*['"]wa_instance_daily_usage/i.test(
          text(file),
        ),
      )
      .map(rel);
    expect(writers).toEqual(['server/modules/whatsapp/quota.ts']);
  });

  it('nenhum módulo de campanha, automação ou cota cria timer (a contagem mora no banco: ver o teste de reinício)', () => {
    const files = allSources.filter((file) => {
      const r = rel(file);
      return r.startsWith('server/modules/automations/') || r === 'server/modules/whatsapp/quota.ts';
    });
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const code = text(file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(code, rel(file)).not.toMatch(/\bset(Interval|Timeout)\s*\(/);
    }
  });

  it('a cota do dia é sempre a do dia de São Paulo (`quotaDate`/`spDate`), nunca CURRENT_DATE ou o fuso do servidor', () => {
    for (const file of [
      'server/modules/whatsapp/quota.ts',
      'server/modules/whatsapp/messaging.ts',
      'server/modules/automations/executor.ts',
    ]) {
      const code = text(join(ROOT, file));
      expect(code, file).not.toMatch(
        /CURRENT_DATE|toLocaleDateString\(|new Date\(\)\.toISOString\(\)\.slice/,
      );
    }
  });

  it('a cota não usa o limite de "pegar leads" (daily_pull_limit)', () => {
    for (const file of allSources) {
      const r = rel(file);
      if (r.startsWith('server/modules/automations/') || r === 'server/modules/whatsapp/quota.ts') {
        expect(text(file), r).not.toMatch(/daily_pull_limit|dailyPullLimit/);
      }
    }
  });

  it('Chamar, /run e campanha passam pelas MESMAS funções da cota (claim, confirm, release, checkInstanceDailyQuota)', () => {
    const messaging = text(join(ROOT, 'server/modules/whatsapp/messaging.ts'));
    const executor = text(join(ROOT, 'server/modules/automations/executor.ts'));
    const triggers = text(join(ROOT, 'server/modules/automations/triggers.ts'));
    const leads = text(join(ROOT, 'server/modules/whatsapp/leads.ts'));
    expect(messaging).toMatch(/claimContactQuota\(/);
    expect(messaging).toMatch(/confirmContactQuota\(/);
    expect(messaging).toMatch(/releaseContactQuota\(/);
    expect(executor).toMatch(/claimContactQuota\(/);
    expect(executor).toMatch(/confirmContactQuota\(/);
    expect(executor).toMatch(/releaseContactQuota\(/);
    expect(triggers).toMatch(/checkInstanceDailyQuota\(/); // /run: pré-checagem antes de criar a participação
    expect(leads).toMatch(/checkInstanceDailyQuota\(/); // Chamar: conferência antes de abrir o WhatsApp do lead
    // O executor não tem uma regra de cota própria: o teto e o contador vêm de quota.ts.
    expect(executor).not.toMatch(/total_contacts/);
    expect(messaging).not.toMatch(/total_contacts/);
  });
});

describe('scheduler: um job de automações, sem timer por lead ou por campanha', () => {
  it('startJobs cria exatamente 3 intervalos (leads parados, limpeza e automações), qualquer que seja o número de campanhas', async () => {
    const { startJobs } = await import('../../src/server/jobs/scheduler');
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    const log = { info: () => {}, error: () => {} };
    const stop = startJobs({} as never, log as never);
    try {
      expect(intervals).toHaveBeenCalledTimes(3);
      expect(timeouts.mock.calls.length).toBeLessThanOrEqual(3); // só as primeiras execuções, sem timer por lead
    } finally {
      stop();
      intervals.mockRestore();
      timeouts.mockRestore();
    }
  });

  it('o job de automações reserva (fila) e envia (executor) no mesmo ciclo, sob uma trava própria do PostgreSQL', () => {
    const code = text(join(ROOT, 'server/jobs/scheduler.ts'));
    expect(code.match(/advanceCampaigns\(/g)).toHaveLength(1);
    expect(code.match(/runAutomationCycle\(/g)).toHaveLength(1);
    // Trava de sessão (sem transação aberta durante o ciclo) e sempre solta no fim.
    expect(code).toMatch(/pg_try_advisory_lock/);
    expect(code).toMatch(/pg_advisory_unlock/);
    expect(code).not.toMatch(/pg_try_advisory_xact_lock/);
    expect(code).toMatch(/AUTOMATION_LOCK/);
  });

  it('o servidor só inicia os jobs com JOBS_ENABLED', () => {
    expect(text(join(ROOT, 'server/index.ts'))).toMatch(/config\.JOBS_ENABLED\s*\?\s*startJobs\(/);
  });
});
