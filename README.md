# Chamador de Leads + Central de WhatsApp

Um sistema só para a equipe que chama leads pelo WhatsApp:

- o **gestor** importa as listas de leads (Excel ou CSV), cadastra a equipe e acompanha tudo pelo **Painel** e pela
  **Auditoria**;
- cada **atendente** entra com o próprio login, pega leads da fila e clica em **Chamar no WhatsApp**: escolhe por
  qual número falar e a conversa abre aqui dentro, pronta para gravar o áudio. O resultado (mensagem enviada,
  respondeu) é marcado sozinho, e dá para anotar observações e agendar retornos;
- as conversas de **todos os números de WhatsApp** conectados ficam num lugar só (**Conversas**), com texto, áudio
  gravado na hora, imagens e documentos. Os números são conectados pela
  [Evolution API](https://github.com/evolution-foundation/evolution-api) (versão fixa **v2.3.7**), na tela **Números**.

Tudo fica registrado: quem pegou, quem chamou, quando, com qual resultado, quem enviou cada mensagem e todo o histórico
de cada lead. Os leads são **empresas (pessoa jurídica)**: aparece o nome da empresa em destaque e o sócio/proprietário
embaixo.

Para colocar no VPS (domínio + HTTPS), siga [`docs/DEPLOY.md`](docs/DEPLOY.md). O plano e as decisões estão em
[`docs/PLANO.md`](docs/PLANO.md) e [`docs/DECISOES.md`](docs/DECISOES.md).

## Papéis

| Papel | O que faz |
|---|---|
| Dono | Acesso master: tudo o que o administrador faz, e também criar/promover administradores, excluir listas e usar a LGPD. As ações do dono não aparecem para os administradores. |
| Administrador | Equipe (supervisores e atendentes), configurações, listas, **todos os números de WhatsApp** (inclusive escolher o responsável de cada um) e Auditoria. Não mexe em administradores nem no dono. |
| Supervisor | Vê a equipe toda e **todas as conversas**, importa listas, redistribui e exporta. Não mexe em configurações, usuários nem nos números dos outros. |
| Atendente | Trabalha só nos leads dele e **só vê as conversas dos números de WhatsApp de que é responsável**. Não vê os leads dos colegas nem as telas de gestão. |

**Números de WhatsApp:** qualquer pessoa cadastra e conecta os próprios números em **Números** e fica como responsável
por eles. Dono, administrador e supervisor veem as conversas de todos os números; o atendente, só as dos números dele
(pela tela e também pelo tempo real). Dono e administrador conectam, renomeiam e trocam o responsável de qualquer
número; o supervisor vê, mas só mexe nos próprios.

## Serviços (Docker)

| Serviço | Para quê |
|---|---|
| `app` | O sistema: o site e o backend (leads, equipe, conversas). Recebe os webhooks da Evolution e envia as mensagens |
| `evolution` | Conecta os números de WhatsApp (1 instância por número) |
| `postgres` | Banco `central` (o nosso sistema) e banco `evolution` (usado pela Evolution) |
| `redis` | Cache da Evolution |
| `backup` | Todo dia às 3h copia os dois bancos e as mídias para a pasta `backups` |
| `caddy` | Só no VPS: HTTPS automático no seu domínio (arquivo `docker-compose.prod.yml`) |

A Evolution (`127.0.0.1:8080`) e o sistema (`127.0.0.1:3100`) só ficam acessíveis no próprio computador, nunca pela
rede. A chave da Evolution fica só no backend, e o webhook só é aceito com o token secreto.

## Como rodar no Windows

Pré-requisitos: **Docker Desktop** aberto e **Git** instalado.

Use o **PowerShell**, não o Prompt de Comando (cmd): menu Iniciar → digite `PowerShell` → **Windows PowerShell**.
Em seguida, entre na pasta do projeto:

```powershell
cd C:\Users\D7\Desktop\CRM\central-whatsapp
```

### 1. Baixar o projeto (só na primeira vez)

```powershell
git clone https://github.com/glayvisondouglas97-code/tech.git central-whatsapp
cd central-whatsapp
git checkout claude/whatsapp-evolution-central-dzt5ar
```

### 2. Criar o arquivo de senhas `.env` (só na primeira vez)

```powershell
Copy-Item .env.example .env
[guid]::NewGuid().ToString("N")
[guid]::NewGuid().ToString("N")
[guid]::NewGuid().ToString("N")
```

Os três últimos comandos geram três senhas aleatórias. Abra o arquivo com `notepad .env`, cole uma em
`POSTGRES_PASSWORD`, outra em `EVOLUTION_API_KEY` e a última em `WEBHOOK_TOKEN`, e salve.

> O `.env` nunca vai para o GitHub (está no `.gitignore`).

### 3. Subir os serviços

```powershell
docker compose up -d --build
```

Na primeira vez ele baixa as imagens e monta o sistema, o que leva alguns minutos. Para acompanhar:

```powershell
docker compose logs -f app
```

Aperte `Ctrl + C` para sair dos logs. Os serviços continuam rodando.

### 4. Criar o dono (só na primeira vez)

Troque o nome e o e-mail:

```powershell
docker compose exec app node dist/server/criar-admin.js --nome "Seu Nome" --email voce@email.com
```

O comando mostra a **senha** uma vez só (para escolher a senha, acrescente `--senha "uma senha forte"`). Abra
**<http://localhost:3100>**, entre com o e-mail e essa senha e troque-a em **Minha conta e senha** (clique no círculo
com as suas iniciais, no canto de cima à direita).

