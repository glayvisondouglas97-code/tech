# Central de WhatsApp

Sistema web próprio que junta, num só lugar, as conversas de vários números de WhatsApp conectados pela
[Evolution API](https://github.com/evolution-foundation/evolution-api) (versão fixa **v2.3.7**).

O plano completo e as decisões estão em [`docs/PLANO.md`](docs/PLANO.md). Para colocar no VPS (domínio + HTTPS), siga
[`docs/DEPLOY.md`](docs/DEPLOY.md).

## Serviços

| Serviço | Para quê |
|---|---|
| `evolution` | Conecta os números de WhatsApp (1 instância por número) |
| `postgres` | Banco `evolution` (usado pela Evolution) e banco `central` (usado pelo nosso sistema) |
| `redis` | Cache da Evolution |
| `app` | Nosso sistema: o site (tela de conversas) e o backend, que recebe os webhooks, grava as conversas e envia as respostas |
| `backup` | Todo dia às 3h copia os dois bancos e as mídias para a pasta `backups` |
| `caddy` | Só no VPS: HTTPS automático no seu domínio (arquivo `docker-compose.prod.yml`) |

A Evolution (`127.0.0.1:8080`) e o backend (`127.0.0.1:3100`) só ficam acessíveis no próprio computador,
nunca pela rede. O sistema exige login.

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

Na primeira vez ele baixa as imagens e monta o backend, o que leva alguns minutos. Para acompanhar:

```powershell
docker compose logs -f app
```

Aperte `Ctrl + C` para sair dos logs. Os serviços continuam rodando.

### 4. Criar o primeiro acesso (só na primeira vez)

Crie o seu usuário de administrador (troque o nome e o e-mail):

```powershell
docker compose exec app node src/cli.ts criar-admin "Seu Nome" voce@email.com
```

O comando mostra uma **senha provisória**. Abra **<http://localhost:3100>**, entre com o e-mail e essa senha e troque-a
em **Minha senha** (clique no círculo com as suas iniciais, no canto de baixo à esquerda). Depois, cadastre a equipe
em **Usuários** (ver "Equipe" abaixo).

### 5. Conectar os números

1. Abra **<http://localhost:3100>** e clique em **Números**, no menu da esquerda.
2. Clique em **Adicionar número**, digite um apelido (ex.: `WhatsApp 3 - João`) e clique em **Criar e conectar**.
3. O QR Code aparece na tela. No celular desse número, abra o WhatsApp → **Dispositivos conectados** →
   **Conectar dispositivo** e escaneie. Ao conectar, a janela mostra "Conectado!" e fecha sozinha.

O sistema cria o número na Evolution já com o webhook, "ignorar grupos" ligado e "marcar como lida automaticamente"
desligado. O histórico dos últimos 14 dias é importado sozinho logo depois da conexão.

**Número caiu?** O ícone **Números** do menu ganha um selo vermelho com a quantidade de números desconectados. Na tela
de números, clique em **Reconectar** no cartão dele: se a sessão ainda valer, ele volta sozinho; se não, aparece um QR
Code novo. O apelido se troca no lápis ao lado do nome.

> O painel da Evolution (<http://localhost:8080/manager>) continua disponível para emergências, mas não é mais
> necessário. Não altere nele as opções de webhook dos números.

## Usar o sistema

Abra **<http://localhost:3100>** no navegador.

- **Menu da esquerda**: **Conversas** (com o total de conversas não lidas), **Números** (com o total de desconectados)
  e **Usuários** (só administradores). Embaixo, o círculo com as suas iniciais abre **Minha senha** e **Sair**.
- **Lista de conversas**: todas as conversas de todos os números, da mais recente para a mais antiga. A aba
  **Responderam** mostra só os leads que responderam; a aba **Todas** mostra tudo. A busca procura pelo nome ou por
  parte do telefone. Os botões com o nome de cada número mostram só as conversas daquele WhatsApp. Cada conversa tem
  a bolinha colorida do número por onde ela acontece e o contador de não lidas.
- **Chat**: **Enter** envia e **Shift + Enter** quebra a linha. No alto aparece por qual número a resposta sai (sempre
  o mesmo da conversa). Mensagens seguidas ficam agrupadas, e o dia fica fixo no alto enquanto você rola.
- Abrir a conversa zera as não lidas **no sistema**. O tique azul só vai para o lead quando alguém responde. O total
  de não lidas também aparece no título da aba do navegador, por exemplo `(3) Central WhatsApp`.
- Mensagens novas, status (entregue/lida) e contadores aparecem na hora, em todas as telas abertas. Se você estiver
  lendo mensagens antigas, um botão com seta mostra quantas chegaram e leva ao fim do chat. Se a conexão cair, aparece
  um aviso amarelo; quando ela volta, a tela busca sozinha o que chegou nesse meio tempo.
- **Áudio**: com a caixa de texto vazia, clique no **microfone** para gravar. Aparece o tempo da gravação; clique na
  **seta verde** para enviar (ou na **lixeira** para descartar). O áudio chega no WhatsApp do lead como **mensagem de
  voz**. Na primeira vez, o navegador pede permissão para usar o microfone.
- **Imagem ou documento**: clique no **clipe**, escolha o arquivo (até 25 MB), escreva uma legenda se quiser e envie.
  JPG, PNG e WebP vão como imagem; qualquer outro arquivo (PDF, planilha etc.) vai como documento.
- **Mídias recebidas**: áudios têm player com velocidade (1×, 1,5×, 2×); imagens aparecem no chat (clique para ver em
  tela cheia) e documentos têm o botão de baixar. As mídias ficam guardadas no volume `media_data` do Docker (não no
  banco).
- **Modo escuro**: a tela segue o tema do computador ou do celular (claro ou escuro) sozinha.

### No celular

A tela se adapta ao celular: a lista ocupa a tela inteira, a conversa abre em tela cheia e o botão **voltar** do
celular volta para a lista. O menu fica numa barra embaixo (**Conversas**, **Números**, **Usuários** e **Conta**). No
celular, **Enter** quebra a linha e a seta verde envia.

Use o endereço do VPS (com `https://`), porque o microfone só funciona em site seguro. Para usar como aplicativo:

- **Android (Chrome)**: menu **⋮** → **Adicionar à tela inicial** (ou **Instalar app**).
- **iPhone (Safari)**: botão **Compartilhar** → **Adicionar à Tela de Início**.

O ícone da Central aparece junto com os outros aplicativos e abre em tela cheia, sem a barra do navegador.

## Equipe (login)

- Cada pessoa entra com o próprio e-mail e senha. O login dura 30 dias no navegador (ou até clicar em **Sair**).
- **Usuários** (menu da esquerda, só para administradores): **Adicionar pessoa** cria o acesso e mostra uma **senha
  provisória** (com botão **Copiar**), que você passa para a pessoa. Ela troca em **Minha senha** no primeiro acesso.
- No botão **⋯** de cada pessoa: **Gerar nova senha** cria uma provisória nova (para quem esqueceu). **Desativar
  acesso** tira o acesso na hora: a tela da pessoa volta para o login. **Tornar administrador** permite que a pessoa
  também gerencie usuários.
- Depois de 10 senhas erradas seguidas para o mesmo e-mail, o login dele fica bloqueado por 15 minutos.
- **Ficou sem acesso de administrador?** Pelo terminal:
  `docker compose exec app node src/cli.ts redefinir-senha voce@email.com` (mostra uma senha provisória nova).

## Backup

- O serviço `backup` copia **todo dia às 3h** (horário de Brasília) os bancos `evolution` (sessões dos números) e
  `central` (conversas e usuários), e as **mídias**, para a pasta **`backups`** do projeto. Guarda os últimos 7 dias.
- Backup na hora: `docker compose exec backup sh /backup.sh agora`
- A pasta `backups` fica no mesmo computador/servidor. **Copie-a de vez em quando para outro lugar** (seu computador,
  Google Drive). Se o servidor for perdido, é essa cópia que salva os dados. No VPS, ver [`docs/DEPLOY.md`](docs/DEPLOY.md).
- **Restaurar** (substitui os dados atuais pelos do backup; troque a data pela do arquivo que quer usar):

  ```powershell
  docker compose stop app evolution
  docker compose exec backup pg_restore -d central --clean --if-exists /backups/central_2026-09-24_0300.dump
  docker compose exec backup pg_restore -d evolution --clean --if-exists /backups/evolution_2026-09-24_0300.dump
  docker compose run --rm -v central-whatsapp_media_data:/restaurar --entrypoint sh backup -c "tar xzf /backups/midias_2026-09-24_0300.tar.gz -C /restaurar"
  docker compose up -d
  ```

## Como atualizar (a cada nova fase)

```powershell
git pull
docker compose up -d --build
```

## API do backend

Todas as rotas `/api` exigem login (cookie da sessão), menos `/api/auth/login`.

| Rota | O que faz |
|---|---|
| `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me` | Entrar, sair, quem sou eu |
| `POST /api/auth/password` | Trocar a própria senha |
| `GET/POST /api/users` · `PATCH /api/users/ID` · `POST /api/users/ID/reset-password` | Equipe (só administradores) |
| `GET /api/instances` | Lista os números e o status de cada um |
| `GET /api/conversations?tab=responderam` | Conversas em que o lead respondeu, da mais recente para a mais antiga |
| `GET /api/conversations?tab=todas` | Todas as conversas (também aceita `&instanceId=1` para filtrar por número e `&q=maria` para buscar por nome ou telefone) |
| `GET /api/stats` | Totais do menu: conversas com não lidas e números desconectados |
| `GET /api/conversations/ID/messages` | Mensagens de uma conversa |
| `POST /api/conversations/ID/messages` | Envia texto (`{"text": "..."}`) pelo mesmo número da conversa |
| `POST /api/conversations/ID/read` | Zera as não lidas no sistema (não manda tique azul) |
| `POST /api/conversations/ID/audio` | Envia áudio gravado (corpo = arquivo de áudio) como mensagem de voz |
| `POST /api/conversations/ID/media?fileName=...&caption=...` | Envia imagem ou documento (corpo = arquivo) |
| `GET /api/messages/ID/media` | Abre/baixa a mídia de uma mensagem |
| `POST /api/instances` | Cria um número novo (`{"nickname": "..."}`), já com webhook e opções |
| `PATCH /api/instances/ID` | Troca o apelido de um número |
| `POST /api/instances/ID/connect` | Conecta/reconecta um número (o QR Code chega em tempo real) |
| `POST /api/instances/NOME/import-history` | Reimporta o histórico dos últimos 14 dias de um número |

## Comandos úteis

| Comando | O que faz |
|---|---|
| `docker compose ps` | Mostra o que está rodando |
| `docker compose logs -f app` | Acompanha os logs do backend (`Ctrl + C` para sair) |
| `docker compose logs -f evolution` | Acompanha os logs da Evolution |
| `docker compose down` | Para tudo. **Os dados continuam salvos** |
| `docker compose up -d` | Sobe tudo de novo |
| `docker compose exec app node src/cli.ts listar-usuarios` | Lista os usuários |
| `docker compose exec backup sh /backup.sh agora` | Faz um backup na hora |

> ⚠️ **Nunca** rode `docker compose down -v`: o `-v` apaga os volumes, ou seja, o banco de dados, as mídias e as
> sessões dos números. Seria preciso escanear todos os QR Codes de novo.

## Problemas comuns

- **`defina WEBHOOK_TOKEN no arquivo .env`** (ou outra variável): falta essa linha no `.env` (passo 2).
- **`'Invoke-RestMethod' não é reconhecido`**: você está no Prompt de Comando (cmd). Abra o PowerShell.
- **`ports are not available` / `bind` na porta 3100**: outro programa usa a porta. Adicione `APP_PORT=3200` (ou outro
  número) no `.env` e rode `docker compose up -d` de novo. Na porta 8080 (Evolution), me avise.
- **Troquei a senha do Postgres no `.env` depois de já ter subido**: o banco continua com a senha antiga. Volte a
  senha antiga no `.env` ou me peça ajuda.

## Desenvolvimento

- **Backend** (`backend/`): Node 24 + TypeScript rodando o `.ts` direto (sem etapa de compilação), Express 5 e Prisma 7.
- **Frontend** (`frontend/`): React 19 + Vite, com ícones [Lucide](https://lucide.dev) e a fonte Inter (instalada
  junto, sem depender do Google Fonts). Na imagem Docker ele é compilado e servido pelo próprio backend. Os estilos
  ficam em `frontend/src/styles.css` (cores no começo do arquivo, com o modo escuro logo abaixo).

```powershell
cd backend
npm install
npm test          # testes das regras de mensagens (@lid, grupos, tipos, status)
npm run check     # verificação de tipos

cd ..\frontend
npm install
npm run dev       # tela em http://localhost:5173, usando o backend do Docker (porta 3100)
npm run check
```
