# Auditoria: Chamador de Leads (versão 1)

Data: 23/09/2026
Escopo: tudo o que foi construído nesta conversa, sem nenhuma alteração posterior.

---

## 1. Resumo

**O pedido:** uma aplicação web em que o gestor sobe a base de leads e os atendentes trabalham nela, com:

- um botão para chamar o cliente no WhatsApp;
- um botão para marcar o cliente como chamado;
- uma aba de clientes já chamados, mostrando qual atendente chamou.

O objetivo é organizar a equipe e ganhar tempo.

**O que foi entregue:** uma página HTML única, publicada como Artifact dentro do claude.ai, que guarda os dados no banco embutido da plataforma Claude.

**Veredito:**

- **Funcionalidade e interface:** atendem boa parte do pedido.
- **Arquitetura:** não serve como sistema para uma empresa. A página só funciona dentro do claude.ai, e cada atendente precisa de uma conta Claude e de um convite por e-mail. Não há login próprio nem banco de dados de verdade, e as regras de negócio rodam só no navegador.

**Causa principal:** eu escolhi a hospedagem (página no Claude) sem confirmar com você. A escolha certa era um app próprio.

---

## 2. O que existe hoje

| Item | Situação |
|---|---|
| Arquivo | `referencia-chamador-de-leads.html`: 1.422 linhas, cerca de 91 KB, com HTML, CSS e JS no mesmo arquivo |
| Onde roda | Artifact privado no claude.ai (ícone "phone"), visível só para o dono até ser compartilhado |
| Formato do arquivo | É um fragmento, sem `<!doctype>`, `<html>`, `<head>` nem `<body>`, porque a plataforma coloca esse esqueleto na hora de publicar. Aberto sozinho no navegador, mostra só o aviso "Abra esta página pelo link do Claude" |
| Dependências externas | Google Fonts (Figtree, Schibsted Grotesk, IBM Plex Mono). SheetJS 0.18.5 carregado sob demanda do cdnjs, com o jsDelivr como reserva, só para ler Excel |
| Frameworks | Nenhum: JavaScript puro, sem build, sem TypeScript e sem testes automatizados |
| Estado do banco agora | Só existe `config/main`, com a mensagem padrão e a equipe vazia. Não há listas nem leads. Um documento de teste foi criado e depois apagado |

### 2.1 Capacidades da plataforma Claude usadas

- **`db`:** banco de documentos JSON do Artifact, com atualização em tempo real via `onSnapshot`.
- **`user`:** diz se quem está vendo é o dono (`isOwner`), se pode gravar (`can('data.write')`) e dá um id opaco do usuário.
- **`downloads`:** exporta arquivos CSV, e o navegador pede confirmação antes de salvar.

**Regras de acesso declaradas:**

- `config`: todos leem, só o **dono** grava.
- `lists`: todos leem, só o **dono** grava.
- Restante (`batches`): quem tem acesso de interação ou de edição grava. Esse é o padrão da plataforma.

**Limites da plataforma que moldaram o design:**

- no máximo 5.000 documentos por banco;
- no máximo 256 KiB por documento;
- no máximo 64 assinaturas em tempo real por visualização;
- sem transações: vale a última gravação;
- sem índices: as consultas varrem a coleção inteira.

---

## 3. Modelo de dados

```
config/main
  attendants: { <idAtendente>: { name, active, c(createdAt ms) } }
  template:   "Olá, {nome}! Tudo bem? Aqui é {atendente}. ..."

lists/<listId>
  name, createdAt, total, chunks, dist ('fila' | 'dividir'), cols[], by(uid|null), demo?

batches/<listId>-<k>          ← "pedaço" da lista (até 200 leads ou cerca de 110 KB)
  list, listName, idx, createdAt,
  leads: { <leadId>: Lead }
```

**Lead** (os campos têm nomes curtos para economizar espaço no documento):

| Campo | Significado |
|---|---|
| `n` | nome (até 80 caracteres) |
| `p` | telefone só com dígitos, já com o 55 (ex.: `5541998765432`) |
| `x` | colunas extras da planilha (até 6 colunas; chave com até 30 caracteres e valor com até 60) |
| `o` | ordem original na planilha |
| `s` | situação: `p` = pendente, `c` = chamado |
| `a` | id do atendente dono do lead (`null` quando o lead está na fila livre) |
| `ca` | momento em que o lead foi atribuído ou pego (ms) |
| `by` | id do atendente que marcou como chamado |
| `at` | momento em que foi marcado como chamado (ms) |
| `r` | resultado: `enviado`, `respondeu`, `interessado`, `fechou`, `sem_interesse` ou `invalido` |
| `nt` | observação (até 300 caracteres) |
| `w` | momento em que o atendente clicou em "Chamar no WhatsApp" |
| `u` | id opaco do usuário Claude que marcou |

**Motivo dos "pedaços":** com um documento por lead, o limite de 5.000 documentos acabaria rápido. Os leads foram agrupados em documentos-pedaço, e cada alteração faz uma mesclagem só no lead afetado.

---

## 4. Funcionalidades entregues

### Aba "A chamar" (atendente)