O mesmo comando serve para **recuperar o acesso**: com um e-mail que já existe, ele gera uma senha nova e a pessoa volta
a ser dono.

### 5. Cadastrar a equipe (Usuários)

1. **Usuários** → **Novo usuário** → nome, e-mail (é o login) e o papel. O administrador só cria supervisores e
   atendentes; só o dono cria administradores e outros donos.
2. Escolha como a pessoa vai entrar:
   - **Definir a senha agora:** você digita a senha (ou clica em **Gerar**) e passa para a pessoa com **Copiar dados
     de acesso** ou **Enviar pelo WhatsApp**.
   - **Enviar link de convite:** a pessoa recebe um link (vale 7 dias, uma vez só) e cria a própria senha.
3. Em cada pessoa: **Editar** (nome, e-mail, papel, limite de leads por dia) e, no menu **…**: **Definir nova senha**
   (a sessão dela cai na hora), link para ela mesma trocar a senha, devolver os leads dela à fila livre e
   **Desativar/Reativar acesso**.

### 6. Conectar os números

1. No menu, clique em **Números** → **Adicionar número**, digite um apelido (ex.: `WhatsApp 3 - João`) e clique em
   **Criar e conectar**. Cada atendente pode fazer isso com o próprio número.
2. O QR Code aparece na tela. No celular desse número, abra o WhatsApp → **Dispositivos conectados** →
   **Conectar dispositivo** e escaneie. Ao conectar, a janela mostra "Conectado!" e fecha sozinha.
3. Quem cadastra fica como **responsável** pelo número. O dono e o administrador trocam o responsável no cartão do número
   (campo **Responsável**): é assim que um número cadastrado pela gestão passa a aparecer para um atendente. Número
   **sem responsável** só aparece para dono, administrador e supervisor.

O sistema cria o número na Evolution já com o webhook, "ignorar grupos" ligado e "marcar como lida automaticamente"
desligado. O histórico dos últimos 14 dias é importado sozinho logo depois da conexão.

**Número caiu?** O item **Números** do menu ganha um selo vermelho com a quantidade de números desconectados. Na tela de
números, clique em **Reconectar** no cartão dele: se a sessão ainda valer, ele volta sozinho; se não, aparece um QR Code
novo. O apelido se troca no lápis ao lado do nome.

**Excluir número:** no cartão do número, **⋯** → **Excluir número** e digite **EXCLUIR**. O número é desconectado (sai de
"Dispositivos conectados" no celular), sai da Evolution e todas as conversas e mensagens dele são apagadas do sistema. O
WhatsApp do celular continua funcionando. Quem pode: o responsável pelo número e o dono/administrador.

