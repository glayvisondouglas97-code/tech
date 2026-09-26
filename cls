[33mcommit 1c22ff40ff95c09bed775335fb6890b319358ce2[m[33m ([m[1;36mHEAD[m[33m -> [m[1;32mclaude/whatsapp-evolution-central-dzt5ar[m[33m, [m[1;31morigin/claude/whatsapp-evolution-central-dzt5ar[m[33m, [m[1;31morigin/HEAD[m[33m)[m
Author: Claude <noreply@anthropic.com>
Date:   Thu Sep 24 01:08:45 2026 +0000

    Backend na porta 3100 do computador (configurável por APP_PORT)
    
    A porta 3000 já estava em uso na máquina do usuário. A porta interna do
    container continua 3000, então o webhook da Evolution não muda.
    
    Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
    Claude-Session: https://claude.ai/code/session_011NhcAGM31KhBJ3LtrQWiiU

[33mcommit ebc50969497ee8dac7a8a7fa074fa9c435ea38a9[m
Author: Claude <noreply@anthropic.com>
Date:   Wed Sep 23 22:50:08 2026 +0000

    Fase 2: backend que recebe webhooks, grava conversas e envia texto
    
    - Node 24 + TypeScript rodando direto (sem build), Express 5 e Prisma 7
    - Tabelas: números, contatos (telefone + @lid), conversas e mensagens
    - Webhook protegido por token; deduplicação pelo ID da mensagem; fila única
      para evitar contato ou conversa duplicados com webhooks simultâneos
    - @lid: telefone e @lid da mesma pessoa viram um contato só, e contatos
      duplicados são juntados com suas conversas
    - Ignora grupos, status e canais; status de entrega nunca retrocede
    - Importa os últimos 14 dias de histórico a partir do banco da Evolution
    - Configura webhook e opções de cada número automaticamente
    - Envio de texto pelo mesmo número; marca como lidas no WhatsApp só as
      mensagens do lead que foram respondidas
    - Serviço app no docker-compose e README da Fase 2
    
    Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
    Claude-Session: https://claude.ai/code/session_011NhcAGM31KhBJ3LtrQWiiU

[33mcommit 12d27754ebd8c3717f217863d846392ac1958254[m
Author: Claude <noreply@anthropic.com>
Date:   Wed Sep 23 21:54:33 2026 +0000

    Fase 1: Docker Compose com Evolution v2.3.7, Postgres e Redis
    
    - Evolution API fixada na v2.3.7 (a 2.4.0 exige ativação de licença)
    - Um Postgres com dois bancos: evolution e central
    - Evolution acessível só em 127.0.0.1, sem webhook global e sem telemetria
    - README com o passo a passo para Windows (PowerShell)
    - Decisões da Fase 0 registradas em docs/PLANO.md
    
    Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
    Claude-Session: https://claude.ai/code/session_011NhcAGM31KhBJ3LtrQWiiU

[33mcommit 9f0f77b3f12991ae1bba4bf7fc092ab8e984527a[m
Author: Claude <noreply@anthropic.com>
Date:   Wed Sep 23 21:41:27 2026 +0000

    docs: plano da Fase 0 e referência técnica da Evolution v2.3.7
    
    Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
    Claude-Session: https://claude.ai/code/session_011NhcAGM31KhBJ3LtrQWiiU
