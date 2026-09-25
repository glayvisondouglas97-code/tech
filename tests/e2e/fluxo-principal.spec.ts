import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { acceptanceRows, toXlsx } from '../fixtures';

/**
 * Fluxo principal (critérios de aceite):
 * gestor entra, cadastra 2 atendentes, importa .xlsx de 1.000 linhas e vê o resumo certo;
 * atendentes pegam leads ao mesmo tempo sem repetir; atendente chama o lead pelo WhatsApp do sistema
 * (escolhe o número, a conversa abre vazia, a primeira mensagem marca o lead como chamado sozinha);
 * o painel mostra quem chamou e quando; o atendente não acessa a gestão.
 */

const ADMIN = { email: 'gestora@e2e.teste', password: 'senha-e2e-123' };
/** Mesmo valor em tests/e2e/server.ts. */
const WEBHOOK_TOKEN = 'token-do-webhook-e2e';
const SHOTS = resolve('test-results/telas');
mkdirSync(SHOTS, { recursive: true });

const shot = (page: Page, name: string) =>
  page.screenshot({ path: resolve(SHOTS, `${name}.png`), fullPage: true });

/** WAV curtinho e válido (silêncio) para o navegador conseguir tocar o áudio no teste. */
function tinyWav(): Buffer {
  const sampleRate = 8000;
  const dataSize = 800; // ~0,1s, 8 bits mono
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  buf.fill(128, 44); // silêncio em PCM 8 bits
  return buf;
}
/** Clica no menu lateral e tira o mouse de cima dele (o menu abre ao passar o mouse e cobriria a tela). */
async function nav(page: Page, label: string) {
  await page
    .getByRole('complementary', { name: 'Menu' })
    .getByRole('link', { name: label, exact: true })
    .click();
  await page.mouse.move(900, 600);
}

async function login(page: Page, email: string, password: string) {
  await page.goto('/entrar');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha').fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL(/\/chamar$/);
}

async function newAttendantContext(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  return { context, page: await context.newPage() };
}

test.describe.configure({ mode: 'serial' });

let admin: Page;
const invites: Record<string, string> = {};
const attendants = [
  { name: 'Ana Teste', email: 'ana@e2e.teste', password: 'senha-da-ana-1' },
  { name: 'Bruno Teste', email: 'bruno@e2e.teste', password: 'senha-do-bruno-1' },
];

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  admin = await context.newPage();
  // Um número de WhatsApp conectado (a Evolution de mentira avisa pelo webhook, como a de verdade).
  const r = await admin.request.post('/webhook/evolution', {
    headers: { 'x-webhook-token': WEBHOOK_TOKEN },
    data: { event: 'connection.update', instance: 'whatsapp-01', data: { state: 'open' } },
  });
  expect(r.status()).toBe(200);
});

