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

**Áudios e campanha automática:** o dono e o administrador montam a biblioteca de áudios na tela **Áudios** e ligam ou
pausam a **campanha automática** em **Automações**. Todo atendente usa os áudios ao chamar um lead (o sistema sorteia um e
envia), mas só a gestão cadastra, exclui e comanda a campanha.

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
4. Ao escolher o número, o sistema **sorteia um áudio salvo** (ver **Áudios** abaixo) e o envia ao lead como
   mensagem de voz. A conversa abre em **Conversas**, onde dá para continuar (gravar outro áudio, escrever, enviar
   arquivo). Se ainda não houver nenhum áudio salvo, a conversa abre vazia para você gravar na hora.
5. Ao sair a primeira mensagem, o lead fica **Chamado · Mensagem enviada** e sai da sua fila. Quando ele responder, o
   resultado muda sozinho para **Respondeu** (e a resposta fica no histórico do lead).
6. No alto da conversa aparece a faixa do lead (situação, sócio e lista), com **Ver lead** (ficha e histórico, para
   anotar e agendar retorno) e **Voltar para a fila**. No celular, a seta do alto volta para a fila.

Uma conversa aberta pelo **Chamar** só aparece na lista de conversas depois da primeira mensagem.

### Áudios

Em **Áudios** (no menu; só o dono e o administrador), você monta a biblioteca de áudios que o botão **Chamar** e a
**campanha automática** usam:

1. Clique em **Salvar áudio**, dê um nome (ex.: `Apresentação — 20s`) e **grave pelo microfone** ou **escolha um
   arquivo** já pronto (MP3, OGG, OPUS, M4A, WAV, AAC ou WEBM). Ouça a prévia e clique em **Salvar áudio**.
2. Salve **várias versões da mesma mensagem**, de durações diferentes. O sistema **sorteia** uma delas a cada envio, assim
   não vai sempre o mesmo áudio para todos os clientes. O sorteio é um **rodízio guardado no banco**: todos os áudios ativos
   saem uma vez antes de qualquer um repetir (continua de onde parou mesmo se o servidor reiniciar).
3. Cada áudio tem um interruptor **No sorteio / Desligado** (o desligado fica guardado, mas não é enviado) e um botão
   para **excluir**. As mensagens já enviadas às conversas continuam lá. Sem nenhum áudio no sorteio, a tela avisa: o
   Chamar abre a conversa sem áudio e a campanha automática não envia nada.

### Automações (campanha automática)

Em **Automações** (no menu; só o dono e o administrador) fica a **campanha automática**, pré-definida pelo sistema. Não
há nada para montar (nem automação, nem gatilho, nem etapa): só o botão **Ativar** (ou **Pausar**) e as métricas.

**O que ela faz depois de ativada:** de **segunda a sexta, das 10:00 às 16:00** (horário de São Paulo), o sistema:

1. pega o próximo lead da **fila livre** (pendente, sem atendente, de qualquer lista não arquivada, com celular, fora do
   "não contatar" e que nunca recebeu o áudio da campanha);
2. **sorteia um áudio** da biblioteca (o rodízio acima);
3. **escolhe um número** entre os cadastrados e **conectados** (o menos usado no dia; empate por sorteio). Número
   cadastrado depois entra sozinho no rodízio; número desconectado fica de fora até reconectar;
4. confere se o telefone tem WhatsApp e **envia o áudio**. O lead vira **Chamado · Mensagem enviada** (sem atendente); se
   responder, vira **Respondeu** sozinho e a conversa aparece para o responsável pelo número. Sem WhatsApp, o lead vira
   **Sem WhatsApp** e a campanha segue.

- **Limite:** cada número faz no máximo **20 contatos novos por dia**, somando os do Chamar (veja "Cota diária" abaixo). Os
  envios do dia são espalhados pela janela (não saem todos de uma vez).
- **Fora do horário** (antes das 10:00, depois das 16:00, sábado e domingo) ela fica **Ativa, esperando**: não envia nada e
  volta sozinha no próximo horário. Não precisa ativar de novo todo dia; ela fica ligada até alguém clicar em **Pausar**.
- **Pausar** para na hora: nada é reservado nem enviado. **Ativar de novo** continua de onde parou, sem repetir nenhum lead.
- Ela **não termina** quando a fila esvazia: leads importados depois também recebem.
- Para ativar é preciso ter **pelo menos um áudio no sorteio** e **um número cadastrado**. A tela avisa o que falta
  (sem áudio, nenhum número conectado, todos os números já com 20/20 hoje, fila vazia).

**Métricas na tela:** **Para enviar hoje** (o menor entre os leads disponíveis e as vagas que ainda cabem hoje nos números
conectados), **Enviados**, **Sem WhatsApp**, **Responderam** (com a taxa de resposta) e **Não responderam**, cada um com o
número de **hoje** (leads que receberam o áudio hoje) e o **total** desde a primeira ativação; e o uso de cada número hoje.
A tela se atualiza sozinha (tempo real).

