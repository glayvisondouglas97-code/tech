# Central de WhatsApp: plano

Status: **Fases 1 a 11 concluídas. Áudios do Chamar (Plano A) entregues, aguardando teste. Falta o backup e a subida para o VPS (o cliente avisa quando).**

> A partir da Fase 8, a Central virou parte do **Chamador de Leads** (Fastify + Kysely). As seções 3, 4.1 a 4.6
> descrevem como cada parte foi pensada; onde falam em Express, Prisma, `backend/`, `frontend/`, `node src/cli.ts` ou
> volume `media_data`, leia a seção 4.7, que diz o que mudou.

## 1. Versão da Evolution API

- **Fixar `evoapicloud/evolution-api:v2.3.7`** (última versão estável, de dez/2025).
- **Não usar a 2.4.0**: ainda é *release candidate* (rc2, de maio/2026) e passou a exigir ativação de licença
  num servidor da Evolution Foundation antes de aceitar chamadas.
- **Nunca usar a tag `latest`**: hoje ela aponta para a 2.4.0-rc1.
- O site de documentação estava bloqueado no ambiente de desenvolvimento. Por isso as informações abaixo foram
  conferidas direto no **código-fonte oficial da tag `2.3.7`**
  (github.com/evolution-foundation/evolution-api), que é a fonte mais confiável sobre o comportamento dessa versão.

## 2. Referência técnica da Evolution v2.3.7 (conferida no código)

Autenticação: header `apikey: <AUTHENTICATION_API_KEY>` (fica só no backend).

| Uso | Método e rota |
|---|---|
| Criar instância (número) | `POST /instance/create` |
| Gerar QR Code / reconectar | `GET /instance/connect/{instance}` |
| Status da conexão | `GET /instance/connectionState/{instance}` |
| Listar instâncias | `GET /instance/fetchInstances` |
| Reiniciar | `POST /instance/restart/{instance}` |
| Desconectar | `DELETE /instance/logout/{instance}` |
| Configurar webhook | `POST /webhook/set/{instance}` (body `{ webhook: { enabled, url, headers, byEvents, base64, events } }`) |
| Configurações (ignorar grupos etc.) | `POST /settings/set/{instance}` |
| Enviar texto | `POST /message/sendText/{instance}` (`number`, `text`) |
| Enviar imagem/documento | `POST /message/sendMedia/{instance}` (`number`, `mediatype`, `mimetype`, `caption`, `fileName`, `media`) |
| Enviar áudio de voz | `POST /message/sendWhatsAppAudio/{instance}` (`number`, `audio`, `delay`) |
| Buscar mensagens salvas (histórico) | `POST /chat/findMessages/{instance}` (`where.messageTimestamp.gte/lte`, `page`, `offset`) |
| Marcar como lida (só aceita telefone, não @lid) | `POST /chat/markMessageAsRead/{instance}` |
| Baixar mídia de uma mensagem | `POST /chat/getBase64FromMediaMessage/{instance}` |

Eventos de webhook usados:

| Evento | Quando chega |
|---|---|
| `MESSAGES_UPSERT` | Mensagem recebida **e** mensagem enviada **pelo celular** (`key.fromMe = true`) |
| `SEND_MESSAGE` | Mensagem enviada **pela API** (a Evolution usa `emitOwnEvents: false`, então essas não chegam como `MESSAGES_UPSERT`) |
| `MESSAGES_UPDATE` | Status: `SERVER_ACK`, `DELIVERY_ACK`, `READ`, `PLAYED`… (identificar pela `keyId`) |
| `CONNECTION_UPDATE` | `state`: `open`, `connecting`, `close`, `refused` |
| `QRCODE_UPDATED` | Novo QR Code (`data.qrcode.base64`) |
| `MESSAGES_SET` | Histórico enviado pelo WhatsApp ao conectar (só se decidirmos importar o histórico) |

Comportamentos importantes encontrados no código:

- **@lid**: no `MESSAGES_UPSERT`, se `key.remoteJid` termina em `@lid` e existe `key.remoteJidAlt`, a Evolution
  troca pelo número de telefone antes de enviar o webhook. Isso **não** acontece em `MESSAGES_SET` nem em
  `MESSAGES_UPDATE`. Por isso, o backend guarda os dois identificadores no contato (`phoneJid` e `lidJid`) e procura
  por qualquer um deles. Assim a mesma pessoa não vira duas conversas.
