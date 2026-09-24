# Central de WhatsApp: plano

Status: **Fases 1 a 5 concluídas e testadas pelo usuário. Fase 6 (mídia) entregue, aguardando teste.**

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
7. Login, backup (`pg_dump` dos 2 bancos e do volume de mídias), Caddy com HTTPS e deploy no VPS.

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
por número em `backend/src/realtime.ts`.

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

## 5. Decisões tomadas

1. **Histórico ao conectar um número**: importar o histórico recente que o WhatsApp envia ao conectar, só de
   conversas individuais e só dos **últimos 14 dias**. As mídias antigas são baixadas quando alguém clicar.
2. **Tique azul (lida no WhatsApp)**: só marcar como lida no WhatsApp **quando a conversa for respondida pelo
   sistema**, nunca só por abrir. A instância fica com `readMessages = false`. O contador de não lidas *do
   sistema* zera ao abrir a conversa.
3. **Lista de conversas**: duas abas, **Responderam** e **Todas**, mais o filtro por número.
4. **A mensagem inicial continua saindo pelo celular**: o MVP não terá o botão "nova conversa".
5. **Usuários**: você e a equipe, cada um com login próprio e todos vendo todos os números (por enquanto).
6. **Ambiente local**: Windows com Docker Desktop, com instruções em PowerShell.
7. **Produção**: domínio e VPS já disponíveis (Fase 7).