- O atendente escolhe o próprio nome numa lista e a escolha fica salva só naquele navegador (`localStorage`).
- Ele vê a fila dele com nome, telefone formatado, lista de origem e até 3 colunas extras.
- **Chamar no WhatsApp:** abre um link click-to-chat.
  - No computador: `https://web.whatsapp.com/send?phone=…&text=…`
  - No celular: `https://api.whatsapp.com/send?phone=…&text=…`
  - O atendente pode trocar entre as duas opções e ligar ou desligar a mensagem pronta.
- Ao clicar no WhatsApp, o sistema grava o horário e destaca o botão "Marcar como chamado".
- **Marcar como chamado** e **Sem WhatsApp:** marcam o lead na hora e mostram um aviso com "Desfazer".
- **Pegar mais 10 leads:** pega leads da fila livre, começando pelas listas mais antigas. Cada pedaço é travado por 2,5 s (`acquire`) para que dois atendentes não peguem o mesmo lead.
- Há busca por nome, telefone ou lista, e um resumo com "na sua fila", "você chamou hoje" e "livres".

### Aba "Já chamados"

- Filtros por atendente (incluindo "Só os meus"), por resultado e por período (hoje, 7 dias, 30 dias ou tudo), além de busca.
- Cada linha mostra quem chamou e quando, o resultado (editável em um select colorido) e a observação.
- Botões para reabrir a conversa no WhatsApp e para devolver o lead à fila.
- O dono pode editar qualquer lead. O atendente só edita os que ele mesmo marcou.
- O dono pode exportar a lista filtrada em CSV.

### Aba "Painel"

- Números principais: leads na base, já chamados (com o percentual), chamados hoje e quantos faltam, separando os que estão com atendentes dos livres.
- Barra de andamento da base.
- Tabela por atendente: hoje (com barra), 7 dias, total, interessados, fechados e quantos estão na fila dele.
- Contagem por resultado.
- O dono pode exportar a base completa em CSV.

### Aba "Configurar" (só o dono)

**Importação:**

- Aceita arquivo arrastado ou escolhido (.xlsx, .xls, .ods, .csv, .txt, .tsv) ou linhas coladas.
- CSV: o separador (`;` `,` tab `|`) é detectado sozinho, e o arquivo é lido em UTF-8 ou, se isso falhar, em Windows-1252.
- Detecta se a primeira linha é cabeçalho e escolhe as colunas de nome e telefone com base no título e no conteúdo, com opção de ajuste manual.
- Tem campo de DDD padrão e mostra uma prévia com o número de leads válidos, repetidos e sem telefone.
- Pula telefones que já estão na base, incluindo os já chamados.
- Distribuição: fila livre ou divisão igual entre os atendentes marcados.

**Normalização de telefone:**

- quando a célula tem vários números separados por `/` `,` `;` `|` ou "ou", usa o primeiro válido;
- remove `00` e zeros à esquerda;
- aplica o DDD padrão a números com 8 ou 9 dígitos;
- coloca o 55 em números com 10 ou 11 dígitos;
- aceita números com 12 a 15 dígitos.

**Outros itens:**

- **Equipe:** adicionar atendente, devolver os leads da fila dele e removê-lo. Remover desativa o atendente e devolve os pendentes dele.
- **Mensagem pronta:** variáveis `{nome}` (primeiro nome com inicial maiúscula), `{nome_completo}`, `{atendente}` e o nome de qualquer coluna extra. Tem prévia e opção de voltar ao texto padrão.
- **Listas:** progresso de cada lista e exclusão com confirmação na própria tela. A exclusão apaga os pedaços e o documento da lista.
- **Lista de exemplo:** 8 leads falsos com DDD 00. Também dá para baixar uma planilha modelo em CSV.

### Interface geral

- Português do Brasil, tema claro e escuro, layout que se adapta ao celular.
- Avisos (toasts) com "Desfazer", foco visível no teclado e respeito a `prefers-reduced-motion`.

---

## 5. Problemas encontrados

Gravidade: 🔴 impede o uso real · 🟠 risco importante · 🟡 melhoria.

### 5.1 Arquitetura e plataforma

- 🔴 **Depende do claude.ai.**
  - Só roda dentro do Claude, e cada atendente precisa de conta Claude e de convite por e-mail com permissão de edição.
  - Não permite domínio próprio, não roda em outro servidor e não funciona fora da plataforma.
- 🔴 **Não há backend.** Toda regra de negócio (atribuição, marcação, permissões finas, importação) roda no navegador, e o servidor só aplica as regras genéricas do banco.
- 🟠 **O banco não foi feito para isso.**
  - Os limites são 5.000 documentos e 256 KiB por documento.
  - Não há transações, índices nem consultas no servidor.
  - O modelo "pedaços com 200 leads" é um contorno desses limites e complica tudo.
- 🟠 **Todo cliente baixa a base inteira.** Cada navegador assina a coleção `batches` completa e monta a lista de leads na memória, o que funciona só até alguns milhares de leads.

### 5.2 Autenticação e permissões

