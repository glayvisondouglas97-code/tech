# Mudanças em relação ao protótipo

Cada problema da [auditoria](auditoria-chamador-de-leads.md) e o que foi feito.

## 5.1 Arquitetura e plataforma

| Problema | Solução |
|---|---|
| 🔴 Depende do claude.ai | Aplicação própria (Node + Postgres), hospedável em qualquer lugar, com domínio próprio. |
| 🔴 Sem backend | Toda regra (atribuição, marcação, permissões, importação, distribuição) roda no servidor, em transações. |
| 🟠 Banco inadequado (5.000 docs, sem transação) | PostgreSQL com transações, índices e consultas no servidor. Um registro por lead; os "pedaços" acabaram. |
| 🟠 Cliente baixa a base inteira | Paginação, busca e filtros no servidor. A fila traz 50 leads por vez. Testado com 100 mil leads. |

## 5.2 Autenticação e permissões

| Problema | Solução |
|---|---|
| 🔴 Sem login de atendente | Login próprio por e-mail e senha (Argon2id), sessões no servidor, convite por link. "Quem chamou" vem da sessão, não de um nome escolhido. |
| 🟠 Permissões só na interface | Permissões conferidas em toda rota e toda consulta; testes chamam a API direto como atendente. |
| 🟠 Só um gestor | Vários administradores + papel de supervisor. |

## 5.3 Dados, concorrência e histórico

| Problema | Solução |
|---|---|
| 🟠 Última gravação vence | `SELECT … FOR UPDATE SKIP LOCKED` para pegar leads; travas por lead nas ações; versão nas edições (aviso em vez de sobrescrever). |
| 🟠 Sem histórico | Tabela de eventos só de acréscimo; "desfazer" e "chamar de novo" geram eventos novos. Linha do tempo em cada lead. |
| 🟠 Importação não atômica | Transação única: ou entra tudo ou nada. Exclusão de lista também é transacional. |
| 🟡 Leads presos | Devolução automática de leads parados (configurável), "Devolver parados" e redistribuição no painel; desativar atendente devolve a fila dele. |
| 🟡 "Sem WhatsApp" conta como chamado | Métricas separadas; não entra em "chamados" nem na conversão. |
| 🟡 "Hoje" pelo relógio do navegador | Calculado no servidor em America/Sao_Paulo; datas exibidas nesse fuso. |

## 5.4 Importação e telefones

| Problema | Solução |
|---|---|
| 🟠 Excel via CDN, sem teste | SheetJS instalado no servidor, testado com .xlsx, .xls e várias abas (unitário e ponta a ponta). |
| 🟠 Arquivos grandes no navegador | Processados no servidor, leitura em worker thread, gravação em segundo plano com progresso. Até 25 MB / 200 mil linhas. |
| 🟡 Normalização caseira | libphonenumber-js: validação real, tipo celular/fixo, 9º dígito de celular antigo, prefixo 0/operadora, internacionais com + ou 00, vários números na célula, DDD padrão. Deduplicação por E.164, configurável (arquivo e base). |
| 🟡 Sem relatório de rejeitados | CSV das linhas recusadas com o número da linha e o motivo. |

## 5.5 WhatsApp

| Problema | Solução |
|---|---|
| 🟡 Só click-to-chat | Mantido de propósito (envio em massa arrisca bloqueio e viola regras da Meta). Webhook da Cloud API pronto atrás de flag (respostas e status viram eventos; "Mensagem enviada" vira "Respondeu"). |
| 🟡 Sem "não contatar" nem limite | Lista de não contatar (atendente bloqueia na hora; nunca entra em importação) e aviso ao abrir muitas conversas por hora. |

## 5.6 Privacidade e LGPD

| Problema | Solução |
|---|---|
| 🟠 Todo atendente recebe todos os leads | O servidor só envia ao atendente os leads dele. |
| 🟡 Sem controles de dados | Registro de acessos e ações sensíveis, busca/exportação/anonimização/exclusão por titular, retenção automática. Ver [LGPD.md](LGPD.md). |

## 5.7 Qualidade do código

| Problema | Solução |
|---|---|
| 🟠 Um arquivo só | Módulos separados, TypeScript estrito, lint (Biome), CI. |
| 🟠 HTML montado com strings | React (escape automático) + CSP restritiva. |
| 🟡 Estado global e re-render | Estado por tela com TanStack Query; edições em andamento não são apagadas por atualizações. |
| 🟡 Pouca validação | 144 testes unitários/integração + 8 ponta a ponta, incluindo concorrência, permissões pela API, importação de 1.000 linhas, celular e 100 mil leads. |

## Acrescentado por conta própria

