# Decisões técnicas

## Stack

| Parte | Escolha | Por quê |
|---|---|---|
| Linguagem | TypeScript (servidor e interface) | Tipos compartilhados entre API e tela (`src/shared`), menos erro bobo. |
| Servidor | Node.js 22 + Fastify 5 | Rápido, maduro, `inject()` facilita testar a API inteira sem rede. |
| Banco | PostgreSQL + Kysely (SQL tipado) | Transações, `FOR UPDATE SKIP LOCKED`, índices parciais e `pg_trgm` para busca. Kysely deixa escrever o SQL necessário sem ORM escondendo o que acontece. |
| Migrações | Kysely Migrator, lista fixa em `src/server/db/migrate.ts` | Rodam sozinhas ao iniciar (`MIGRATE_ON_START`), ideal para hospedagem sem terminal. |
| Interface | React 19 + Vite + TanStack Query + React Router | React escapa todo texto por padrão (resolve o risco de XSS do protótipo). Query cuida de cache, atualização periódica e "desfazer" otimista. |
| Planilhas | SheetJS 0.20.3 (do CDN oficial da SheetJS; a versão do npm é antiga e vulnerável) | Lê .xlsx, .xls e .ods. CSV com leitor próprio (separador e codificação). |
| Telefones | libphonenumber-js (metadados completos) | Validação real por faixa de numeração, tipo (celular/fixo), E.164. |
| Senhas | Argon2id (`@node-rs/argon2`), parâmetros mínimos da OWASP | Hash forte e rápido de instalar (binário pronto). |
| Testes | Vitest (unitário + integração com Postgres real) e Playwright (ponta a ponta) | |
| Lint/format | Biome | Uma ferramenta só, rápida. |
| WhatsApp | Evolution API v2.3.7 (versão fixa) + Socket.io | Vários números conectados por QR Code; a Evolution avisa o sistema por webhook e o Socket.io leva as mensagens às telas na hora. |
| Hospedagem | VPS com Docker Compose + Caddy | Tudo junto (sistema, Evolution, Postgres, Redis, backup); o Caddy cuida do HTTPS. Passo a passo em [DEPLOY.md](DEPLOY.md). |

**Descartadas:** Next.js (mais peças do que o necessário para uma API + SPA), Prisma (atrapalha SQL específico como `SKIP LOCKED`), Firebase/Supabase como backend (regras de negócio voltariam para o cliente ou para funções espalhadas), fila externa (Redis/pg-boss) para importação: um processo só dá conta; ver "Importação".

## Modelo de dados

- `users` (papel: admin, supervisor, atendente; `active`), `sessions` (hash do token + token CSRF), `password_tokens` (convites e redefinições, só o hash).
- `lists` (lista importada, colunas extras, arquivada ou não) → `leads` (um registro por lead).
- `leads`: nome, telefone E.164, outros telefones, colunas extras (`jsonb`), **estado atual** (`status` pendente/chamado/bloqueado, `assigned_to`, `called_by`, `called_at`, `result`, `note`, `callback_at`, `version`).
- `lead_events`: **histórico só de acréscimo** (importado, pegou, abriu WhatsApp, chamado, resultado, observação, desfeito, devolvido, atribuído, expirado, retorno, bloqueado…), com quem fez e quando. Desfazer ou chamar de novo gera evento novo; nada é apagado.
- `imports` + `import_rejections`: rascunho da importação e linhas recusadas com motivo.
- `blocked_phones` (não contatar), `settings`, `audit_log` (acessos e ações sensíveis). As mensagens prontas (`message_templates`) saíram na migração `0004`: o primeiro contato agora é feito pelo chat do sistema.
- WhatsApp (migrações `0003` a `0007`): `wa_instances` (números, com `owner_id` do responsável), `wa_contacts` (telefone e @lid da mesma pessoa), `wa_conversations` (uma por número + contato, com não lidas, "respondeu" e o `lead_id` do lead chamado por ela; `last_message_at` vazio enquanto não há mensagens), `wa_messages` (únicas por número + ID do WhatsApp; `sent_by` guarda quem da equipe enviou), `wa_deleted_messages` (IDs apagados, para não voltarem na reimportação) e `wa_audios` (biblioteca de áudios do Chamar, sorteados no envio). Os arquivos de mídia ficam no disco (volume `midias`), o banco guarda só o caminho.
- **Áudios do Chamar (Plano A)** (`wa_audios`, migração `0007`): o dono/administrador salva várias versões da mensagem; ao chamar um lead, o servidor sorteia uma ativa e a envia como mensagem de voz (evitando repetir a última daquele número). **Descartado o disparo automático em massa (Plano B)**: envio não solicitado em grande volume por via não oficial e montado para driblar o anti-spam do WhatsApp — fora do que construímos. Para volume, o caminho é a API oficial do WhatsApp Business (Meta).

Índices parciais para cada tela: fila livre (`status = 'pendente' AND assigned_to IS NULL`), fila do atendente, já chamados por data e por atendente, retornos, telefone e busca por nome (trigram). Teste com 100 mil leads em `tests/integration/scale.test.ts`.

