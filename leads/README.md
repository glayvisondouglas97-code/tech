# Chamador de Leads

Sistema web para organizar a equipe que chama leads pelo WhatsApp.

- Os leads são **empresas (pessoa jurídica)**: aparece o nome da empresa em destaque e o sócio/proprietário embaixo.
- O **gestor** importa as listas (Excel ou CSV), cadastra a equipe e acompanha tudo pelo painel e pela **Auditoria**.
- Cada **atendente** entra com o próprio login, pega leads da fila, abre o WhatsApp com a mensagem pronta e marca o resultado.
- Tudo fica registrado: quem pegou, quem chamou, quando, com qual resultado, e todo o histórico de cada lead.

Funciona no computador e no celular: no computador, menu lateral; no celular, barra de atalhos embaixo e botão grande do WhatsApp em cada lead. O botão abre o link oficial `wa.me`, que no celular vai direto para o aplicativo do WhatsApp. Dá para instalar como aplicativo no celular: no Chrome, menu › "Adicionar à tela inicial".

## Papéis

| Papel | O que faz |
|---|---|
| Dono | Acesso master: tudo o que o administrador faz, e também criar/promover administradores, excluir listas e usar a LGPD. As ações do dono não aparecem para os administradores. |
| Administrador | Equipe (supervisores e atendentes), configurações, listas e Auditoria. Não mexe em administradores nem no dono. |
| Supervisor | Vê a equipe toda, importa listas, redistribui e exporta. Não mexe em configurações nem em usuários. |
| Atendente | Trabalha só nos leads dele. Não vê os leads dos colegas nem as telas de gestão. |

---

## Usar no seu computador