- 🔴 **Não há login de atendente.** A identidade é um nome escolhido numa lista e guardado no navegador. Qualquer pessoa pode escolher o nome de outra, e o histórico de "quem chamou" pode ser falsificado.
- 🟠 **Permissões pouco granulares.**
  - As regras só separam o "dono" dos demais, e os atendentes convidados com edição têm nível de administrador na plataforma.
  - Pela API, um atendente consegue gravar ou apagar qualquer pedaço de leads. A proteção existe só na interface.
- 🟠 **Só um gestor.** Não há papel de supervisor nem vários administradores.

### 5.3 Dados, concorrência e histórico

- 🟠 **Última gravação vence.** A trava ao pegar leads é cooperativa. "Desfazer" e "Voltar para a fila" podem apagar uma mudança feita ao mesmo tempo por outra pessoa.
- 🟠 **Não há histórico de eventos.** Cada lead guarda só o último estado (`by`, `at`, `r`). Retornos e novos contatos sobrescrevem o anterior, e "Desfazer" apaga o registro.
- 🟠 **Importação não é atômica.** O documento da lista é gravado primeiro e os pedaços depois, um a um. Se a internet cair no meio, sobra uma lista parcial. A tela mostra os pedaços órfãos, mas não desfaz nada. A exclusão de listas tem o mesmo problema.
- 🟡 **Leads presos.** Um lead pode ficar para sempre na fila de um atendente, porque não há expiração.
- 🟡 **"Sem WhatsApp" conta como chamado** nas métricas.
- 🟡 **"Hoje" usa o relógio do navegador** e não um fuso fixo (America/Sao_Paulo).

### 5.4 Importação e telefones

- 🟠 **Leitura de Excel depende de CDN e não foi testada.** A rede do ambiente de construção bloqueou o download da biblioteca. Se ela falhar, o sistema pede para salvar em CSV.
- 🟠 **Arquivos grandes.** Tudo é processado no navegador, sem fila de processamento e limitado pela memória e pelos 5.000 documentos.
- 🟡 **Normalização caseira.** Não usa libphonenumber, não trata o 9º dígito de celulares antigos e trata números internacionais de forma superficial. A deduplicação compara só o telefone normalizado exato.
- 🟡 **Sem relatório de rejeitados.** Não dá para baixar as linhas que foram recusadas na importação.

### 5.5 WhatsApp

- 🟡 **Só links click-to-chat.**
  - O sistema não sabe se a mensagem foi enviada: o atendente marca manualmente.
  - Não há integração com a API oficial (WhatsApp Business Cloud API), nem recebimento de respostas ou status de entrega.
- 🟡 **Não há lista de "não contatar" (opt-out)** nem limite de contatos por hora para reduzir o risco de bloqueio do número.

### 5.6 Privacidade e LGPD

- 🟠 **Todo atendente recebe todos os leads**, inclusive os dos colegas, com nome e telefone, mesmo que a tela mostre só os dele.
- 🟡 **Faltam controles de dados.** Não há registro de acesso, política de retenção, anonimização nem exclusão por titular.

### 5.7 Qualidade do código

- 🟠 **Um arquivo só.** Não há módulos, tipos, testes automatizados, lint nem CI.
- 🟠 **Interface montada com strings de HTML.** O escape manual (`esc()`) está aplicado em todo lugar, mas é frágil: um esquecimento vira XSS.
- 🟡 **Estado global e re-render por `innerHTML`.** Um select aberto pode fechar quando chega uma atualização de outro usuário. As observações em edição são preservadas por um contorno.
- 🟡 **Validação feita:**
  - checagem de sintaxe do JavaScript;
  - uma captura de tela no computador com o banco simulado;
  - teste das regras de acesso do banco (o atendente não grava `config`, e quem tem acesso de interação grava `batches`).
- 🟡 **O que não foi testado:**
  - uso real com várias pessoas ao mesmo tempo;
  - importação de Excel;
  - layout no celular e tema escuro na prática;
  - disputa real no "Pegar mais leads";
  - download dos CSVs.

---

## 6. O que vale reaproveitar (como especificação, não como código)

- Os fluxos e textos das telas (A chamar, Já chamados, Painel, Configurar), que funcionaram bem visualmente.
- O modelo **"fila livre + pegar os próximos N"**, com a alternativa de dividir igualmente ao importar.
- A lista de resultados: Mensagem enviada, Respondeu, Interessado, Fechou negócio, Sem interesse e Sem WhatsApp.
- A mensagem pronta com variáveis (`{nome}`, `{nome_completo}`, `{atendente}` e as colunas extras).
- As heurísticas de importação: detecção de cabeçalho, pontuação de colunas, separador de CSV, Windows-1252 e DDD padrão.
- As métricas do painel: por atendente hoje, 7 dias e total, interessados, fechados e fila.
- A exportação em CSV com `;` e BOM, que abre direto no Excel em português.

---

## 7. Recomendação

Refazer o sistema como uma aplicação web independente: login próprio para cada atendente, backend com banco relacional e transações, regras de negócio e permissões no servidor, histórico de eventos e deploy na sua própria hospedagem. A página atual serve como protótipo e especificação funcional. O prompt para o Codex está em `prompt-codex.md`.