- **Áudio**: `sendWhatsAppAudio` já converte **qualquer formato** (inclusive WebM) para OGG/Opus com ffmpeg
  dentro da própria Evolution e envia como mensagem de voz (`ptt`). **O nosso backend não precisa de ffmpeg.**
  O campo `delay` mostra "gravando áudio…" antes de enviar, o que já atende a uma das ideias futuras.
- **Webhook**: aceita `headers` próprios por instância, o que permite um token secreto. Se o nosso backend
  falhar, a Evolution tenta de novo até 10 vezes, exceto quando responde 400/401/403/404/422. Por isso a
  deduplicação pelo ID da mensagem é obrigatória.
- **Status de mensagem** só é emitido se a Evolution achar a mensagem no banco dela, então o salvamento de
  mensagens da Evolution (`DATABASE_SAVE_DATA_NEW_MESSAGE=true`) precisa continuar ligado.
- **Mídia recebida**: com `webhook.base64 = true`, o arquivo chega junto no webhook (`message.base64`) e o
  backend grava direto no disco.
- **Grupos/status**: `groupsIgnore = true` nas configurações da instância, e o backend também descarta
  `@g.us`, `@broadcast` e `@newsletter` por segurança.

## 3. Arquitetura revisada

```
Navegador (React)
   │  HTTPS + WebSocket (Socket.io), login por cookie
   ▼
app (Node + TypeScript: API + Socket.io + serve o frontend pronto)
   │  rede interna do Docker          ▲ webhook com token secreto
   ▼                                  │
evolution (v2.3.7) ───────────────────┘
   │
postgres (1 container, 2 bancos: "evolution" e "central")     redis (cache da Evolution)
volume "midias" (arquivos de áudio/imagem/documento)
```

- Docker Compose: `evolution`, `postgres`, `redis` e `app`. No VPS entra também o `caddy`, que cuida do HTTPS
  automático.
- Em desenvolvimento, o frontend roda no Vite. Em produção, o próprio `app` serve o frontend já compilado, o que
  dispensa um container a mais.
- A porta da Evolution não fica exposta na internet: só a rede interna do Docker e `127.0.0.1`.

### Banco (Prisma)

- `User`: id, nome, email, senhaHash, criadoEm.
- `Instance` (número): id, nomeEvolution, apelido, telefone, status, atualizadoEm.
- `Contact` (lead): id, phoneJid (único), lidJid (único), nome (pushName).
- `Conversation`: id, instanceId + contactId (únicos juntos), ultimaMensagemEm, naoLidas, leadRespondeu.
- `Message`: id, waMessageId + instanceId (únicos juntos), conversationId, fromMe, tipo, texto, caminhoMidia,
  mimetype, status, enviadoEm.

O `Contact` fica separado da conversa porque o mesmo lead pode falar com vários números. Isso já prepara as
ideias futuras ("não contatar", aviso de lead em outro número, relatórios) sem precisar implementá-las agora.

Dependências previstas (mínimo):
- backend: express, prisma + @prisma/client + @prisma/adapter-pg + pg (o Prisma 7 exige o driver), socket.io. Os uploads de mídia chegam como o próprio corpo da requisição, então o multer não foi necessário. O TypeScript roda direto no Node 24, sem tsx nem etapa de build;
- frontend: react, react-dom, socket.io-client e vite;
- senhas com `crypto.scrypt`, nativo do Node, sem biblioteca.

## 4. Fases (ajustadas)

0. Planejamento (este documento).
1. Infra local: Compose com Evolution v2.3.7, Postgres e Redis; conectar 1 número pelo Manager da Evolution
   (`http://localhost:8080/manager`).
2. Backend: webhook com token, deduplicação e tratamento de @lid; salvar contatos, conversas e mensagens;
   importar o histórico dos últimos 14 dias; endpoint de envio de texto (que marca como lida ao responder).
3. Frontend: tela de conversas (ler e responder texto), com as abas "Responderam" e "Todas" e o filtro por número.
4. Tempo real com Socket.io.
5. Tela de números: criar instância, QR Code, status, apelido e reconexão (o backend configura webhook e
   settings automaticamente).
6. Mídia: gravar e enviar áudio (sem ffmpeg no backend), imagens e documentos, e ouvir e ver o que chegar.
7. Login (equipe com usuários e administradores), backup diário (`pg_dump` dos 2 bancos + mídias), Caddy com HTTPS e guia de deploy no VPS.
8. Juntar com o Chamador de Leads: um sistema só (visual, login, permissões, Docker e backup do Chamador), com
   Conversas e Números dentro dele. Tudo o que já funcionava continua funcionando.