Precisa só do **Node.js 22 ou mais novo** ([nodejs.org](https://nodejs.org), botão "LTS"). Não precisa instalar banco de dados: o sistema sobe um Postgres local sozinho.

Abra o terminal na pasta do projeto e rode:

```bash
npm install
```

```bash
npm run dev
```

Abra **http://localhost:5173**. Na primeira vez o sistema está vazio e mostra a tela **Primeiro acesso**: cole o **código de primeiro acesso** que aparece no terminal e preencha seu nome, e-mail e senha. Você vira o **dono** (acesso master) e já cai em **Usuários** para cadastrar a equipe.

**Com Docker** (opcional): `docker compose up --build` e abra http://localhost:3000. Crie o dono com
`docker compose exec app node dist/server/criar-admin.js --nome "Seu Nome" --email voce@empresa.com.br`.

---

## Colocar no ar (recomendado: Render)

Custo aproximado em 2026 (confira os preços atuais no site da Render): **servidor Starter ≈ US$ 7/mês + banco Postgres Basic ≈ US$ 6/mês ≈ US$ 13/mês (uns R$ 75)**. O plano grátis do servidor "dorme" depois de 15 minutos parado e demora para acordar; serve só para testar.

1. Crie uma conta no [GitHub](https://github.com) e envie esta pasta para um repositório **privado** (no GitHub Desktop: *Add existing repository* › *Publish repository*, marcando "Keep this code private").
2. Crie uma conta na [Render](https://render.com) e conecte o GitHub.
3. Na Render: **New › Blueprint**, escolha o repositório. Ela lê o arquivo `render.yaml` e cria o site e o banco. Clique em **Apply**.
4. Espere o primeiro deploy terminar (uns 5 minutos). O endereço aparece no topo, algo como `https://chamador-de-leads.onrender.com`.
5. **Primeiro acesso (dono):** no painel da Render, abra o serviço › **Environment** e copie o valor de `SETUP_TOKEN`. Abra o endereço do sistema: ele mostra a tela **Primeiro acesso**. Cole o código, seu nome, e-mail e senha. Pronto, você é o dono (acesso master).
6. Depois de criar o dono, pode apagar a variável `SETUP_TOKEN` na Render (a tela de primeiro acesso se fecha sozinha de qualquer jeito quando já existe um usuário).

**Domínio próprio (opcional):** na Render, *Settings › Custom Domains*, adicione `leads.suaempresa.com.br` e crie no seu provedor de domínio o registro CNAME que ela indicar. Depois cadastre a variável `APP_URL=https://leads.suaempresa.com.br` e salve (os links de convite passam a usar esse endereço).

**Alternativas:** Railway (parecido, cobra por uso), ou um servidor VPS com `docker compose` (mais barato, mas exige saber configurar servidor e HTTPS). Para economizar o banco, dá para usar o Postgres grátis da [Neon](https://neon.tech): crie o banco lá, copie a *connection string* e coloque em `DATABASE_URL` no serviço da Render (remova o banco `chamador-db` do blueprint).

### Criar o dono pelo terminal (alternativa)

Com acesso ao terminal do servidor (ou no computador, apontando `DATABASE_URL` para o banco de produção):

```bash
npm run criar-admin -- --nome "Seu Nome" --email voce@empresa.com.br
```

A pessoa criada é o **dono** (acesso master). A senha é gerada e mostrada uma vez. Se o e-mail já existir, a senha é redefinida e a pessoa volta a ser dono (serve para recuperar o acesso). No build de produção: `node dist/server/criar-admin.js ...`.

## Cadastrar a equipe (Usuários)

O menu **Usuários** é o painel do administrador:

1. **Novo usuário** › nome, e-mail (é o login) e o papel na hierarquia: **dono**, **administrador**, **supervisor** ou **atendente**. O administrador só cria supervisores e atendentes; só o dono cria administradores e outros donos.
2. Escolha como a pessoa vai entrar:
   - **Definir a senha agora:** você digita a senha (ou clica em **Gerar**). A pessoa já entra com o e-mail e essa senha; use **Copiar dados de acesso** ou **Enviar pelo WhatsApp** para passar para ela.
   - **Enviar link de convite:** a pessoa recebe um link (vale 7 dias, uma vez só) e cria a própria senha.
3. Em cada pessoa: **Editar** (nome, e-mail, papel, limite de leads por dia) e, no menu **…**: **Definir nova senha** (a sessão dela cai na hora), gerar link para ela mesma trocar a senha, devolver os leads dela à fila livre, **Desativar/Reativar acesso**.

Os cartões do topo mostram quantas pessoas há em cada nível da hierarquia e servem de filtro. Tudo fica registrado na **Auditoria**.

## Uso no dia a dia

- **Listas › Importar:** arraste o Excel/CSV. O sistema acha as colunas da empresa, do sócio e do telefone (dá para trocar cada uma), mostra o total de empresas e de telefones, quantos entram, quantos são repetidos e quantos são inválidos, e só grava quando você confirma. Depois dá para baixar as linhas recusadas com o motivo.
- **A chamar:** escolha quantos leads pegar e de qual DDD › "Pegar leads" (cada atendente tem um limite por dia), filtre a sua fila por DDD, "Chamar no WhatsApp" (mensagem já escrita), "Marcar como chamado" ou "Sem WhatsApp". O **Modo foco** mostra um lead por vez, com atalhos de teclado (W, C, S, R, P).
- **Já chamados:** empresa, sócio, quem chamou, quando e o resultado (mensagem enviada, respondeu, não respondeu, sem conta no banco, não é correntista…); dá para mudar o resultado, anotar, agendar retorno e reabrir a conversa.
- **Painel:** números por atendente (hoje, 7 e 30 dias, conversão) e andamento de cada lista (empresas, telefones e quanto falta pegar); exporta CSV/Excel.
- **Auditoria:** tudo o que cada pessoa fez, com filtro por pessoa e tipo: pedidos de leads, qual lead foi para quem, quantos cada um puxou e chamou por dia, quem mais puxou e quem mais chamou, tentativas de acesso sem permissão. Baixa em planilha.
- **Configurações:** mensagens prontas, regras da fila (quantos leads por clique, limite na fila, limite de leads por dia, devolução automática de leads parados), nome/logo da empresa, lista de "não contatar" e LGPD (só o dono). O limite diário de cada atendente também pode ser definido em **Usuários**.

## Backup

- **Automático:** o Postgres pago da Render faz backup diário (veja *Recovery* no painel do banco).
- **Manual (recomendado uma vez por semana):** no Painel, **Base completa (CSV)** ou **Excel** baixa todos os leads com situação, resultado e quem chamou.
- **Cópia completa do banco:** com o Postgres instalado (ou Docker), rode
  `pg_dump "SUA_DATABASE_URL" > backup.sql` (ou `docker run --rm postgres:17 pg_dump "SUA_DATABASE_URL" > backup.sql`).
  Para restaurar: `psql "NOVA_DATABASE_URL" < backup.sql`.

---

## Para quem mantém o código

- Stack: Node.js 22 + TypeScript, Fastify, Postgres (Kysely), React + Vite. Detalhes em [docs/DECISOES.md](docs/DECISOES.md).
- `npm test` roda tudo: testes unitários, de integração (Postgres de verdade) e ponta a ponta (Playwright, com o build de produção). Na primeira vez: `npx playwright install chromium`.
- `npm run check` = lint + tipos + testes. A CI do GitHub roda o mesmo (`.github/workflows/ci.yml`).
- Variáveis de ambiente: veja [.env.example](.env.example).
- Outros documentos: [mudanças em relação ao protótipo](docs/MUDANCAS-EM-RELACAO-AO-PROTOTIPO.md), [LGPD](docs/LGPD.md), [WhatsApp Cloud API](docs/WHATSAPP-CLOUD-API.md).