- Papel de **supervisor**; convite por link com envio pelo WhatsApp; tela de primeiro acesso.
- **Modo foco** (um lead por vez, atalhos de teclado) e **retornos agendados** com destaque de atrasados.
- **Várias mensagens prontas** com prévia; variáveis de colunas extras.
- **Página Leads** para o gestor: filtros, seleção em lote, atribuir/devolver, redistribuir, devolver parados.
- Gráfico de chamados por dia, andamento por lista, conversão por atendente, exportação CSV e Excel.
- Limite de leads na fila por atendente; aviso de excesso de conversas por hora.
- Link do WhatsApp em `wa.me` (abre o aplicativo no celular e o WhatsApp no computador).
- PWA instalável, tema claro/escuro, nome e logo da empresa.
- Postgres local automático para desenvolvimento (sem Docker), dados de demonstração com números fictícios.

## Segunda rodada (setembro de 2026)

- Leads de pessoa jurídica: coluna da empresa na importação (detectada sozinha, dá para trocar), empresa em destaque e sócio/proprietário embaixo em todas as telas, exportações e mensagem pronta (variável `{empresa}`).
- Na importação e em Listas: total de empresas, total de telefones e quanto falta pegar de cada lista.
- Hierarquia: dono (acesso master) > administrador > supervisor > atendente. Só o dono cria/promove administradores, exclui listas e usa a LGPD; administradores não veem as ações do dono.
- Auditoria completa (menu **Auditoria**): pedidos de leads, qual lead foi para quem, quanto cada pessoa puxou e chamou por dia, quem mais puxou/chamou, tentativas de acesso sem permissão, acessos e gestão; filtro por pessoa e tipo; exportação em planilha.
- "Pegar leads": escolhe a quantidade e o DDD; a fila do atendente também filtra por DDD.
- Limite de leads por dia: padrão em Configurações, individual em Equipe.
- Resultados: mensagem enviada, respondeu, cliente não respondeu, cliente não tem conta no banco, cliente não é correntista (mantidos também interessado, fechou, sem interesse e sem WhatsApp).

## Terceira rodada: visual SaaS, celular e desempenho

- Botão "Chamar no WhatsApp" usa só o link oficial `wa.me/<número>?text=...`: no celular abre o aplicativo, no computador o WhatsApp Desktop ou Web. Saiu a opção "WhatsApp Web / aplicativo".
- Novo visual: fonte Inter, paleta neutra com índigo (ação) e verde só para o WhatsApp, cartões de indicadores, avatares coloridos, tabelas e diálogos redesenhados, tema claro e escuro.
- Computador: menu lateral com ícones, separado em Trabalho e Gestão, e cartão da pessoa (conta, tema, sair) no rodapé.
- Celular: barra inferior (A chamar, Já chamados, Painel, Menu), gaveta lateral, cartões de lead com botão grande do WhatsApp, campos de 16 px (sem zoom automático no iPhone), alvos de toque de 44 px, diálogos como folha de baixo para cima, aviso de "sem internet".
- Menu "…" de cada lead: copiar número e copiar mensagem pronta.
- Desempenho: telas de gestão carregam sob demanda (o atendente baixa ~19 KB de código do app + bibliotecas em cache), bibliotecas num arquivo separado com cache de 1 ano, uma única fonte variável.

## Quarta rodada: pronto para uso e painel de usuários

- Sem dados de demonstração: o sistema começa vazio. No `npm run dev`, o terminal mostra o código de primeiro acesso para criar a conta do dono pela tela.
- Menu **Usuários** (antes "Equipe"): cartões com a hierarquia (dono, administrador, supervisor, atendente) que também filtram, tabela com papel, situação e último acesso, busca e filtro de ativos/desativados.
- Criar usuário com **e-mail e senha definidos pelo gestor** (ou, se preferir, por link de convite), escolhendo o papel. Botão para gerar senha forte e para copiar/enviar os dados de acesso.
- **Definir nova senha** de alguém: a senha antiga deixa de valer e as sessões abertas da pessoa caem. Tudo registrado na Auditoria ("Definiu a senha de alguém"), sem guardar a senha.
- A hierarquia vale no servidor: administrador só cria e altera supervisores e atendentes; só o dono cria administradores e donos.

## Quinta rodada: visual novo (barra lateral que abre com o mouse)

- Barra lateral preta em formato de pílula, só com ícones; ao passar o mouse (ou navegar pelo teclado) ela se abre por cima da tela e mostra o nome de todas as seções. Embaixo: Configurações, tema claro/escuro e a sua conta.
- Barra de cima com ação principal em pílula preta (Importar lista / Pegar leads), busca, sino com os retornos de hoje e avatar com o menu da conta. Na fila, o seletor Lista / Modo foco fica no meio da barra.
- Fonte Poppins, fundo cinza bem claro, cartões brancos com cantos grandes, botões e selos em pílula, rótulos em maiúsculas pequenas.
- Painel com um cartão por atendente: chamados de hoje em destaque, minigráfico de 14 dias (verde = chamados, vermelho = sem WhatsApp), 7 dias e sem WhatsApp embaixo e uma caixa com 30 dias, interessados e fechados. Quem mais chamou no dia ganha borda destacada.
- Celular: barra de atalhos preta flutuante embaixo e o menu completo numa gaveta preta.