9. Botão **Chamar** do lead pelo sistema: escolher o número, conferir se o lead tem WhatsApp, abrir a conversa com o
   texto vazio (para gravar áudio na hora), marcar o resultado sozinho e mostrar os dados do lead no chat. Sai o link
   `wa.me` e saem as mensagens prontas.
10. Ajustes, guia do VPS revisado e testes completos.
11. **Áudios do Chamar (Plano A)**: biblioteca de áudios (várias versões da mesma mensagem); ao escolher o
    número no botão Chamar, o sistema sorteia uma versão e a envia como mensagem de voz para o lead. Cada
    envio continua sendo uma ação do atendente (não há disparo automático em massa). Depois: backup e subida
    para o VPS.

## 4.1 Como a Fase 2 funciona

- **Ao iniciar**, o backend lê os números da Evolution, configura em cada um o webhook (`http://app:3000/webhook/evolution`
  com o header `x-webhook-token`) e as opções (ignorar grupos, não marcar como lida). Na primeira vez que vê um número,
  importa o histórico dos últimos 14 dias. Depois repete a leitura a cada 5 minutos.
- **Histórico**: vem do banco da própria Evolution (`/chat/findMessages`), que guarda o que o WhatsApp manda ao
  conectar. O evento `MESSAGES_SET` só dispara uma nova importação, 20s depois do último lote.
- **Mensagens**: `messages.upsert` (recebidas e enviadas pelo celular) e `send.message` (enviadas pelo sistema)
  passam por uma fila única, uma de cada vez. Isso evita contato ou conversa duplicados quando webhooks chegam juntos.
- **@lid**: o contato guarda `phoneJid` e `lidJid`. Se a mesma pessoa aparecer primeiro como dois contatos, eles são
  juntados, com as conversas, mensagens e não lidas somadas, assim que uma mensagem mostra os dois identificadores.
- **Envio**: confere se o número está conectado, envia pela Evolution, grava a mensagem e marca como lidas no
  WhatsApp as mensagens do lead que estavam sem resposta. A Evolution só aceita marcar como lida pelo telefone, então
  um contato que só tem @lid não recebe o tique azul.
- **Não lidas**: somam com mensagem do lead ao vivo, zeram quando respondemos (pelo sistema ou pelo celular) e zeram
  ao abrir a conversa no sistema. O histórico importado não soma não lidas.

## 4.2 Como a Fase 4 (tempo real) funciona

O backend avisa todos os navegadores abertos por Socket.io, logo depois de gravar no banco:

| Evento | Quando |
|---|---|
| `message:new` | mensagem nova (recebida, enviada pelo celular ou pelo sistema) |
| `message:updated` | status mudou (entregue, lida, ouvida) |
| `conversation:updated` | a conversa mudou (última mensagem, não lidas, nome do lead) |
| `conversation:removed` | duas conversas da mesma pessoa (telefone e @lid) foram juntadas |
| `instance:updated` | um número conectou ou caiu |
| `conversations:reload` | a importação de histórico terminou: a tela recarrega a lista |
| `instance:qrcode` | novo QR Code de um número (ou `null` quando expirou), para a tela de números |

Se a conexão cair, a tela mostra um aviso. O Socket.io reconecta sozinho e, ao voltar, a tela busca de novo a lista
e o chat aberto. Hoje todos recebem tudo. Quando houver permissão por número (ideia futura), basta enviar para "salas"
por número em `src/server/modules/whatsapp/realtime.ts`.

## 4.3 Como a Fase 5 (tela de números) funciona

- **Adicionar**: o backend escolhe o próximo nome livre (`whatsapp-NN`) e cria a instância na Evolution
  (`POST /instance/create`), já com webhook e opções no mesmo pedido. Assim nenhum evento se perde antes da configuração.
- **Conectar/Reconectar**: `GET /instance/connect/{instance}`. Se a sessão ainda vale, o número volta sem QR. Senão, a
  Evolution gera QR Codes (troca a cada ~20s) e avisa por `QRCODE_UPDATED`, que o backend repassa para a tela. Depois
  de 30 QR Codes sem leitura (`QRCODE_LIMIT`), a tela mostra "expirou" e oferece gerar outro.
- **Apelido**: fica só no nosso banco e aparece na hora em todas as telas.
- Não há botão de remover ou desconectar número no MVP. Se precisar, dá para fazer pelo painel da Evolution.

## 4.4 Como a Fase 6 (mídia) funciona

