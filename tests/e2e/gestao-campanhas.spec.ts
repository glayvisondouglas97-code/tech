import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { seedTodayUsage } from './db';

/**
 * Campanha de automação, pela tela: a gestora monta uma automação com áudio sorteado, abre "Nova campanha",
 * escolhe a lista e o número, vê a prévia (quantos leads entram, capacidade por dia), confere o resumo final, inicia,
 * recarrega, pausa, retoma e encerra. Roda depois do fluxo principal (que cria a lista "Campanha E2E" e o número whatsapp-01).
 *
 * O servidor dos testes de ponta a ponta roda com JOBS_ENABLED=false: o job que reserva leads e envia não roda aqui,
 * então este teste prova a TELA e a API (nada é enviado). O envio, o limite por dia e o horário são provados nos
 * testes de integração (tests/integration/automations-campaigns.test.ts), com relógio injetado.
 */

const ADMIN = { email: 'gestora@e2e.teste', password: 'senha-e2e-123' };
const SHOTS = resolve('test-results/telas');
mkdirSync(SHOTS, { recursive: true });

async function shot(page: Page, name: string) {
  await page.waitForTimeout(450);
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`), fullPage: true });
}

/** WAV curtinho e válido (silêncio) para o áudio da biblioteca. */
function tinyWav(): Buffer {
  const dataSize = 800;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(8000, 24);
  buf.writeUInt32LE(8000, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  buf.fill(128, 44);
  return buf;
}

async function csrfOf(page: Page): Promise<string> {
  return (await (await page.request.get('/api/auth/me')).json()).csrfToken;
}

async function noSideScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe.configure({ mode: 'serial' });

let admin: Page;
let automationId = 0;

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  admin = await context.newPage();
  await admin.goto('/entrar');
  await admin.getByLabel('E-mail').fill(ADMIN.email);
  await admin.getByLabel('Senha').fill(ADMIN.password);
  await admin.getByRole('button', { name: 'Entrar' }).click();
  await expect(admin).toHaveURL(/\/chamar$/);

  const headers = { 'x-csrf-token': await csrfOf(admin) };
  // Dois áudios ativos na biblioteca (o sorteio precisa de pelo menos um).
  for (const label of ['Campanha — áudio 1', 'Campanha — áudio 2']) {
    const audio = await admin.request.post(`/api/audios?label=${encodeURIComponent(label)}&seconds=1`, {
      headers: { ...headers, 'content-type': 'audio/wav' },
      data: tinyWav(),
    });
    expect(audio.ok(), await audio.text()).toBe(true);
  }
  // A automação: uma etapa de áudio SORTEADO, ativa.
  const created = await admin.request.post('/api/automations', {
    headers,
    data: { name: 'Primeiro contato por áudio', trigger: 'manual' },
  });
  automationId = (await created.json()).id;
  const step = await admin.request.post(`/api/automations/${automationId}/steps`, {
    headers,
    data: { actionType: 'send_audio', delaySeconds: 0, audioMode: 'random', conditions: [] },
  });
  expect(step.status(), await step.text()).toBe(201);
  const active = await admin.request.patch(`/api/automations/${automationId}/status`, {
    headers,
    data: { status: 'active' },
  });
  expect(active.status(), await active.text()).toBe(200);
});

const dialog = () => admin.getByRole('dialog', { name: 'Nova campanha' });
const summary = () => admin.getByRole('dialog', { name: 'Resumo da campanha' });
const panel = () => admin.getByRole('region', { name: 'Campanha' });

test('a etapa de áudio sorteado aparece no editor e o painel da campanha começa vazio', async () => {
  await admin.goto(`/automacoes/${automationId}`);
  await expect(admin.getByRole('heading', { name: 'Primeiro contato por áudio', level: 1 })).toBeVisible();
  await expect(admin.getByText('Sorteia um áudio a cada envio')).toBeVisible();
  await expect(admin.getByText(/\d+ áudios ativos na biblioteca/)).toBeVisible();
  await expect(panel().getByText('Nenhuma campanha em andamento')).toBeVisible();
  await expect(panel().getByRole('button', { name: 'Nova campanha' })).toBeEnabled();
  await shot(admin, 'c01-campanha-vazia');
});

test('janela "Nova campanha": aviso de risco, padrões, prévia com números do servidor e validação do horário', async () => {
  await panel().getByRole('button', { name: 'Nova campanha' }).click();
  const dlg = dialog();
  await expect(dlg).toBeVisible();
  // O risco é dito abertamente, sem prometer proteção.
  await expect(dlg.getByText(/pode levar o WhatsApp a restringir ou banir o número/)).toBeVisible();
  await expect(dlg.getByText(/não garantem/)).toBeVisible();
  // Padrões: 10:00 às 16:00 e 20 contatos por número por dia (o limite de qualquer número).
  await expect(dlg.getByLabel('Horário de trabalho: das')).toHaveValue('10:00');
  await expect(dlg.getByLabel('até', { exact: true })).toHaveValue('16:00');
  await expect(dlg.getByLabel('Contatos por número, por dia (no máximo 20)')).toHaveValue('20');
  // Segunda a sexta e cooldown de 24 horas são o padrão; iniciar agora é a escolha inicial.
  for (const day of [1, 2, 3, 4, 5]) await expect(dlg.getByTestId(`dia-${day}`)).toBeChecked();
  for (const day of [6, 7]) await expect(dlg.getByTestId(`dia-${day}`)).not.toBeChecked();
  await expect(dlg.getByTestId('campo-cooldown')).toHaveValue('24');
  await expect(dlg.getByTestId('quando-agora')).toBeChecked();
  // Sem escolher lista e número, o botão fica desligado e a prévia pede a escolha.
  await expect(dlg.getByRole('button', { name: 'Revisar e continuar' })).toBeDisabled();
  await expect(dlg.getByText(/Escolha a lista e pelo menos um número/)).toBeVisible();

  const lists = (await (await admin.request.get('/api/lists?archived=0')).json()) as {
    id: string;
    name: string;
  }[];
  const listId = lists.find((l) => l.name === 'Campanha E2E')?.id as string;
  expect(listId).toBeTruthy();
  await dlg.getByLabel('Lista de leads').selectOption(listId);
  await dlg.getByRole('button', { name: 'Marcar os conectados' }).click();
  await expect(dlg.getByTestId('preview-eligible')).toBeVisible({ timeout: 20_000 });
  const eligible = Number(
    ((await dlg.getByTestId('preview-eligible').textContent()) ?? '').replace(/\D/g, ''),
  );
  expect(eligible).toBeGreaterThan(0);
  // Todos os números marcados estão conectados: a capacidade é (números conectados) x 20 leads por dia.
  await expect(dlg.getByTestId('preview-connected')).toHaveText(/^(\d+) de \1$/);
  const connected = Number(((await dlg.getByTestId('preview-connected').textContent()) ?? '').split(' ')[0]);
  expect(connected).toBeGreaterThan(0);
  await expect(dlg.getByTestId('preview-capacity')).toContainText(`${connected * 20} leads`);
  await shot(admin, 'c02-campanha-dialogo');

  // O limite muda a capacidade (vinda do servidor); o horário invertido desliga o botão.
  await dlg.getByLabel('Contatos por número, por dia (no máximo 20)').fill('5');
  await expect(dlg.getByTestId('preview-capacity')).toContainText(`${connected * 5} lead`);
  await dlg.getByLabel('Horário de trabalho: das').fill('16:00');
  await dlg.getByLabel('até', { exact: true }).fill('10:00');
  await expect(dlg.getByText('O fim do horário de trabalho precisa ser depois do início.')).toBeVisible();
  await expect(dlg.getByRole('button', { name: 'Revisar e continuar' })).toBeDisabled();
  // O celular e o computador não rolam para o lado.
  await noSideScroll(admin);
});

test('inicia a campanha: fica Ativa, com os números do servidor, e continua depois de recarregar', async () => {
  const dlg = dialog();
  // Uma janela que cobre o dia inteiro (o teste não depende do relógio); o limite continua 5.
  await dlg.getByLabel('Horário de trabalho: das').fill('00:00');
  await dlg.getByLabel('até', { exact: true }).fill('23:59');
  await dlg.getByRole('button', { name: 'Todos os dias' }).click(); // o teste não depende do dia da semana
  await expect(dlg.getByRole('button', { name: 'Revisar e continuar' })).toBeEnabled();
  await dlg.getByRole('button', { name: 'Revisar e continuar' }).click();
  // O último passo: o resumo do que vai valer, com Voltar, Cancelar e Iniciar.
  const resumo = summary();
  await expect(resumo.getByTestId('resumo-final')).toBeVisible();
  await expect(resumo.getByText('00:00 às 23:59')).toBeVisible();
  await expect(resumo.getByText('Todos os dias')).toBeVisible();
  await expect(resumo.getByText(/não garante/)).toBeVisible();
  await expect(resumo.getByRole('button', { name: 'Voltar' })).toBeVisible();
  await expect(resumo.getByRole('button', { name: 'Cancelar' })).toBeVisible();
  await shot(admin, 'c02b-campanha-resumo');
  await resumo.getByRole('button', { name: 'Iniciar campanha' }).click();
  await expect(admin.getByText(/Campanha iniciada/)).toBeVisible();
  await expect(summary()).toBeHidden();

  const live = admin.getByTestId('campanha-viva');
  await expect(live).toBeVisible();
  await expect(admin.getByTestId('campanha-status')).toHaveText('Ativa');
  await expect(live.getByText('00:00 às 23:59')).toBeVisible();
  await expect(
    live.getByLabel('Configuração da campanha').getByText('5 contatos', { exact: true }),
  ).toBeVisible();
  // A agenda: começa hoje, sem data final, todos os dias, cooldown padrão.
  const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  await expect(live.getByTestId('campanha-inicio')).toHaveText(hoje);
  await expect(live.getByTestId('campanha-fim')).toHaveText('Sem data final');
  await expect(live.getByTestId('campanha-dias')).toHaveText('Todos os dias');
  // Os contadores do painel e o calendário de capacidade vêm do servidor.
  for (const id of ['sem-whatsapp', 'bloqueados', 'cooldown', 'sem-cota', 'desconectados']) {
    await expect(live.getByTestId(`campanha-${id}`)).toBeVisible();
  }
  await expect(live.getByTestId('calendario')).toBeVisible();
  await expect(live.getByTestId('estimativa')).toContainText('Estimativa aproximada');
  await expect(admin.getByTestId('campanha-total')).toHaveText('0'); // o job não roda neste servidor de teste
  await expect(admin.getByTestId('campanha-restantes')).not.toHaveText('0');
  // O número aparece com o uso do dia (x/limite) e marcado como conectado.
  await expect(live.getByTestId(/campanha-uso-/).first()).toHaveText(/Total: \d+\/5 hoje/);
  await expect(live.getByText('Conectado').first()).toBeVisible();
  await expect(live.getByText('Nenhum envio agendado neste momento.')).toBeVisible();
  await shot(admin, 'c03-campanha-ativa');

  // Persistiu: recarregar a página não perde nada.
  await admin.reload();
  await expect(admin.getByTestId('campanha-status')).toHaveText('Ativa');
  await expect(admin.getByTestId('campanha-viva').getByText('00:00 às 23:59')).toBeVisible();
  // Não dá para iniciar outra enquanto esta existe (o botão some) e a API também recusa.
  await expect(panel().getByRole('button', { name: 'Nova campanha' })).toHaveCount(0);
  const headers = { 'x-csrf-token': await csrfOf(admin) };
  const again = await admin.request.post(`/api/automations/${automationId}/campaigns`, {
    headers,
    data: { listId: '11111111-1111-4111-8111-111111111111', instanceIds: [1] },
  });
  expect([404, 409]).toContain(again.status());
  // Nada foi enviado (sem job neste servidor): nenhuma participação, nenhuma conversa nova.
  const runs = await (await admin.request.get(`/api/automations/${automationId}/runs`)).json();
  expect(runs).toEqual([]);
});

test('pausa e retoma: a situação muda na tela e no servidor', async () => {
  await panel().getByRole('button', { name: 'Pausar' }).click();
  await expect(admin.getByText('Campanha pausada.')).toBeVisible();
  await expect(admin.getByTestId('campanha-status')).toHaveText('Pausada');
  await expect(panel().getByText(/nenhum lead novo entra e nada é enviado/)).toBeVisible();
  await expect(panel().getByRole('button', { name: 'Retomar' })).toBeVisible();
  const list = await (await admin.request.get(`/api/automations/${automationId}/campaigns`)).json();
  expect(list[0].status).toBe('paused');
  await shot(admin, 'c04-campanha-pausada');

  await panel().getByRole('button', { name: 'Retomar' }).click();
  await expect(admin.getByText('Campanha retomada.')).toBeVisible();
  await expect(admin.getByTestId('campanha-status')).toHaveText('Ativa');
  await expect(panel().getByRole('button', { name: 'Pausar' })).toBeVisible();
});

test('encerra depois de confirmar: não volta, e o histórico da campanha continua na tela', async () => {
  await panel().getByRole('button', { name: 'Encerrar', exact: true }).click();
  const confirm = admin.getByRole('dialog', { name: 'Encerrar campanha?' });
  await expect(confirm.getByText(/não volta/)).toBeVisible();
  await expect(confirm.getByText(/Tudo o que já foi enviado continua no histórico/)).toBeVisible();
  await confirm.getByRole('button', { name: 'Encerrar campanha' }).click();
  await expect(admin.getByText(/Campanha encerrada/)).toBeVisible();
  await expect(admin.getByTestId('campanha-viva')).toHaveCount(0);
  await expect(panel().getByText('Última campanha')).toBeVisible();
  await expect(panel().getByText('Encerrada', { exact: true })).toBeVisible();
  await expect(panel().getByText('Encerrada por uma pessoa.')).toBeVisible();
  await expect(panel().getByRole('button', { name: 'Nova campanha' })).toBeEnabled();
  const list = await (await admin.request.get(`/api/automations/${automationId}/campaigns`)).json();
  expect(list[0]).toMatchObject({ status: 'stopped', endReason: 'encerrada_manualmente' });
  const headers = { 'x-csrf-token': await csrfOf(admin) };
  const resume = await admin.request.post(`/api/automations/${automationId}/campaigns/${list[0].id}/resume`, {
    headers,
    data: {},
  });
  expect(resume.status()).toBe(409);
  await shot(admin, 'c05-campanha-encerrada');
});

test('pausar a automação avisa na tela da campanha', async () => {
  // Nova campanha (pela API) só para ver o aviso; depois encerra.
  const headers = { 'x-csrf-token': await csrfOf(admin) };
  const lists = (await (await admin.request.get('/api/lists?archived=0')).json()) as {
    id: string;
    name: string;
  }[];
  const list = lists.find((l) => l.name === 'Campanha E2E');
  expect(list).toBeTruthy();
  const instances = (await (await admin.request.get('/api/instances')).json()) as {
    id: number;
    status: string;
  }[];
  const connected = instances.find((i) => i.status === 'open');
  expect(connected).toBeTruthy();
  const started = await admin.request.post(`/api/automations/${automationId}/campaigns`, {
    headers,
    data: { listId: list?.id, instanceIds: [connected?.id], windowStart: '00:00', windowEnd: '23:59' },
  });
  expect(started.status(), await started.text()).toBe(201);
  await admin.request.patch(`/api/automations/${automationId}/status`, {
    headers,
    data: { status: 'paused' },
  });
  await admin.goto(`/automacoes/${automationId}`);
  await expect(panel().getByText(/A automação está pausada: a campanha espera/)).toBeVisible();
  await shot(admin, 'c06-campanha-automacao-pausada');
  await admin.request.patch(`/api/automations/${automationId}/status`, {
    headers,
    data: { status: 'active' },
  });
  const id = (await started.json()).id;
  await admin.request.post(`/api/automations/${automationId}/campaigns/${id}/stop`, { headers, data: {} });
});

// ---------- cota diária de contatos por número (manual + automático) ----------

interface UsageInfo {
  total: number;
  limit: number;
  remaining: number;
  limitReached: boolean;
}
interface InstanceRow {
  id: number;
  name: string;
  nickname: string | null;
  status: string;
  usage: UsageInfo;
}

const instancesOf = async (): Promise<InstanceRow[]> => (await admin.request.get('/api/instances')).json();

test('Números mostra o uso do dia que vem do servidor: "x/20 contatos hoje"', async () => {
  const first = (await instancesOf())[0] as InstanceRow;
  await admin.goto('/numeros');
  const total = admin.getByTestId(`numero-uso-total-${first.id}`);
  await expect(total).toHaveText(`${first.usage.total}/${first.usage.limit} contatos hoje`);
  await expect(admin.getByTestId(`numero-uso-${first.id}`).getByRole('progressbar')).toBeVisible();
  expect(first.usage.limit).toBe(20);
  await shot(admin, 'c07-numeros-uso');
});

test('capacidade real por número: o que atingiu 20/20 fica indisponível e não entra na soma', async () => {
  const headers = { 'x-csrf-token': await csrfOf(admin) };
  // Um segundo número, conectado (o servidor de teste usa uma Evolution de mentira), que já fez 20 contatos hoje.
  const created = await admin.request.post('/api/instances', { headers, data: { nickname: 'Número cheio' } });
  expect(created.ok(), await created.text()).toBe(true);
  const full = (await created.json()) as InstanceRow;
  const opened = await admin.request.post('/webhook/evolution', {
    headers: { 'x-webhook-token': 'token-do-webhook-e2e' },
    data: { event: 'connection.update', instance: full.name, data: { state: 'open' } },
  });
  expect(opened.ok(), await opened.text()).toBe(true);
  await seedTodayUsage(full.name, { manual: 7, automatic: 13 }); // 7 manuais + 13 automáticos = 20/20

  const rows = await instancesOf();
  const other = rows.find((r) => r.id !== full.id && r.status === 'open') as InstanceRow;
  expect(rows.find((r) => r.id === full.id)?.usage).toMatchObject({
    total: 20,
    remaining: 0,
    limitReached: true,
  });

  // Números: o cheio mostra "20/20" e o aviso.
  await admin.goto('/numeros');
  await expect(admin.getByTestId(`numero-uso-total-${full.id}`)).toHaveText('20/20 contatos hoje');
  await expect(admin.getByTestId(`numero-uso-${full.id}`).getByText('Limite diário atingido')).toBeVisible();
  await expect(
    admin.getByTestId(`numero-uso-${full.id}`).getByText(/7 manuais · 13 automáticos/),
  ).toBeVisible();

  // Diálogo da campanha: capacidade de HOJE por número e a soma sem o número cheio.
  await admin.goto(`/automacoes/${automationId}`);
  await panel().getByRole('button', { name: 'Nova campanha' }).click();
  const dlg = dialog();
  await expect(dlg.getByTestId(`campanha-cota-${full.id}`)).toHaveText('Limite diário atingido');
  await expect(dlg.getByTestId(`campanha-cota-${other.id}`)).toContainText(
    `${other.usage.total}/20 hoje · disponível ${other.usage.remaining}`,
  );
  const lists = (await (await admin.request.get('/api/lists?archived=0')).json()) as {
    id: string;
    name: string;
  }[];
  await dlg
    .getByLabel('Lista de leads')
    .selectOption(lists.find((l) => l.name === 'Campanha E2E')?.id as string);
  await dlg.getByRole('button', { name: 'Marcar os conectados' }).click();
  await expect(dlg.getByTestId('preview-eligible')).toBeVisible({ timeout: 20_000 });
  await expect(dlg.getByTestId('preview-connected')).toHaveText(/^(\d+) de \1$/);
  // Só o número com vaga entra na soma de hoje; o cheio (0 vagas) não soma.
  await expect(dlg.getByTestId('preview-available')).toContainText(`${other.usage.remaining} contato`);
  await expect(dlg.getByTestId(`preview-numero-${full.id}`)).toContainText('Limite diário atingido');
  await expect(dlg.getByTestId(`preview-numero-${other.id}`)).toContainText(
    `disponível ${other.usage.remaining}`,
  );
  await shot(admin, 'c08-campanha-dialogo-capacidade');

  // Inicia (janela do dia inteiro) e confere o painel: manual/automático separados e o aviso do número cheio.
  await dlg.getByLabel('Horário de trabalho: das').fill('00:00');
  await dlg.getByLabel('até', { exact: true }).fill('23:59');
  await dlg.getByRole('button', { name: 'Revisar e continuar' }).click();
  await summary().getByRole('button', { name: 'Iniciar campanha' }).click();
  await expect(admin.getByText(/Campanha iniciada/)).toBeVisible();
  const live = admin.getByTestId('campanha-viva');
  await expect(live.getByTestId(`campanha-detalhe-${full.id}`)).toHaveText('7 manuais · 13 automáticos');
  await expect(live.getByTestId(`campanha-uso-${full.id}`)).toHaveText('Total: 20/20 hoje');
  await expect(live.getByTestId(`campanha-limite-${full.id}`)).toContainText('Limite diário atingido');
  await expect(live.getByTestId(`campanha-limite-${other.id}`)).toHaveCount(0);
  await expect(live.getByTestId('campanha-disponivel')).toContainText(`${other.usage.remaining} contato`);
  await shot(admin, 'c09-campanha-numero-cheio');
  // Nada foi enviado (o job não roda neste servidor de teste) e o número cheio continua em 20.
  expect((await instancesOf()).find((r) => r.id === full.id)?.usage.total).toBe(20);

  // Encerra a campanha para não atrapalhar os outros testes.
  const list = await (await admin.request.get(`/api/automations/${automationId}/campaigns`)).json();
  const stop = await admin.request.post(`/api/automations/${automationId}/campaigns/${list[0].id}/stop`, {
    headers,
    data: {},
  });
  expect(stop.ok()).toBe(true);
});