test('dono cadastra 2 atendentes: um com senha definida, outro por convite', async () => {
  await login(admin, ADMIN.email, ADMIN.password);
  await expect(admin.getByText('Deixe o sistema pronto em 3 passos')).toBeVisible();
  await shot(admin, '01-primeiro-acesso-gestor');
  await nav(admin, 'Usuários');
  const [ana, bruno] = attendants as [(typeof attendants)[number], (typeof attendants)[number]];

  // Ana: o gestor define a senha e ela já entra.
  await admin.getByRole('button', { name: 'Novo usuário' }).click();
  let form = admin.getByRole('dialog', { name: 'Novo usuário' });
  await form.getByLabel('Nome', { exact: true }).fill(ana.name);
  await form.getByLabel(/^E-mail/).fill(ana.email);
  await form.getByRole('radio', { name: /Atendente/ }).check();
  await form.getByLabel(/^Senha/).fill(ana.password);
  await form.getByRole('button', { name: 'Criar usuário' }).click();
  const creds = admin.getByRole('dialog', { name: 'Usuário criado' });
  await expect(creds).toContainText(ana.email);
  await expect(creds).toContainText(ana.password);
  await shot(admin, '02-usuario-criado');
  await creds.getByRole('button', { name: 'Fechar' }).click();

  // Bruno: recebe um link de convite e cria a própria senha.
  await admin.getByRole('button', { name: 'Novo usuário' }).click();
  form = admin.getByRole('dialog', { name: 'Novo usuário' });
  await form.getByLabel('Nome', { exact: true }).fill(bruno.name);
  await form.getByLabel(/^E-mail/).fill(bruno.email);
  await form.getByRole('radio', { name: 'Enviar link de convite' }).click();
  await form.getByRole('button', { name: 'Criar usuário' }).click();
  const dialog = admin.getByRole('dialog', { name: 'Convite criado' });
  await expect(dialog).toBeVisible();
  invites[bruno.email] = await dialog.getByLabel('Link').inputValue();
  expect(invites[bruno.email]).toMatch(/\/definir-senha#token=/);
  await dialog.getByRole('button', { name: 'Fechar' }).click();

  await expect(admin.getByRole('row', { name: new RegExp(ana.name) })).toContainText('Ativo');
  await expect(admin.getByRole('row', { name: new RegExp(bruno.name) })).toContainText('Aguardando senha');
});

test('atendente convidado aceita o convite e cria a senha', async ({ browser }) => {
  for (const a of attendants.filter((x) => invites[x.email])) {
    const { context, page } = await newAttendantContext(browser);
    await page.goto(invites[a.email] as string);
    await expect(
      page.getByRole('heading', { name: new RegExp(`Bem-vindo\\(a\\), ${a.name.split(' ')[0]}`) }),
    ).toBeVisible();
    await page.getByLabel('Senha', { exact: true }).fill(a.password);
    await page.getByLabel('Repita a senha').fill(a.password);
    await page.getByRole('button', { name: 'Salvar senha e entrar' }).click();
    await expect(page).toHaveURL(/\/chamar$/);
    await context.close();
  }
});

test('gestor importa planilha .xlsx de 1.000 linhas e vê o resumo certo', async () => {
  const { rows, summary } = acceptanceRows();
  const file = resolve('tests/.tmp/leads-1000.xlsx');
  mkdirSync(resolve('tests/.tmp'), { recursive: true });
  writeFileSync(file, toXlsx(rows));

  await nav(admin, 'Listas');
  await admin.locator('#imp-file').setInputFiles(file);
  await expect(admin.getByText('leads-1000.xlsx')).toBeVisible();
  await expect(admin.getByText(`${summary.valid} prontos para importar`)).toBeVisible();
  await expect(admin.getByText(`${summary.duplicatesInFile} repetidos no arquivo`)).toBeVisible();
  await expect(admin.getByText(`${summary.invalid} sem telefone válido`)).toBeVisible();
  await admin.getByLabel('Nome da lista').fill('Campanha E2E');
  await shot(admin, '03-importacao-previa');
  await admin.getByRole('button', { name: `Importar ${summary.valid} leads` }).click();
  await expect(admin.getByText(/Lista "Campanha E2E" importada:/)).toBeVisible({ timeout: 60_000 });
  await expect(admin.getByText('100 linhas ficaram de fora.', { exact: false })).toBeVisible();
  const rejected = admin.getByRole('link', { name: /Baixar linhas recusadas/ });
  await expect(rejected).toBeVisible();
  const csv = await admin.request.get((await rejected.getAttribute('href')) as string);
  expect((await csv.text()).split('\r\n').filter(Boolean)).toHaveLength(101);
  await shot(admin, '04-importacao-concluida');
});

test('dois atendentes pegam leads ao mesmo tempo e nunca recebem o mesmo', async ({ browser }) => {
  const sessions = await Promise.all(attendants.map(() => newAttendantContext(browser)));
  await Promise.all(
    sessions.map(({ page }, i) =>
      login(page, attendants[i]?.email as string, attendants[i]?.password as string),
    ),
  );
  const buttons = sessions.map(({ page }) => page.getByRole('button', { name: 'Pegar leads' }).first());
  await Promise.all(buttons.map((b) => expect(b).toBeEnabled()));
  await Promise.all(buttons.map((b) => b.click()));
  const lists = await Promise.all(
    sessions.map(async ({ page }) => {
      await expect(page.locator('li.lead')).toHaveCount(10);
      return page.locator('li.lead .phone').allTextContents();
    }),
  );
  const [a, b] = lists as [string[], string[]];
  expect(a.filter((p) => b.includes(p))).toEqual([]);
  for (const s of sessions) await s.context.close();
});

test('atendente chama pelo WhatsApp do sistema e o lead é marcado sozinho', async ({ browser }) => {
  const ana = attendants[0] as (typeof attendants)[number];
  // A gestora escolhe a Ana como responsável pelo número (a atendente só vê os números dela).
  await nav(admin, 'Números');
  const numberCard = admin.locator('.wa-num', { hasText: 'whatsapp-01' });
  await numberCard.getByRole('combobox').selectOption({ label: ana.name });
  await expect(admin.getByText(`Agora ${ana.name} é responsável por whatsapp-01.`)).toBeVisible();
  await shot(admin, '05a-numeros-responsavel');

  // A gestora salva um áudio na biblioteca: o botão Chamar vai enviá-lo sorteado (Plano A).
  await nav(admin, 'Áudios');
  await admin
    .getByRole('button', { name: /Salvar/ })
    .first()
    .click();
  const audioDlg = admin.getByRole('dialog', { name: 'Salvar áudio' });
  await audioDlg.getByLabel('Nome do áudio').fill('Apresentação — teste');
  await audioDlg
    .locator('input[type=file]')
    .setInputFiles({ name: 'ola.wav', mimeType: 'audio/wav', buffer: tinyWav() });
  await audioDlg.getByRole('button', { name: 'Salvar áudio' }).click();
  await expect(admin.getByText('Áudio salvo.')).toBeVisible();
  await expect(admin.locator('.wa-lib-item', { hasText: 'Apresentação — teste' })).toBeVisible();
  await shot(admin, '05a2-audio-salvo');

  const { context, page } = await newAttendantContext(browser);
  await login(page, ana.email, ana.password);
  const first = page.locator('li.lead').first();
  // Lead de pessoa jurídica: empresa em destaque e o sócio embaixo.
  const name = (await first.locator('.lead-name').textContent())?.trim() ?? '';
  const socio = ((await first.locator('.lead-socio').textContent()) ?? '').replace('Sócio:', '').trim();
  expect(name).toMatch(/ (Ltda|ME)$/);
  expect(socio).not.toBe('');
  await shot(page, '05-fila-atendente');

  // "Chamar" pergunta por qual número falar e abre a conversa dentro do sistema (sem wa.me).
  await first.getByRole('button', { name: 'Chamar no WhatsApp' }).click();
  const dialog = page.getByRole('dialog', { name: 'Chamar pelo WhatsApp' });
  await expect(dialog.getByText('Por qual número?')).toBeVisible();
  await shot(page, '05b-escolher-numero');
  await dialog.getByRole('button', { name: /whatsapp-01/ }).click();
  // Ao escolher o número, o sistema sorteia um áudio salvo e o envia sozinho como mensagem de voz.
  await expect(page.getByText('Áudio enviado: Apresentação — teste')).toBeVisible();
  await expect(page).toHaveURL(/\/conversas\/\d+$/);
  // Título do chat = empresa do lead; a faixa do lead mostra a situação e o sócio.
  await expect(page.locator('.wa-chat-title')).toContainText(name);
  const strip = page.locator('.wa-lead');
  await expect(strip).toContainText(`Sócio: ${socio}`);
  // A bolha de áudio aparece e o lead já fica "Mensagem enviada", sem digitar nada.
  await expect(page.locator('.wa-bubble .wa-audio-play')).toBeVisible();
  await expect(strip.getByText('Mensagem enviada')).toBeVisible();
  await shot(page, '05c-audio-enviado');

  // De volta à fila: o lead saiu e conta como chamado hoje.
  await strip.getByRole('button', { name: 'Voltar para a fila' }).click();
  await expect(page).toHaveURL(/\/chamar$/);
  await expect(page.locator('li.lead')).toHaveCount(9);
  await expect(page.locator('.kpi', { hasText: 'Você chamou hoje' }).locator('.kpi-v')).toHaveText('1');

  // O atendente não acessa a gestão, nem pela tela nem pela API.
  await page.goto('/equipe');
  await expect(page).toHaveURL(/\/chamar$/);
  expect((await page.request.get('/api/users')).status()).toBe(403);
  expect((await page.request.get('/api/export/leads.csv')).status()).toBe(403);
  await context.close();

  // O painel do gestor mostra o registro com o nome e o horário.
  await nav(admin, 'Painel');
  const card = admin.locator('.acard', { hasText: ana.name });
  await expect(card).toBeVisible();
  await expect(card.locator('.acard-v')).toHaveText('1');
  await shot(admin, '06-painel');
  // Menu lateral: abre ao passar o mouse e mostra o nome de todas as seções.
  await admin.locator('aside.side').hover();
  await expect(admin.locator('aside.side .side-text', { hasText: 'Auditoria' })).toBeVisible();
  await admin.waitForTimeout(400);
  await admin.screenshot({ path: resolve(SHOTS, '06b-menu-aberto.png') });
  await admin.mouse.move(900, 500);
  await nav(admin, 'Já chamados');
  const called = admin.locator('li.crow').filter({ hasText: name });
  await expect(called).toContainText(ana.name);
  await expect(called).toContainText(/hoje, \d{2}:\d{2}/);
  await shot(admin, '07-ja-chamados');
});

test('histórico do lead mostra quem fez cada ação', async () => {
  await admin.locator('li.crow .lead-name button').first().click();
  const drawer = admin.getByRole('dialog', { name: 'Lead' });
  await expect(drawer.getByText('Chamou pelo WhatsApp do sistema')).toBeVisible();
  await expect(drawer.getByText('Abriu a conversa no WhatsApp')).toBeVisible();
  await expect(drawer.getByText('Pegou da fila livre')).toBeVisible();
  await expect(drawer.getByText(/Importado na lista "Campanha E2E"/)).toBeVisible();
  await shot(admin, '08-historico');
  await drawer.getByRole('button', { name: 'Fechar' }).click();
});

test('telas de gestão e configurações abrem sem erro, no tema claro e no escuro', async () => {
  for (const label of ['Leads', 'Listas', 'Usuários', 'Auditoria', 'Configurações']) {
    await nav(admin, label);
    await expect(admin.getByRole('heading', { name: label, level: 1 })).toBeVisible();
    await shot(admin, `11-${label.toLowerCase().replace('ç', 'c').replace('õ', 'o')}`);
  }
  for (const section of ['Fila e regras', 'Empresa', 'Não contatar', 'Privacidade (LGPD)']) {
    await admin.getByRole('button', { name: section, exact: true }).click();
    await expect(admin.getByRole('heading', { level: 2 }).first()).toBeVisible();
  }
  await nav(admin, 'Auditoria');
  await expect(admin.getByRole('cell', { name: 'Pediu leads da fila' }).first()).toBeVisible();
  await expect(admin.getByText('mais puxou').first()).toBeVisible();
  await shot(admin, '12-auditoria');
  await admin.emulateMedia({ colorScheme: 'dark' });
  await nav(admin, 'Painel');
  await expect(admin.getByRole('heading', { name: 'Painel' })).toBeVisible();
  await shot(admin, '13-painel-escuro');
  await nav(admin, 'Já chamados');
  await expect(admin.locator('li.crow')).toHaveCount(1);
  await shot(admin, '14-ja-chamados-escuro');
  await admin.emulateMedia({ colorScheme: 'light' });
  await expect(admin.getByText('Algo deu errado')).toHaveCount(0);
});