**Por dentro:** é o mesmo motor que já existia (fila das campanhas, executor, cota e rodízio de áudios, tudo no
PostgreSQL, um job a cada 10 segundos). A campanha é uma automação do sistema (`system_key = 'campanha_automatica'`) com uma
etapa só (áudio sorteado) e uma campanha com **todas as listas** e **todos os números**. A API genérica de automações não
altera, pausa nem arquiva essa automação. Na atualização para esta versão, as automações montadas na tela antiga foram
**arquivadas** e as campanhas delas **encerradas** (o histórico fica); nada continua enviando sem aparecer na tela.

**Auditoria:** ativar, pausar, cada lead que entra, cada envio, cada lead sem WhatsApp e cada participação cancelada.

**Por API** (permissão de automações): `GET /api/auto-campaign` (situação e métricas), `POST /api/auto-campaign/activate` e
`POST /api/auto-campaign/pause`.

> **Importante:** o envio automático usa o WhatsApp Web pela Evolution, sem vínculo oficial com a Meta. A cota, o horário e
> o rodízio **reduzem o volume por número**, mas **não impedem** que o WhatsApp restrinja um número, e mensagem para quem não
> pediu contato pode violar os termos do WhatsApp. Para volume maior com segurança, o caminho é a API oficial do WhatsApp
> Business (Meta).

**Limites que valem a pena saber:** o sistema não conhece as regras internas do WhatsApp; a Evolution não confirma
duplicidade (por isso o envio nunca é repetido no escuro, veja "Quando algo dá errado"); o dia e o horário são sempre os de
São Paulo; e a cota e a agenda são **controles operacionais**, não uma proteção contra bloqueio.

### Cota diária de contatos por número (manual + automático)

**Cada número de WhatsApp pode iniciar no máximo 20 contatos por dia, somando os contatos manuais e os automáticos.** Não são
duas cotas: 20 automáticos + 20 manuais **não** viram 40 no mesmo número. Pode ser 7 manuais + 13 automáticos, 20 manuais
e nenhum automático, 4 + 16, e assim por diante; ao chegar em **20/20** o número não inicia outro contato naquele dia.

