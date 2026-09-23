# Central de WhatsApp: plano (Fase 0)

Status: **aguardando respostas às perguntas da seção 5** antes de iniciar a Fase 1.

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
| Marcar como lida | `POST /chat/markMessageAsRead/{instance}` |
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
- backend: express, socket.io, prisma/@prisma/client e multer (upload);
- frontend: react, react-dom, socket.io-client e vite;
- senhas com `crypto.scrypt`, nativo do Node, sem biblioteca.

## 4. Fases (ajustadas)

0. Planejamento (este documento).
1. Infra local: Compose com Evolution v2.3.7, Postgres e Redis; conectar 1 número pelo Manager da Evolution
   (`http://localhost:8080/manager`).
2. Backend: webhook com token, deduplicação e tratamento de @lid; salvar contatos, conversas e mensagens;
   endpoint de envio de texto.
3. Frontend: tela de conversas (ler e responder texto), com filtro por número e filtro "responderam".
4. Tempo real com Socket.io.
5. Tela de números: criar instância, QR Code, status, apelido e reconexão (o backend configura webhook e
   settings automaticamente).
6. Mídia: gravar e enviar áudio (sem ffmpeg no backend), imagens e documentos, e ouvir e ver o que chegar.
7. Login, backup (`pg_dump` dos 2 bancos e do volume de mídias), Caddy com HTTPS e deploy no VPS.

## 5. Perguntas em aberto

Ver a resposta da Fase 0 na conversa. As decisões serão registradas aqui.