> O painel da Evolution (<http://localhost:8080/manager>) continua disponível para emergências, mas não é necessário.
> Não altere nele as opções de webhook dos números.

## Uso no dia a dia

- **Listas › Importar:** arraste o Excel/CSV. O sistema acha as colunas da empresa, do sócio e do telefone (dá para
  trocar cada uma), mostra o total de empresas e de telefones, quantos entram, quantos são repetidos e quantos são
  inválidos, e só grava quando você confirma. Depois dá para baixar as linhas recusadas com o motivo.
- **Listas › Excluir e limpar:** o dono marca as caixinhas das listas (ou "selecionar todas") e clica em **Excluir
  selecionadas**; para confirmar, digita **EXCLUIR**. Isso apaga os leads dessas listas e todo o histórico deles, sem
  volta (para só tirar da fila, use **Arquivar** no menu **⋯**). Em **Importações recentes**, dono e administrador
  removem uma importação pela lixeira ou tudo em **Limpar histórico**: some só o registro e as linhas recusadas; as
  listas e os leads continuam.
- **A chamar:** escolha quantos leads pegar e de qual DDD › **Pegar leads** (cada atendente tem um limite por dia),
  filtre a sua fila por DDD e chame (veja **Chamar um lead** abaixo). "Marcar como chamado" e "Sem WhatsApp" continuam
  para quem falou por outro meio. O **Modo foco** mostra um lead por vez, com atalhos de teclado (**W** chama).
- **Conversas:** todas as conversas de todos os números, da mais recente para a mais antiga (detalhes abaixo).
- **Já chamados:** empresa, sócio, quem chamou, quando e o resultado (mensagem enviada, respondeu, não respondeu, sem
  conta no banco, não é correntista…); dá para mudar o resultado, anotar, agendar retorno e reabrir.
- **Painel:** números por atendente (hoje, 7 e 30 dias, conversão) e andamento de cada lista (empresas, telefones e
  quanto falta pegar); exporta CSV/Excel.
- **Auditoria:** tudo o que cada pessoa fez, com filtro por pessoa e tipo: pedidos de leads, qual lead foi para quem,
  quantos cada um puxou e chamou por dia, números criados/renomeados/conectados e tentativas de acesso sem permissão.
  Baixa em planilha.
- **Configurações:** regras da fila (quantos leads por clique, limite na fila, limite por dia, devolução automática de
  leads parados, aviso de conversas abertas por hora), nome/logo da empresa, lista de "não contatar" e LGPD (só o dono).

### Chamar um lead

1. Em **A chamar** (ou em **Já chamados**, ou na ficha do lead), clique em **Chamar no WhatsApp**.
2. Escolha **por qual número** falar. O último número usado já vem marcado (é só apertar **Enter**) e as teclas **1** a
   **9** escolhem pela posição. Números desconectados aparecem apagados; o selo **Já conversou** mostra por qual número
   essa empresa já foi chamada.
3. O sistema confere se o telefone do lead tem WhatsApp. Se não tiver, oferece **Marcar como Sem WhatsApp**.
4. A conversa abre em **Conversas**, com a caixa de texto vazia: grave o áudio no **microfone** (ou escreva) e envie.
5. Ao sair a primeira mensagem, o lead fica **Chamado · Mensagem enviada** e sai da sua fila. Quando ele responder, o
   resultado muda sozinho para **Respondeu** (e a resposta fica no histórico do lead).
6. No alto da conversa aparece a faixa do lead (situação, sócio e lista), com **Ver lead** (ficha e histórico, para
   anotar e agendar retorno) e **Voltar para a fila**. No celular, a seta do alto volta para a fila.

Uma conversa aberta pelo **Chamar** só aparece na lista de conversas depois da primeira mensagem.

### Conversas (WhatsApp)

- **Quem vê o quê:** o atendente vê só as conversas dos números de que é responsável; dono, administrador e supervisor
  veem todas.
- **Lista:** a aba **Responderam** mostra só os leads que responderam; **Todas** mostra tudo. A busca procura pelo nome,
  pela empresa do lead ou por parte do telefone. A conversa de um lead chamado pelo sistema aparece com o nome da
  empresa. Os botões com o nome de cada número mostram só as conversas daquele WhatsApp. Cada conversa
  tem a bolinha colorida do número e o contador de não lidas. O item **Conversas** do menu mostra o total de conversas
  não lidas, que também aparece no título da aba do navegador, por exemplo `(3) Chamador de Leads`.
- **Chat:** **Enter** envia e **Shift + Enter** quebra a linha. No alto aparece por qual número a resposta sai (sempre o
  mesmo da conversa). Cada mensagem enviada pelo sistema guarda quem da equipe enviou.
- Abrir a conversa zera as não lidas **no sistema**. O tique azul só vai para o lead quando alguém responde.
- Mensagens novas, status (entregue/lida) e contadores aparecem na hora, em todas as telas abertas. Se a conexão cair,
  aparece um aviso; quando ela volta, a tela busca sozinha o que chegou nesse meio tempo.
- **Áudio:** com a caixa de texto vazia, clique no **microfone** para gravar; clique na **seta verde** para enviar (ou na
  **lixeira** para descartar). O áudio chega no WhatsApp do lead como **mensagem de voz**. Na primeira vez, o navegador
  pede permissão para usar o microfone.
- **Imagem ou documento:** clique no **clipe**, escolha o arquivo (até 25 MB), escreva uma legenda se quiser e envie.
  JPG, PNG e WebP vão como imagem; qualquer outro arquivo (PDF, planilha etc.) vai como documento.
- **Mídias recebidas:** áudios têm player com velocidade (1×, 1,5×, 2×); imagens abrem em tela cheia e documentos têm o
  botão de baixar. Os arquivos ficam no volume `midias` do Docker (não no banco).
- **Apagar mensagens:** no chat, menu **⋯** → **Selecionar mensagens**, toque nas mensagens e escolha **Apagar para mim**
  (somem do sistema; o contato continua vendo) ou **Apagar para todos** (somem também do WhatsApp do contato; só
  mensagens enviadas pelo número nas últimas 48 horas, como no WhatsApp). **Esc** cancela.
- **Excluir conversas:** na lista, o botão de marcar (ao lado da busca) liga a seleção; marque as conversas (ou
  **Selecionar todas**) e clique em **Excluir**. No chat aberto: menu **⋯** → **Excluir conversa**. Somem do sistema com
  as mensagens e os arquivos; no celular continuam. Se o contato escrever de novo, a conversa volta só com as mensagens
  novas.
- **Quem apaga:** o responsável pelo número e o dono/administrador. O supervisor vê, mas não apaga nas conversas dos
  outros. Tudo fica na Auditoria. O que foi apagado não volta nem quando o número reconecta e o histórico é
  reimportado.

### No celular

A tela se adapta ao celular: barra de atalhos embaixo (**A chamar**, **Conversas**, **Chamados**, **Painel** e
**Menu**), sempre fixa (só o conteúdo rola; ela só some dentro de uma conversa do WhatsApp). A conversa abre em tela
cheia e o botão **voltar** do celular volta para a lista. No celular, **Enter** quebra
a linha e a seta verde envia.

Use o endereço do VPS (com `https://`), porque o microfone só funciona em site seguro. Para usar como aplicativo:

- **Android (Chrome):** menu **⋮** → **Adicionar à tela inicial** (ou **Instalar app**).
- **iPhone (Safari):** botão **Compartilhar** → **Adicionar à Tela de Início**.

## Backup

- O serviço `backup` copia **todo dia às 3h** (horário de Brasília) os bancos `central` (leads, equipe, conversas) e
  `evolution` (sessões dos números), e as **mídias**, para a pasta **`backups`** do projeto. Guarda os últimos 7 dias.
- Backup na hora: `docker compose exec backup sh /backup.sh agora`
- A pasta `backups` fica no mesmo computador/servidor. **Copie-a de vez em quando para outro lugar** (seu computador,
  Google Drive). Se o servidor for perdido, é essa cópia que salva os dados. No VPS, ver [`docs/DEPLOY.md`](docs/DEPLOY.md).
- Além disso, no **Painel**, **Base completa (CSV)** ou **Excel** baixa todos os leads com situação, resultado e quem
  chamou.
- **Restaurar** (substitui os dados atuais pelos do backup; troque a data pela do arquivo que quer usar):

  ```powershell
  docker compose stop app evolution
  docker compose exec backup pg_restore -d central --clean --if-exists /backups/central_2026-09-24_0300.dump
  docker compose exec backup pg_restore -d evolution --clean --if-exists /backups/evolution_2026-09-24_0300.dump
  docker compose run --rm -v central-whatsapp_midias:/restaurar --entrypoint sh backup -c "tar xzf /backups/midias_2026-09-24_0300.tar.gz -C /restaurar"
  docker compose up -d
  ```

## Como atualizar (a cada nova fase)

```powershell
git pull
docker compose up -d --build
```

## Comandos úteis

| Comando | O que faz |
|---|---|
| `docker compose ps` | Mostra o que está rodando |
| `docker compose logs -f app` | Acompanha os logs do sistema (`Ctrl + C` para sair) |
| `docker compose logs -f evolution` | Acompanha os logs da Evolution |
| `docker compose down` | Para tudo. **Os dados continuam salvos** |
| `docker compose up -d` | Sobe tudo de novo |
| `docker compose exec app node dist/server/criar-admin.js --email voce@email.com` | Recupera o acesso de dono (mostra uma senha nova) |
| `docker compose exec backup sh /backup.sh agora` | Faz um backup na hora |

> ⚠️ **Nunca** rode `docker compose down -v`: o `-v` apaga os volumes, ou seja, o banco de dados, as mídias e as
> sessões dos números. Seria preciso escanear todos os QR Codes de novo.

## Problemas comuns

- **`defina WEBHOOK_TOKEN no arquivo .env`** (ou outra variável): falta essa linha no `.env` (passo 2).
- **`'Invoke-RestMethod' não é reconhecido`**: você está no Prompt de Comando (cmd). Abra o PowerShell.
- **`ports are not available` / `bind` na porta 3100**: outro programa usa a porta. Adicione `APP_PORT=3200` (ou outro
  número) no `.env` e rode `docker compose up -d` de novo. Na porta 8080 (Evolution), me avise.
- **Troquei a senha do Postgres no `.env` depois de já ter subido**: o banco continua com a senha antiga. Volte a senha
  antiga no `.env` ou me peça ajuda.

## Rotas de WhatsApp da API

Todas exigem login (cookie da sessão) e, nas que alteram dados, o cabeçalho `x-csrf-token`. As rotas de leads, listas,
equipe e relatórios estão em `src/server/routes`.

| Rota | O que faz |
|---|---|
| `POST /api/leads/ID/conversation` | "Chamar": confere se o lead tem WhatsApp e abre a conversa pelo número escolhido (`{"instanceId": 1}`) |
| `GET /api/leads/ID/conversations` | Conversas já abertas com o lead (por qual número) |
| `GET /api/instances` | Lista os números que a pessoa vê (atendente: só os dele), com status e responsável |
| `POST /api/instances` | Cria um número novo (`{"nickname": "..."}`), já com webhook e opções; quem cria fica como responsável |
| `PATCH /api/instances/ID` | Troca o apelido (responsável ou dono/administrador) e o responsável (`{"ownerId": "..."}`, só dono/administrador) |
| `POST /api/instances/ID/connect` | Conecta/reconecta um número; o QR Code chega em tempo real (responsável ou dono/administrador) |
| `POST /api/instances/ID/import-history` | Reimporta o histórico dos últimos 14 dias de um número (responsável ou dono/administrador) |
| `GET /api/conversations?tab=responderam` | Conversas em que o lead respondeu (também `tab=todas`, `&instanceId=1` e `&q=maria`) |
| `GET /api/conversations/stats` | Totais do menu: conversas com não lidas e números desconectados |
| `GET /api/conversations/ID` · `GET /api/conversations/ID/messages` | Uma conversa e as mensagens dela |
| `POST /api/conversations/ID/messages` | Envia texto (`{"text": "..."}`) pelo mesmo número da conversa |
| `POST /api/conversations/ID/read` | Zera as não lidas no sistema (não manda tique azul) |
| `POST /api/conversations/ID/audio` | Envia áudio gravado (corpo = arquivo de áudio) como mensagem de voz |
| `POST /api/conversations/ID/media?fileName=...&caption=...` | Envia imagem ou documento (corpo = arquivo) |
| `GET /api/messages/ID/media` | Abre/baixa a mídia de uma mensagem |
| `POST /api/conversations/ID/messages/delete` | Apaga mensagens (`{"ids": [..], "forEveryone": false}`; `true` = para todos) |
| `POST /api/conversations/delete` | Exclui conversas do sistema (`{"ids": [..]}`) |
| `POST /api/instances/ID/delete` | Exclui o número (`{"confirm": "EXCLUIR"}`): desconecta, tira da Evolution e apaga as conversas |
| `POST /webhook/evolution` | Eventos da Evolution (só pela rede interna do Docker, com o token secreto) |

## Para quem mantém o código

- Stack: Node.js 22 + TypeScript, Fastify 5, Postgres (Kysely), Socket.io (tempo real das conversas), React 19 + Vite +
  TanStack Query. Detalhes em [`docs/DECISOES.md`](docs/DECISOES.md).
- Pastas: `src/server` (API, banco e migrações; WhatsApp em `src/server/modules/whatsapp`), `src/web` (telas),
  `src/shared` (tipos e permissões usados pelos dois lados), `tests` (unitários, integração e ponta a ponta).
- `npm install` e `npm run dev`: abre em <http://localhost:5173> e sobe um Postgres local sozinho (sem Docker). Na
  primeira vez mostra a tela **Primeiro acesso**: cole o código que aparece no terminal. Sem `EVOLUTION_URL`, o
  WhatsApp fica desligado e os itens **Conversas** e **Números** somem do menu; para testar o WhatsApp, use o Docker.
- `npm test` roda os testes unitários, de integração (Postgres de verdade, com uma Evolution de mentira) e ponta a ponta
  (Playwright, com o build de produção). Na primeira vez: `npx playwright install chromium`.
- `npm run check` = lint + tipos + testes. A CI do GitHub roda o mesmo (`.github/workflows/ci.yml`).
- Variáveis de ambiente: [`.env.example`](.env.example) (as do Docker) e `src/server/config.ts` (todas).
- Outros documentos: [LGPD](docs/LGPD.md) e o [histórico do projeto](docs/historico).