- **O que é um contato:** a **primeira mensagem** enviada a um lead por aquele número.
  - **Manual:** a mensagem inicial do botão **Chamar** (o áudio sorteado) ou, se o Chamar não enviou nada, a primeira
    mensagem que o atendente digita na conversa do lead. Continuar uma conversa que já tem mensagens, ou responder a quem
    escreveu primeiro, **não** é contato novo e **não** é barrado pela cota.
  - **Automático:** o áudio da **campanha automática** (e a primeira mensagem de uma execução pela API
    `POST /api/automations/ID/run`). A execução pela API é **recusada** (409, "Este número já atingiu o limite de 20 contatos
    hoje.") quando o número está em 20/20 e, se a cota encher entre criar a execução e enviar, a mensagem **não sai hoje** e
    espera o próximo dia útil às 10:00 (nunca a madrugada).
  - **Dois envios ao mesmo tempo** na mesma conversa nova (clique duplo no Chamar, áudio e texto juntos) contam como **um**
    contato só.
  - **Não consomem vaga:** abrir a conversa, conferir se o lead tem WhatsApp, escolher um lead, criar a participação,
    **reservar** uma posição futura e as etapas seguintes de qualquer automação. O gatilho "**lead chamado**" também não é
    contato novo: o Chamar que o disparou já foi contado como manual.
- **O dia é o de São Paulo (`America/Sao_Paulo`).** A contagem é por número e por dia: no dia seguinte o número volta a
  **0/20** sozinho, ninguém zera contador. Um lead reservado às 15:59 e enviado no dia seguinte gasta a cota do dia
  seguinte, não a do dia da reserva.
- **Quem manda no limite é o servidor.** Se o atendente tenta chamar por um número que está em 20/20, o sistema **não envia** e
  responde: *"Este número já atingiu o limite de 20 contatos hoje."* Escolher o mesmo número de novo não contorna nada; outro
  número, com a própria cota, continua funcionando.
- **Onde ver:** em **Números** cada número mostra `14/20 contatos hoje` (manuais e automáticos) e **Limite diário atingido**
  quando enche; na **campanha**, o uso de cada número e a capacidade que ainda cabe hoje.
- **Horário, dia e cota são regras independentes:** para uma campanha enviar, **todas** precisam valer (dentro do horário de
  trabalho, num dia da campanha **e** com vaga na cota).
- **Como é protegido:** o uso fica no PostgreSQL (`wa_instance_daily_usage`, uma linha por número e dia), com uma trava do
  próprio banco (`total ≤ 20`). A vaga é segurada de forma **atômica** antes do envio, então dois processos, dois workers, o
  atendente e a campanha ao mesmo tempo nunca pegam a mesma última vaga. Nada fica em memória: reiniciar o servidor não zera
  a contagem.
- **Resultado incerto:** se a Evolution recusa claramente o envio (ou o número está desconectado), a vaga **volta**. Se o resultado
  é incerto (erro do servidor, demora, queda), a vaga **fica ocupada como "incerta"** e a mensagem **não é reenviada às cegas**:
  é melhor sobrar uma vaga sem uso do que passar do limite.
- **Histórico:** por número e por dia o sistema guarda manuais, automáticos, incertos e o total. Os dias anteriores à
  instalação **não** são reconstruídos; só o **dia da instalação** é (veja "Backfill do dia da instalação" logo abaixo).
- **O que não é contado:** mensagens que alguém manda direto pelo celular, fora do sistema, porque o sistema só conta os
  envios que ele mesmo faz.

**Backfill do dia da instalação (migração `0015_backfill_cota_diaria`).** A cota só existe a partir da migração `0013`.
Sem cuidado, um número que já tinha feito 14 contatos naquele dia apareceria como 0/20 logo depois de atualizar. Por isso a
migração `0015` roda **uma vez**, ao atualizar, e reconstrói a cota **somente do dia em que ela é aplicada** (dia de São
Paulo: do início do dia em `America/Sao_Paulo` até o início do dia seguinte, nunca `CURRENT_DATE` do banco). **Dias
anteriores não são recalculados**: a estrutura antiga não garante que todo contato histórico possa ser classificado com
segurança. Exemplo: um número com 7 contatos manuais e 5 automáticos naquele dia passa a mostrar **12/20** (7 manuais · 5
automáticos, restam 8), e não 0/20.

- **O que é contado** (só o *primeiro contato que o sistema iniciou com um lead*, com evidência estrutural no banco):
  - **Manual:** mensagem enviada por uma **pessoa pelo sistema** (a mensagem guarda quem enviou), numa conversa **ligada a um
    lead**, que é a **primeira mensagem da conversa** (nenhuma mensagem antes, nem recebida nem enviada): o Chamar com áudio ou
    a primeira mensagem digitada para o lead.
  - **Automático:** a mensagem da **primeira etapa** de uma execução de **campanha** ou do gatilho **manual** (`/run`),
    concluída e ligada à execução pelo histórico da automação, numa conversa do mesmo lead.
- **O que NÃO é contado** (é preferível subcontar a inventar): mensagens recebidas; respostas do lead; continuação de
  conversa e mensagem manual numa conversa que já tinha mensagens; mensagens enviadas **direto pelo celular** (não dá para
  saber se foram primeiro contato); etapas seguintes (acompanhamento) e o gatilho "lead chamado" (o Chamar que o disparou já
  contou); conversas sem lead; mensagens de outros dias; qualquer mensagem sem lead identificável com segurança. Também não há
  como distinguir uma mensagem de "teste" de uma real: se foi um primeiro contato pelo sistema, conta.
- **Manual x automático:** separados só quando a evidência permite (mensagem de pessoa x etapa de automação). O que não puder
  ser classificado fica **fora** da contagem, nunca é atribuído por palpite. Contatos **incertos** (`uncertain`) **não** são
  estimados: o que já estiver gravado na linha do dia é mantido como está.
- **Seguro para repetir:** a linha do dia é **recalculada**, não somada: manual e automático viram o maior entre o que já
  estava gravado e o que o histórico prova, e o incerto é mantido. Rodar de novo dá o mesmo resultado. O total nunca passa de
  20 (a trava do banco): se o histórico do dia tiver mais contatos que isso (de antes de existir limite), o número fica em
  **20/20**, o resultado conservador.
- **Limitações:** subconta, nunca inventa. Mensagens apagadas (pelo sistema ou pela LGPD), conversas de um número excluído, uma
  pessoa da equipe excluída (a mensagem perde o autor) e mensagens mandadas pelo celular não entram; um histórico antigo
  importado na mesma conversa pode fazer o primeiro contato deixar de parecer "primeiro". Nada disso é corrigido depois: o
  backfill roda uma vez.

> **Isto é controle operacional, não proteção.** O limite de 20 por dia **não garante** que o WhatsApp não restrinja ou bloqueie
> um número, e o rodízio, o horário e o sorteio de áudio também não. Não há detecção de número bloqueado. O backfill só
> evita começar o dia da instalação em 0/20; ele não muda essa limitação.

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
| `POST /api/leads/ID/conversation` | "Chamar": confere se o lead tem WhatsApp e abre a conversa pelo número escolhido (`{"instanceId": 1}`); com `"sendAudio": true`, sorteia e envia um áudio salvo |
| `GET /api/leads/ID/conversations` | Conversas já abertas com o lead (por qual número) |
| `GET /api/audios` · `POST /api/audios?label=...&seconds=...` | Lista os áudios do Chamar / salva um novo (corpo = arquivo). Só dono/administrador |
| `PATCH /api/audios/ID` · `POST /api/audios/ID/delete` | Liga/desliga (`{"active": true}`) ou exclui um áudio |
| `GET /api/audios/ID/media` | Ouve o áudio salvo (tela de Áudios) |
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