## Como "Pegar leads" evita duplicidade

Em `src/server/modules/leads/service.ts` (`pullLeads`), numa transação:

```sql
WITH picked AS (
  SELECT l.id FROM leads l JOIN lists li ON li.id = l.list_id
  WHERE l.status = 'pendente' AND l.assigned_to IS NULL AND li.archived_at IS NULL
  ORDER BY l.id LIMIT $n
  FOR UPDATE OF l SKIP LOCKED
)
UPDATE leads SET assigned_to = $eu, ... FROM picked
WHERE leads.id = picked.id AND leads.status = 'pendente' AND leads.assigned_to IS NULL
```

Cada transação trava as linhas que escolheu; quem chega ao mesmo tempo pula as travadas e pega as seguintes. Se uma linha foi liberada no meio do caminho, o Postgres reavalia o `WHERE` sobre a versão nova e ela é descartada. Um lock por atendente (`pg_advisory_xact_lock`) evita que o clique duplo ultrapasse o limite de fila. Testes: `tests/integration/pull-concurrency.test.ts` (2 atendentes × 25 rodadas via HTTP e 30 atendentes em paralelo com 30 conexões) e o teste ponta a ponta.

Todas as outras ações (marcar, desfazer, devolver, editar) travam o lead com `SELECT … FOR UPDATE` e conferem o estado; edição de resultado/observação exige a `version` atual, então uma mudança nunca apaga a de outra pessoa sem aviso (409).

## Permissões

Tabela única em `src/shared/roles.ts`, aplicada no servidor em toda rota (`requirePermission`) e em toda consulta de leads (`visibleTo`: o atendente só enxerga leads pendentes na fila dele e os que ele chamou). Lead de outro atendente responde **404** (não revela que existe). `tests/integration/permissions.test.ts` percorre todas as rotas de gestão como atendente.

Hierarquia: dono > administrador > supervisor > atendente. `manageableRoles()` diz quem cada papel pode criar/editar (administrador só mexe em supervisor e atendente); sempre sobra pelo menos um dono ativo. A migração `0002` promove o primeiro administrador existente a dono. Linhas de auditoria de donos ficam ocultas para quem não é dono.

## Auditoria

Duas fontes: `lead_events` (tudo o que acontece com cada lead) e `audit_log` (acessos, gestão, `pediu_leads` com quantidade pedida/recebida/DDD, e `acesso_negado`, gravado em todo 403 de usuário logado). A tela **Auditoria** junta as duas com `UNION ALL`, paginada, com filtro por pessoa e categoria. O limite diário conta os eventos `pegou` desde a meia-noite de São Paulo, dentro da mesma trava por usuário do "Pegar leads", então dois cliques simultâneos não furam o limite. O DDD é uma coluna gerada a partir do telefone E.164 (`leads.ddd`), com índice para os leads livres.

## Importação

1. Upload → o arquivo fica no banco como rascunho e é lido numa **worker thread** (no build de produção), sem travar o servidor.
2. Prévia: normaliza os telefones (cedendo a vez ao Node a cada 1.000 linhas), consulta base e "não contatar" em lote, devolve contagens e exemplos.
3. Confirmar: uma requisição só consegue mudar o estado de `rascunho` para `processando` (clique duplo não duplica). A gravação roda em segundo plano, **numa transação única** com lock de importação: ou entra tudo (lista, leads, eventos, rejeitadas), ou nada. Se o servidor reiniciar no meio, nada fica gravado e a importação vira "falhou" para tentar de novo.

## WhatsApp (Evolution API)

O código fica em `src/server/modules/whatsapp` e `src/server/routes/whatsapp.ts`; o plano completo, com as rotas da Evolution conferidas no código-fonte da v2.3.7, está em [PLANO.md](PLANO.md).