- **Arquivos no volume `media_data`** (`/app/media/<número>/<mensagem>.<ext>`). O banco guarda só o caminho e o tipo.
- **Recebidas ao vivo** (`messages.upsert`): o backend baixa a mídia logo, em segundo plano, pela Evolution
  (`POST /chat/getBase64FromMediaMessage`, que descriptografa o arquivo do WhatsApp).
- **Histórico**: a mídia só é baixada quando alguém abre (decisão da Fase 0).
- **Áudio gravado**: o navegador grava em WebM/Opus (Chrome/Edge) e o backend envia para
  `POST /message/sendWhatsAppAudio`. A Evolution converte para OGG/Opus com o ffmpeg dela e manda como mensagem de
  voz. Conferido: o ffmpeg da imagem v2.3.7 converte WebM → OGG/Opus mono 48 kHz. O nosso backend não tem ffmpeg.
- **Imagem/documento**: `POST /message/sendMedia`. JPG/PNG/WebP vão como imagem (a Evolution converte para JPEG); o
  resto vai como documento, com o nome do arquivo. Limite de 25 MB por arquivo.
- **Segurança**: só imagem, áudio e vídeo abrem dentro da página. Qualquer outro tipo (ex.: HTML ou SVG enviado por um
  lead) é sempre baixado, com `nosniff` e `sandbox`, para nunca rodar dentro do sistema.

## 4.5 Como a Fase 7 (login, backup e VPS) funciona

- **Login**: e-mail + senha. As senhas são guardadas com scrypt (nativo do Node). A sessão fica no banco (tabela
  `Session`) e no navegador só vai um código aleatório, num cookie `HttpOnly` + `SameSite=Lax` (+ `Secure` no HTTPS).
  "Sair", desativar ou redefinir a senha encerra a sessão na hora, inclusive o tempo real.
- Todas as rotas `/api` e o Socket.io exigem login. O webhook continua protegido só pelo token (rede interna).
- **Proteções**:
  - pedidos que alteram dados só são aceitos do próprio site (conferência do `Origin`);
  - 10 senhas erradas por e-mail (ou 30 por IP) bloqueiam o login por 15 minutos;
  - a mensagem de erro de login é a mesma para e-mail inexistente e para senha errada;
  - cabeçalhos de segurança (`X-Frame-Options`, `nosniff`, HSTS no Caddy).
- **Usuários**: o primeiro administrador é criado pelo terminal (`node src/cli.ts criar-admin`). Administradores
  criam o acesso da equipe na tela **Usuários** (senha provisória mostrada uma vez), redefinem senhas e desativam
  acessos. Cada mensagem enviada pelo sistema guarda quem enviou (`sentByUserId`), o que prepara os relatórios e as
  permissões por número (ideias futuras).
- **Backup**: serviço `backup` (imagem do Postgres) que todo dia às 3h (Brasília) gera `pg_dump` dos bancos `evolution`
  e `central` e um `.tar.gz` das mídias em `./backups`, mantendo 7 dias. A restauração foi testada.
