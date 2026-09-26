import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Browser, expect, type Page, test } from '@playwright/test';

/**
 * Automações (só configuração): a gestora abre /automacoes, monta "Follow-up de Leads" com três etapas
 * (texto imediato, texto depois de 2 horas com condição, áudio depois de 1 dia), reordena, edita, exclui,
 * recarrega e confere que tudo ficou salvo na ordem certa; ativa (e nada é enviado); pausa; arquiva.
 * Roda depois do fluxo principal, no mesmo servidor.
 */

const ADMIN = { email: 'gestora@e2e.teste', password: 'senha-e2e-123' };
const ATTENDANT = {
  name: 'Atendente Automações',
  email: 'atendente.auto@e2e.teste',
  password: 'senha-forte-123',
};
const SHOTS = resolve('test-results/telas');
mkdirSync(SHOTS, { recursive: true });

/** Tira a foto depois da animação de abrir a janela, para o registro mostrar a tela já parada. */
async function shot(page: Page, name: string) {
  await page.waitForTimeout(450);
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`), fullPage: true });
}

/** WAV curtinho e válido (silêncio) para o navegador conseguir tocar o áudio. */
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

async function login(page: Page, email: string, password: string) {
  await page.goto('/entrar');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha').fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL(/\/chamar$/);
}

/** Clica no menu lateral e tira o mouse de cima dele (o menu abre ao passar o mouse e cobriria a tela). */
async function nav(page: Page, label: string) {
  await page
    .getByRole('complementary', { name: 'Menu' })
    .getByRole('link', { name: label, exact: true })
    .click();
  await page.mouse.move(900, 600);
}

async function csrfOf(page: Page): Promise<string> {
  return (await (await page.request.get('/api/auth/me')).json()).csrfToken;
}

async function uploadAudio(page: Page, label: string): Promise<number> {
  const r = await page.request.post(`/api/audios?label=${encodeURIComponent(label)}&seconds=1`, {
    headers: { 'content-type': 'audio/wav', 'x-csrf-token': await csrfOf(page) },
    data: tinyWav(),
  });
  expect(r.ok(), await r.text()).toBe(true);
  return (await r.json()).id;
}

const card = (page: Page, position: number) =>
  page.getByRole('listitem', { name: `Etapa ${position}`, exact: true });
const stepDialog = (page: Page, name: string) => page.getByRole('dialog', { name });

/** Lê os textos das etapas, na ordem em que aparecem na tela. */
async function stepTexts(page: Page): Promise<string[]> {
  return page
    .locator('ol.auto-steps > li.auto-step')
    .evaluateAll((items) =>
      items.map((li) => (li.querySelector('.auto-step-text, .auto-step-audio b')?.textContent ?? '').trim()),
    );
}

async function noSideScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe.configure({ mode: 'serial' });

let admin: Page;
let automationUrl = '';
let conversationsBefore = 0;
const AUDIO = 'Áudio da automação';

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  admin = await context.newPage();
  await login(admin, ADMIN.email, ADMIN.password);
  await uploadAudio(admin, AUDIO);
  // Um atendente para conferir que ele não entra em /automacoes.
  const created = await admin.request.post('/api/users', {
    headers: { 'x-csrf-token': await csrfOf(admin) },
    data: { name: ATTENDANT.name, email: ATTENDANT.email, role: 'atendente', password: ATTENDANT.password },
  });
  expect(created.ok(), await created.text()).toBe(true);
  conversationsBefore = (
    (await (await admin.request.get('/api/conversations?tab=todas&limit=200')).json()) as unknown[]
  ).length;
});

test('menu Automações abre a lista, vazia no começo', async () => {
  await nav(admin, 'Automações');
  await expect(admin).toHaveURL(/\/automacoes$/);
  await expect(admin.getByRole('heading', { name: 'Automações', level: 1 })).toBeVisible();
  await expect(admin.getByText('Nenhuma automação ainda')).toBeVisible();
  // Avisa, em destaque, que automação ativa envia de verdade e quando ela para.
  await expect(admin.getByText(/enviam mensagens de verdade pelo WhatsApp/)).toBeVisible();
  await shot(admin, 'a01-automacoes-vazio');
});

test('cria a automação e cai no editor, como rascunho e sem etapas', async () => {
  await admin.getByRole('button', { name: 'Nova automação' }).first().click();
  const dlg = stepDialog(admin, 'Nova automação');
  await dlg.getByRole('button', { name: 'Criar automação' }).click();
  await expect(dlg.getByText('Dê um nome para a automação.')).toBeVisible();
  await dlg.getByLabel('Nome').fill('Follow-up de Leads');
  await dlg.getByLabel('Descrição (opcional)').fill('Retoma o contato com quem não respondeu.');
  await dlg.getByRole('button', { name: 'Criar automação' }).click();

  await expect(admin).toHaveURL(/\/automacoes\/\d+$/);
  automationUrl = new URL(admin.url()).pathname;
  await expect(admin.getByRole('heading', { name: 'Follow-up de Leads', level: 1 })).toBeVisible();
  await expect(admin.getByText('Rascunho', { exact: true })).toBeVisible();
  await expect(admin.getByText('Retoma o contato com quem não respondeu.')).toBeVisible();
  await expect(admin.getByText('Nenhuma etapa ainda')).toBeVisible();
  // Sem etapa não dá para ativar, e a tela explica o porquê.
  await expect(admin.getByRole('button', { name: 'Ativar', exact: true })).toBeDisabled();
  await expect(admin.getByText('Adicione pelo menos uma etapa.')).toBeVisible();
  await shot(admin, 'a02-editor-sem-etapas');
});

test('etapa 1: texto imediato, com variável inserida pelo botão', async () => {
  await admin.getByRole('button', { name: 'Adicionar etapa' }).click();
  const dlg = stepDialog(admin, 'Nova etapa');
  // Vazio: a própria tela recusa antes de mandar ao servidor.
  await dlg.getByRole('button', { name: 'Salvar etapa' }).click();
  await expect(dlg.getByText('Escreva a mensagem.')).toBeVisible();

  const message = dlg.getByLabel('Mensagem', { exact: true });
  await message.fill('Olá, ');
  await dlg.getByRole('button', { name: '{{nome}}' }).click();
  await admin.keyboard.type('! Tudo bem?');
  await expect(message).toHaveValue('Olá, {{nome}}! Tudo bem?');
  await expect(dlg.getByText('24 / 4096')).toBeVisible();
  await expect(dlg.getByText('Espera: imediatamente')).toBeVisible();
  await shot(admin, 'a03-dialogo-etapa-texto');
  await dlg.getByRole('button', { name: 'Salvar etapa' }).click();

  await expect(admin.getByText('Etapa adicionada.')).toBeVisible();
  const first = card(admin, 1);
  await expect(first).toContainText('Enviar mensagem de texto');
  await expect(first).toContainText('Imediatamente');
  await expect(first).toContainText('Olá, {{nome}}! Tudo bem?');
});

test('etapa 2: texto depois de 2 horas, com condição', async () => {
  await admin.getByRole('button', { name: 'Adicionar etapa' }).click();
  const dlg = stepDialog(admin, 'Nova etapa');
  await dlg.getByLabel('Tempo após a etapa anterior').fill('2');
  await dlg.getByLabel('Unidade de tempo').selectOption('hours');
  await expect(dlg.getByText('Espera: 2 horas')).toBeVisible();
  await dlg.getByLabel('Mensagem', { exact: true }).fill('Conseguiu verificar nossa mensagem?');

  await dlg.getByRole('button', { name: 'Adicionar condição' }).click();
  await dlg.getByLabel('Operador da condição 1').selectOption('is_not');
  await expect(dlg.getByLabel('Valor da condição 1')).toHaveValue('respondeu');
  await shot(admin, 'a04-dialogo-condicao');
  await dlg.getByRole('button', { name: 'Salvar etapa' }).click();

  const second = card(admin, 2);
  await expect(second).toContainText('Aguardar 2 horas');
  await expect(second).toContainText('Conseguiu verificar nossa mensagem?');
  await expect(second).toContainText('Resultado do lead não é Respondeu');
});

test('etapa 3: áudio depois de 1 dia, escolhido da biblioteca', async () => {
  await admin.getByRole('button', { name: 'Adicionar etapa' }).click();
  const dlg = stepDialog(admin, 'Nova etapa');
  await dlg.getByLabel('Tipo da ação').selectOption({ label: 'Enviar áudio' });
  // Trocar de texto para áudio esconde a mensagem e mostra a biblioteca.
  await expect(dlg.getByLabel('Mensagem', { exact: true })).toHaveCount(0);
  await expect(dlg.getByRole('radio', { name: new RegExp(AUDIO) })).toBeVisible();
  await expect(dlg.locator('audio')).not.toHaveCount(0);
  await dlg.getByLabel('Tempo após a etapa anterior').fill('1');
  await dlg.getByLabel('Unidade de tempo').selectOption('days');

  // Sem escolher o áudio, não salva.
  await dlg.getByRole('button', { name: 'Salvar etapa' }).click();
  await expect(dlg.getByText('Escolha o áudio.')).toBeVisible();
  await shot(admin, 'a05-dialogo-etapa-audio');
  await dlg.getByRole('radio', { name: new RegExp(AUDIO) }).check();
  await dlg.getByRole('button', { name: 'Salvar etapa' }).click();

  const third = card(admin, 3);
  await expect(third).toContainText('Enviar áudio');
  await expect(third).toContainText('Aguardar 1 dia');
  await expect(third).toContainText(AUDIO);
  await expect(third.locator('audio')).toBeVisible();
  await shot(admin, 'a06-editor-tres-etapas');
  await noSideScroll(admin);
});

test('reordena com os botões de subir e descer, e a ordem fica salva', async () => {
  await expect(card(admin, 1).getByRole('button', { name: 'Subir a etapa 1' })).toBeDisabled();
  await expect(card(admin, 3).getByRole('button', { name: 'Descer a etapa 3' })).toBeDisabled();

  await card(admin, 1).getByRole('button', { name: 'Descer a etapa 1' }).click();
  await expect
    .poll(() => stepTexts(admin))
    .toEqual(['Conseguiu verificar nossa mensagem?', 'Olá, {{nome}}! Tudo bem?', AUDIO]);

  await admin.reload();
  await expect
    .poll(() => stepTexts(admin))
    .toEqual(['Conseguiu verificar nossa mensagem?', 'Olá, {{nome}}! Tudo bem?', AUDIO]);

  // Volta à ordem original.
  await card(admin, 2).getByRole('button', { name: 'Subir a etapa 2' }).click();
  await expect
    .poll(() => stepTexts(admin))
    .toEqual(['Olá, {{nome}}! Tudo bem?', 'Conseguiu verificar nossa mensagem?', AUDIO]);
});

test('edita uma etapa e não perde o resto', async () => {
  await card(admin, 2).getByRole('button', { name: 'Editar a etapa 2' }).click();
  const dlg = stepDialog(admin, 'Editar etapa 2');
  await expect(dlg.getByLabel('Mensagem', { exact: true })).toHaveValue(
    'Conseguiu verificar nossa mensagem?',
  );
  await expect(dlg.getByLabel('Tempo após a etapa anterior')).toHaveValue('2');
  await expect(dlg.getByLabel('Unidade de tempo')).toHaveValue('hours');
  await expect(dlg.getByLabel('Operador da condição 1')).toHaveValue('is_not');
  await dlg.getByLabel('Mensagem', { exact: true }).fill('Conseguiu ver a nossa mensagem?');
  await dlg.getByRole('button', { name: 'Salvar etapa' }).click();

  await expect(admin.getByText('Etapa salva.')).toBeVisible();
  await expect(card(admin, 2)).toContainText('Conseguiu ver a nossa mensagem?');
  await expect(card(admin, 2)).toContainText('Aguardar 2 horas');
  await expect(card(admin, 2)).toContainText('Resultado do lead não é Respondeu');
});

test('exclui uma etapa depois de confirmar; as outras continuam na ordem', async () => {
  await admin.getByRole('button', { name: 'Adicionar etapa' }).click();
  const dlg = stepDialog(admin, 'Nova etapa');
  await dlg.getByLabel('Mensagem', { exact: true }).fill('Etapa que vai ser excluída');
  await dlg.getByRole('button', { name: 'Salvar etapa' }).click();
  await expect(card(admin, 4)).toContainText('Etapa que vai ser excluída');

  await card(admin, 4).getByRole('button', { name: 'Excluir a etapa 4' }).click();
  const confirm = stepDialog(admin, 'Excluir etapa?');
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancelar' }).click();
  await expect(card(admin, 4)).toBeVisible();

  await card(admin, 4).getByRole('button', { name: 'Excluir a etapa 4' }).click();
  await stepDialog(admin, 'Excluir etapa?').getByRole('button', { name: 'Excluir', exact: true }).click();
  await expect(admin.getByText('Etapa excluída.')).toBeVisible();
  await expect(card(admin, 4)).toHaveCount(0);
  await expect
    .poll(() => stepTexts(admin))
    .toEqual(['Olá, {{nome}}! Tudo bem?', 'Conseguiu ver a nossa mensagem?', AUDIO]);
});

test('fecha e abre de novo: as etapas continuam salvas, na ordem certa', async () => {
  await nav(admin, 'Automações');
  await expect(admin).toHaveURL(/\/automacoes$/);
  const item = admin.getByRole('link', { name: /Follow-up de Leads/ });
  await expect(item).toContainText('Rascunho');
  await expect(item).toContainText('3 etapas');
  await shot(admin, 'a07-lista-com-automacao');
  await item.click();
  await expect(admin).toHaveURL(automationUrl);
  await expect
    .poll(() => stepTexts(admin))
    .toEqual(['Olá, {{nome}}! Tudo bem?', 'Conseguiu ver a nossa mensagem?', AUDIO]);
  await expect(card(admin, 1)).toContainText('Imediatamente');
  await expect(card(admin, 2)).toContainText('Aguardar 2 horas');
  await expect(card(admin, 3)).toContainText('Aguardar 1 dia');
});

test('edita o nome e a descrição da automação', async () => {
  await admin.getByRole('button', { name: 'Editar dados' }).click();
  const dlg = stepDialog(admin, 'Editar automação');
  await dlg.getByLabel('Nome').fill('Follow-up de Leads (setembro)');
  await dlg.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(admin.getByText('Automação salva.')).toBeVisible();
  await expect(admin.getByRole('heading', { name: 'Follow-up de Leads (setembro)', level: 1 })).toBeVisible();
});

test('ativa: aparece como Ativa (sem nenhum lead participando, nada é enviado); depois pausa', async () => {
  await admin.getByRole('button', { name: 'Ativar', exact: true }).click();
  await expect(
    admin.getByText(/Automação ativada\. As etapas passam a ser enviadas de verdade/),
  ).toBeVisible();
  await expect(admin.getByText('Ativa', { exact: true })).toBeVisible();
  await expect(admin.getByRole('button', { name: 'Pausar' })).toBeVisible();
  await expect(admin.getByText(/está ativa e envia mensagens de verdade/)).toBeVisible();
  await expect(admin.getByText('Nenhum lead entrou nesta automação ainda.')).toBeVisible();
  await shot(admin, 'a08-editor-ativa');

  // Nenhum lead participa (o gatilho é manual e ninguém iniciou): nenhuma conversa nova nasceu.
  const now = (
    (await (await admin.request.get('/api/conversations?tab=todas&limit=200')).json()) as unknown[]
  ).length;
  expect(now).toBe(conversationsBefore);
  const id = automationUrl.split('/').pop();
  const api = await (await admin.request.get(`/api/automations/${id}`)).json();
  expect(api.status).toBe('active');
  expect(api.steps).toHaveLength(3);

  await admin.getByRole('button', { name: 'Pausar' }).click();
  await expect(admin.getByText('Pausada', { exact: true })).toBeVisible();
  await expect(admin.getByRole('button', { name: 'Ativar', exact: true })).toBeEnabled();
});

test('etapa de áudio cujo áudio foi excluído: a tela avisa e não deixa ativar', async () => {
  const spare = await uploadAudio(admin, 'Áudio que vai sumir');
  await admin.goto('/automacoes');
  await admin.getByRole('button', { name: 'Nova automação' }).first().click();
  const dlg = stepDialog(admin, 'Nova automação');
  await dlg.getByLabel('Nome').fill('Com áudio removido');
  await dlg.getByRole('button', { name: 'Criar automação' }).click();
  await expect(admin).toHaveURL(/\/automacoes\/\d+$/);

  await admin.getByRole('button', { name: 'Adicionar etapa' }).click();
  const step = stepDialog(admin, 'Nova etapa');
  await step.getByLabel('Tipo da ação').selectOption({ label: 'Enviar áudio' });
  await step.getByRole('radio', { name: /Áudio que vai sumir/ }).check();
  await step.getByRole('button', { name: 'Salvar etapa' }).click();
  await expect(card(admin, 1)).toContainText('Áudio que vai sumir');
  await expect(admin.getByRole('button', { name: 'Ativar', exact: true })).toBeEnabled();

  // A biblioteca perde o áudio; a etapa continua, mas incompleta.
  const removed = await admin.request.post(`/api/audios/${spare}/delete`, {
    headers: { 'x-csrf-token': await csrfOf(admin) },
    data: {},
  });
  expect(removed.ok()).toBe(true);
  await admin.reload();
  await expect(card(admin, 1)).toContainText('Etapa incompleta: escolha o áudio.');
  await expect(admin.getByRole('button', { name: 'Ativar', exact: true })).toBeDisabled();
  await expect(admin.getByText('Etapa 1: escolha o áudio.')).toBeVisible();
  await shot(admin, 'a09-etapa-incompleta');

  // Escolhendo outro áudio, volta a poder ativar.
  await card(admin, 1).getByRole('button', { name: 'Editar a etapa 1' }).click();
  const edit = stepDialog(admin, 'Editar etapa 1');
  await expect(edit.getByText('O áudio que esta etapa usava foi excluído')).toBeVisible();
  await edit.getByRole('radio', { name: new RegExp(AUDIO) }).check();
  await edit.getByRole('button', { name: 'Salvar etapa' }).click();
  await expect(card(admin, 1)).toContainText(AUDIO);
  await expect(admin.getByRole('button', { name: 'Ativar', exact: true })).toBeEnabled();
});

test('arquiva: fica só para consulta, sem editar, ativar nem receber etapas', async () => {
  await admin.goto(automationUrl);
  await expect(admin.getByRole('heading', { name: 'Follow-up de Leads (setembro)', level: 1 })).toBeVisible();
  await admin.getByRole('button', { name: 'Mais ações da automação' }).click();
  await admin.getByRole('menuitem', { name: 'Arquivar' }).click();
  await expect(stepDialog(admin, 'Arquivar automação?')).toBeVisible();
  await stepDialog(admin, 'Arquivar automação?')
    .getByRole('button', { name: 'Arquivar', exact: true })
    .click();

  await expect(admin.getByText('Automação arquivada.')).toBeVisible();
  await expect(admin.getByText('Arquivada', { exact: true })).toBeVisible();
  await expect(admin.getByText(/está arquivada: dá para consultar/)).toBeVisible();
  for (const name of ['Editar dados', 'Ativar', 'Pausar', 'Adicionar etapa', 'Mais ações da automação']) {
    await expect(admin.getByRole('button', { name, exact: true }), name).toHaveCount(0);
  }
  await expect(admin.getByRole('button', { name: /^(Editar|Excluir|Subir|Descer) a etapa/ })).toHaveCount(0);
  // As etapas continuam visíveis, só para leitura.
  await expect
    .poll(() => stepTexts(admin))
    .toEqual(['Olá, {{nome}}! Tudo bem?', 'Conseguiu ver a nossa mensagem?', AUDIO]);
  await shot(admin, 'a10-editor-arquivada');

  // O servidor também não deixa (não depende da tela).
  const id = automationUrl.split('/').pop();
  const csrf = await csrfOf(admin);
  const refused = await admin.request.post(`/api/automations/${id}/steps`, {
    headers: { 'x-csrf-token': csrf },
    data: { actionType: 'send_text', delaySeconds: 0, messageText: 'x', conditions: [] },
  });
  expect(refused.status()).toBe(409);
  const reactivate = await admin.request.patch(`/api/automations/${id}/status`, {
    headers: { 'x-csrf-token': csrf },
    data: { status: 'active' },
  });
  expect(reactivate.status()).toBe(409);

  await nav(admin, 'Automações');
  await expect(admin.getByRole('link', { name: /Follow-up de Leads/ })).toHaveCount(0);
  await admin.getByRole('radio', { name: 'Arquivadas' }).click();
  await expect(admin.getByRole('link', { name: /Follow-up de Leads \(setembro\)/ })).toContainText(
    'Arquivada',
  );
});

test('tema escuro: a tela segue as cores do sistema', async () => {
  await admin.goto(automationUrl);
  await admin.emulateMedia({ colorScheme: 'dark' });
  await expect(admin.getByRole('heading', { name: /Follow-up de Leads/, level: 1 })).toBeVisible();
  await shot(admin, 'a11-editor-escuro');
  await admin.emulateMedia({ colorScheme: 'light' });
});

test('quem não é dono nem administrador não abre /automacoes', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  const page = await context.newPage();
  await login(page, ATTENDANT.email, ATTENDANT.password);
  await page.goto('/automacoes');
  await expect(page).toHaveURL(/\/chamar$/);
  await page.goto(automationUrl);
  await expect(page).toHaveURL(/\/chamar$/);
  await expect(
    page.getByRole('complementary', { name: 'Menu' }).getByRole('link', { name: 'Automações', exact: true }),
  ).toHaveCount(0);
  const api = await page.request.get('/api/automations');
  expect(api.status()).toBe(403);
  await context.close();
});