- **Segurança:** a chave da Evolution fica só no backend. A Evolution entrega os webhooks pela rede interna do Docker (`http://app:3000/webhook/evolution`) com um token secreto (`x-webhook-token`, comparado em tempo constante); no VPS, o Caddy bloqueia `/webhook` para a internet. O Socket.io exige o mesmo cookie de login do site e desconecta na hora quem sai, é desativado ou tem a senha redefinida.
- **Mensagens:** os webhooks passam por uma fila única (um de cada vez) e são deduplicados pelo ID do WhatsApp, porque a Evolution reenvia quando falha. Telefone e @lid da mesma pessoa viram um contato só. Grupos, status e canais são ignorados.
- **Tique azul:** só quando alguém responde pelo sistema (a instância fica com "marcar como lida" desligado). Abrir a conversa zera só as não lidas do sistema.
- **Números por responsável** (migração `0005`, `wa_instances.owner_id`): quem cadastra o número fica como responsável. `seeAllNumbers` (dono, administrador e supervisor) vê as conversas de todos os números; o atendente vê só as dos números dele. `manageNumbers` (dono e administrador) conecta, renomeia e troca o responsável de qualquer número; cada pessoa cuida dos próprios. As regras ficam em `src/server/modules/whatsapp/access.ts` e valem em toda rota (lista, conversa, mensagens, mídia, envio, contadores e o "Chamar"): conversa de número alheio responde 404. Tudo fica na Auditoria (`criou_numero`, `trocou_responsavel_numero`…).
- **Exclusões** (`src/server/modules/whatsapp/deletion.ts`): quem cuida do número (responsável ou dono/administrador) apaga mensagens, conversas e o próprio número; o supervisor só vê. "Apagar para todos" usa `DELETE /chat/deleteMessageForEveryone/{instância}` (conferido na v2.3.7; a Evolution também tira a mensagem do banco dela) e só vale para mensagens enviadas pelo número nas últimas 48 horas. "Excluir número" usa `DELETE /instance/delete/{instância}` (desconecta antes, se preciso); se a Evolution já não tem o número (404), a exclusão segue no sistema. O ID de cada mensagem apagada fica em `wa_deleted_messages` (migração `0006`): a importação de histórico e os webhooks repetidos não trazem nada de volta. Avisos atrasados de um número recém-excluído são ignorados e o nome dele não é reaproveitado por 15 minutos. Contatos sem nenhuma conversa saem junto. Tudo vai para a Auditoria (`apagou_mensagens`, `excluiu_conversas`, `excluiu_numero`) e para o tempo real (`message:deleted`, `conversation:deleted`, `instance:removed`).
- **Tempo real filtrado:** cada navegador entra em salas do Socket.io (`numeros:todos` para quem vê todos, `numeros:gestao` para dono e administrador, `usuario:<id>` para cada pessoa). Mensagens, conversas e status vão para `numeros:todos` + o responsável do número; o QR Code vai só para `numeros:gestao` + o responsável (com o QR Code, qualquer um conectaria o número). Trocar o responsável avisa o antigo (o número some da tela) e o novo; mudar o papel de alguém troca as salas na hora.
- **Sem Evolution configurada** (`EVOLUTION_URL` vazio, como no `npm run dev`), o sistema funciona normalmente e só esconde Conversas e Números.
- **LGPD:** excluir um titular apaga também as conversas, mensagens e arquivos de WhatsApp dele; a exportação inclui as mensagens.

## Outras decisões

- **"Hoje"** é sempre calculado no SQL com `America/Sao_Paulo`; a interface também formata datas nesse fuso.
- **Expiração:** leads que o atendente **pegou** e nem abriu no WhatsApp voltam para a fila livre depois de X horas (padrão 48, configurável, 0 desliga). Leads divididos na importação ou passados pelo gestor não expiram sozinhos. Tarefas periódicas usam lock do Postgres para rodar em um servidor só.
- **"Sem WhatsApp"** não conta como chamado nas métricas; conversão = fechados ÷ chamados.
- **Atendente não vê chamados dos colegas** (privacidade/LGPD); supervisor e gestor veem tudo.
- **Chamar pelo sistema (sem `wa.me`):** o botão do lead pergunta o número, confere na Evolution se o telefone tem WhatsApp (`POST /chat/whatsappNumbers/{instância}`, que já acerta o 9º dígito dos celulares brasileiros e devolve o jid certo) e abre a conversa ligada ao lead (`wa_conversations.lead_id`). A conversa pode existir sem mensagens; ela só entra na lista depois da primeira.
- **Resultado automático:** a primeira mensagem enviada pelo sistema marca o lead como chamado ("Mensagem enviada") só se ele está na fila de quem enviou, com o evento `chamado` (`automatico: true` e o número usado). Quando o lead responde (mensagem ao vivo, não histórico), "Mensagem enviada" ou "Cliente não respondeu" viram "Respondeu", com os eventos `whatsapp_resposta` e `resultado` (`automatico: true`). Outros resultados (interessado, fechou…) não são mexidos.
- **Abrir a conversa conta como "abriu o WhatsApp"** (`whatsapp_opened_at` e evento `abriu_whatsapp`): continua valendo o aviso de muitas conversas por hora e a regra de devolução de leads parados.
- **Convite por link** (sem e-mail): o gestor manda pelo WhatsApp; o token fica depois do `#` e não aparece em logs. Trocar para e-mail exige só um provedor SMTP (ponto de extensão em `createPasswordLink`).
- **Primeiro administrador:** tela de primeiro acesso protegida por `SETUP_TOKEN` (para hospedagens sem terminal) ou comando `criar-admin`.
- **Limites de taxa em memória** (login por IP e por e-mail, requisições por usuário): suficiente para um servidor. Com vários servidores, trocar por Redis.

## O que ficou para depois

- Envio de e-mail (convites e redefinição de senha) — hoje é por link copiado.
- Notificação no celular (push) para retornos agendados; hoje o retorno aparece no topo da fila.
- Dois fatores de autenticação (2FA) para administradores.
- Rate limit compartilhado (Redis) se houver mais de um servidor.