- **VPS**: `docker-compose.prod.yml` acrescenta o **Caddy** (HTTPS automático com Let's Encrypt) na frente do `app`,
  bloqueando `/webhook` para a internet. Passo a passo em `docs/DEPLOY.md`.

## 4.6 Design (depois da Fase 7)

- Visual refeito, no estilo de um SaaS: menu lateral com ícones e selos (não lidas e números desconectados),
  busca por nome ou telefone, filtros por número em botões, avatares com iniciais, bolhas agrupadas, player de áudio
  próprio (com velocidade), imagem em tela cheia, janelas e avisos rápidos, e modo escuro automático.
- **Celular**: uma tela por vez, barra de menu embaixo, conversa em tela cheia, botão voltar do celular fecha a
  conversa (a tela fica no endereço: `#12`, `#numeros`), janelas que sobem de baixo e ícone para a tela inicial
  (manifesto de aplicativo).
- **Desempenho**: só as linhas que mudaram são redesenhadas; linhas fora da tela não custam desenho; arquivos do site
  com cache de 1 ano (o nome muda a cada versão); fonte e ícones instalados junto (sem depender de sites de fora).
- Dependências novas só no frontend: `lucide-react` (ícones) e `@fontsource-variable/inter` (fonte).

## 4.7 Como a Fase 8 (junção com o Chamador) funciona

- **Um sistema só**: o Chamador de Leads ficou na raiz do repositório e ganhou o WhatsApp da Central, reescrito para o
  mesmo padrão dele: Fastify, Kysely (migração `0003_whatsapp`: `wa_instances`, `wa_contacts`, `wa_conversations`,
  `wa_messages`), zod, testes com Vitest. As pastas `backend/`, `frontend/` e `leads/` saíram.
- **Login e permissões do Chamador**: Argon2, sessão no banco com cookie `HttpOnly` (`__Host-` no HTTPS) e token CSRF
  em todo pedido que altera dados. Todos os papéis veem e respondem todas as conversas; só dono e administrador mexem
  nos números (`manageNumbers`). Cada mensagem enviada guarda quem enviou (`sent_by`).
- **Telas**: **Conversas** e **Números** entraram no menu do Chamador, com o visual dele (cores, fonte Poppins, tema
  claro/escuro no menu da conta) e selos de não lidas e de números desconectados. No celular, **Conversas** está na
  barra de baixo.
- **O que continua igual**: webhook com token pela rede interna, fila única e deduplicação, @lid, histórico de 14 dias,
  tique azul só ao responder, tempo real por Socket.io (agora com o cookie do Chamador), áudio sem ffmpeg, mídias no
  disco, upload de até 25 MB.
- **Docker**: o mesmo `docker-compose.yml` (Evolution, Postgres, Redis, app, backup e, no VPS, Caddy). O `app` agora é
  o Chamador compilado (`dist/`), as mídias ficam no volume **`midias`** e o dono é criado com
  `node dist/server/criar-admin.js --nome "..." --email ...`.
- **Dados antigos da Central** (usuários, conversas do banco `central` da Fase 7) não passam para o sistema novo: as
  tabelas antigas ficam paradas no banco, sem uso. Os números continuam conectados na Evolution e o histórico dos
  últimos 14 dias é importado de novo sozinho.
- Saiu também o webhook da WhatsApp Business Cloud API que o Chamador tinha (desligado), porque o WhatsApp agora é pela
  Evolution.

## 4.8 Como a Fase 9 (Chamar pelo sistema) funciona

- **Botão Chamar no WhatsApp** (fila, modo foco com a tecla **W**, retornos, Já chamados e ficha do lead): abre a janela
  **Por qual número?** com todos os números (desconectados apagados, atalhos 1 a 9, o último usado em foco e o selo
  "Já conversou" no número em que já existe conversa com o lead).
- Ao escolher, o backend (`POST /api/leads/:id/conversation`) confere se o número está conectado, pergunta à Evolution se
  o telefone do lead tem WhatsApp (`POST /chat/whatsappNumbers/{instância}`, conferida no código da v2.3.7), cria ou
  reaproveita o contato e a conversa (pela fila única, como os webhooks) e liga a conversa ao lead. Sem WhatsApp, a
  janela oferece **Marcar como Sem WhatsApp**.
- A tela vai para `/conversas/:id` com a caixa de texto vazia (aba **Todas**). A faixa do lead mostra situação, sócio e
  lista, com **Ver lead** e **Voltar para a fila**.
- **Marcação automática**: a primeira mensagem enviada pelo sistema deixa o lead "Chamado · Mensagem enviada" (se ele está
  na fila de quem enviou); a resposta do lead passa para "Respondeu". Tudo fica no histórico do lead.
- **Saíram** o link `wa.me`, as mensagens prontas (tela, rotas e tabela) e a rota `POST /api/leads/:id/whatsapp`.

## 4.9 Números por responsável (depois da Fase 9)

- Todo usuário cadastra e conecta os próprios números em **Números** e fica como responsável por eles.
- O atendente vê só as conversas dos números dele (lista, chat, contadores, "Chamar" e tempo real). Dono, administrador
  e supervisor veem todas.
- Dono e administrador conectam, renomeiam e trocam o responsável de qualquer número (campo **Responsável** no cartão).
  Números cadastrados antes disso ficam sem responsável até a gestão escolher um.
- **Celular:** a barra de atalhos de baixo fica sempre fixa. A página não rola; só a área do conteúdo rola por dentro, então
  o navegador não esconde a barra de endereço no meio da rolagem. A barra some só dentro de uma conversa do WhatsApp.

## 4.10 Excluir mensagens, conversas e números

- **Mensagens:** no chat, **⋯ → Selecionar mensagens** → **Apagar para mim** (só do sistema) ou **Apagar para todos**
  (também do WhatsApp do contato; só enviadas pelo número nas últimas 48 horas).
- **Conversas:** seleção na lista (marcar várias ou todas) ou **⋯ → Excluir conversa** no chat. Somem do sistema; no
  celular continuam.
- **Números:** **⋯ → Excluir número** no cartão, confirmando com EXCLUIR: desconecta, tira da Evolution e apaga as
  conversas dele.
- Quem pode: o responsável pelo número e o dono/administrador. O que foi apagado não volta com a reimportação de histórico.

## 4.11 Áudios do Chamar (Plano A)

- **Biblioteca de áudios** (tela **Áudios**, só dono e administrador): grava-se pelo microfone ou envia-se um
  arquivo, com um nome. Guardam-se várias versões da mesma mensagem, de durações diferentes. Cada áudio pode ser
  ligado/desligado (só os ligados entram no sorteio) e excluído. O arquivo fica na pasta de mídias
  (`audios/<id>.<ext>`), como as outras mídias.
- **Envio na hora do Chamar**: no botão **Chamar no WhatsApp**, ao escolher o número, o servidor confere se o lead
  tem WhatsApp, abre a conversa e **sorteia um áudio ativo**, enviando-o como mensagem de voz. O sorteio evita
  repetir o último áudio que aquele número mandou, para variar a mensagem entre os clientes. O lead é marcado
  sozinho como "Mensagem enviada", como em qualquer envio pela conversa.
- **Sem áudio salvo**: a conversa abre mesmo assim (vazia, para gravar na hora) e um aviso lembra de salvar um áudio.
- **Cada envio é uma ação do atendente** (um clique por lead). Não há disparo automático em massa, nem rodízio
  automático entre vários números, nem qualquer recurso para esconder a origem dos números ou driblar o WhatsApp.
  Isso é decisão de projeto (ver decisão 10), não limitação técnica.
- **Rota**: `POST /api/leads/:id/conversation` com `{ instanceId, sendAudio: true }` devolve, além da conversa, o
  áudio sorteado (`audio: { sent, label, reason? }`). As telas usam `GET/POST/PATCH /api/audios…`.

## 5. Decisões tomadas

1. **Histórico ao conectar um número**: importar o histórico recente que o WhatsApp envia ao conectar, só de
   conversas individuais e só dos **últimos 14 dias**. As mídias antigas são baixadas quando alguém clicar.
2. **Tique azul (lida no WhatsApp)**: só marcar como lida no WhatsApp **quando a conversa for respondida pelo
   sistema**, nunca só por abrir. A instância fica com `readMessages = false`. O contador de não lidas *do
   sistema* zera ao abrir a conversa.
3. **Lista de conversas**: duas abas, **Responderam** e **Todas**, mais o filtro por número e a busca.
4. **Mensagem inicial**: até a Fase 8 sai pelo celular. Na Fase 9, o botão **Chamar** do lead abre a conversa no
   sistema, pelo número escolhido.
5. **Usuários**: você e a equipe, cada um com login próprio e todos vendo todos os números (por enquanto).
6. **Ambiente local**: Windows com Docker Desktop, com instruções em PowerShell.
7. **Produção**: domínio e VPS já disponíveis (Fase 7).
8. **Junção com o Chamador** (Fase 8): visual do Chamador; todos veem todas as conversas; resultado do lead marcado
   sozinho (1ª mensagem enviada pelo sistema → "Mensagem enviada"; resposta do lead → "Respondeu"); sem mensagens
   prontas e sem link `wa.me` (Fase 9).
9. **Números por responsável**: o atendente vê só as conversas dos números dele e pode cadastrar os próprios; dono,
   administrador e supervisor veem todas as conversas; dono e administrador escolhem o responsável de cada número.
10. **Áudios do Chamar — Plano A, e não o disparo automático (Plano B)**: o cliente estudou dois caminhos. O Plano B
    (campanha automática que dispara áudios em massa para as listas, com rodízio entre vários números e intervalos
    para não tomar banimento) foi **descartado**: é envio em massa para quem não pediu, por uma via não oficial
    (Evolution/Baileys), montado para driblar o sistema anti-spam do WhatsApp. Não construímos isso, nem proxy ou
    qualquer disfarce da origem dos números. O escolhido foi o **Plano A**: o atendente clica em Chamar, escolhe o
    número e o sistema envia **um** áudio sorteado da biblioteca para aquele lead. Cada envio é um clique de uma
    pessoa. Para volume grande e sem risco de banimento, o caminho é a API oficial do WhatsApp Business (Meta), que
    fica como possibilidade futura.
