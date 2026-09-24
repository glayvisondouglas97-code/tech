# WhatsApp Business Cloud API (opcional, desligado)

Por padrão o sistema usa **click-to-chat**: o atendente envia a mensagem manualmente. Não há disparo em massa (risco de bloqueio do número e violação das políticas da Meta).

## O que já existe
- `GET/POST /api/webhooks/whatsapp` (`src/server/routes/webhooks.ts`, `src/server/modules/whatsapp/webhook.ts`), ativo só com `WHATSAPP_CLOUD_ENABLED=true`.
- Verificação do webhook (`hub.verify_token`) e da assinatura `X-Hub-Signature-256` com o App Secret.
- Resposta do cliente vira evento "Respondeu pelo WhatsApp" no histórico do lead e muda "Mensagem enviada" para "Respondeu". Status (enviada, entregue, lida, falhou) viram eventos.

## Como ligar
1. Crie um app na Meta (developers.facebook.com), adicione o produto WhatsApp e um número comercial.
2. Defina no servidor: `WHATSAPP_CLOUD_ENABLED=true`, `WHATSAPP_VERIFY_TOKEN` (qualquer texto longo) e `WHATSAPP_APP_SECRET` (App Secret do app).
3. Na Meta, configure o webhook com a URL `https://SEU-DOMINIO/api/webhooks/whatsapp`, o mesmo verify token, e assine os campos `messages`.

Observação: o webhook só vê conversas do número conectado à Cloud API. Se os atendentes usam números pessoais ou o app WhatsApp Business em outro número, as respostas não chegam aqui.

## Próximo passo (não implementado)
Envio pela API exige **modelos de mensagem aprovados** pela Meta e é cobrado por conversa. O caminho: criar um `WhatsAppProvider` com `sendTemplate(phone, template, variáveis)` chamado a partir da ação "Chamar", registrar o `message_id` no evento e casar os status do webhook por esse id.
