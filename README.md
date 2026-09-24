# Central de WhatsApp

Sistema web próprio que junta, num só lugar, as conversas de vários números de WhatsApp conectados pela
[Evolution API](https://github.com/evolution-foundation/evolution-api) (versão fixa **v2.3.7**).

O plano completo e as decisões estão em [`docs/PLANO.md`](docs/PLANO.md).

## Serviços

| Serviço | Para quê |
|---|---|
| `evolution` | Conecta os números de WhatsApp (1 instância por número) |
| `postgres` | Banco `evolution` (usado pela Evolution) e banco `central` (usado pelo nosso sistema) |
| `redis` | Cache da Evolution |
| `app` | Nosso sistema: o site (tela de conversas) e o backend, que recebe os webhooks, grava as conversas e envia as respostas |

A Evolution (`127.0.0.1:8080`) e o backend (`127.0.0.1:3100`) só ficam acessíveis no próprio computador,
nunca pela rede.

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

### 4. Conectar os números

1. Abra **<http://localhost:3100>** e clique em **Números**, no alto da lista de conversas.
2. Digite um apelido (ex.: `WhatsApp 3 - João`) e clique em **+ Adicionar número**.
3. O QR Code aparece na tela. No celular desse número, abra o WhatsApp → **Dispositivos conectados** →
   **Conectar dispositivo** e escaneie. Ao conectar, a janela mostra "Conectado!" e fecha sozinha.

O sistema cria o número na Evolution já com o webhook, "ignorar grupos" ligado e "marcar como lida automaticamente"
desligado. O histórico dos últimos 14 dias é importado sozinho logo depois da conexão.

**Número caiu?** O botão **Números** fica vermelho ("1 desconectado"). Na tela de números, clique em **Reconectar**:
se a sessão ainda valer, ele volta sozinho; se não, aparece um QR Code novo.

> O painel da Evolution (<http://localhost:8080/manager>) continua disponível para emergências, mas não é mais
> necessário. Não altere nele as opções de webhook dos números.

## Usar o sistema

Abra **<http://localhost:3100>** no navegador.

- **Esquerda**: todas as conversas de todos os números, da mais recente para a mais antiga. A aba **Responderam** mostra
  só os leads que responderam; a aba **Todas** mostra tudo. O filtro **Número** mostra só um WhatsApp. Cada conversa
  tem um selo colorido com o número por onde ela acontece e o contador de não lidas.
- **Direita**: o chat aberto. **Enter** envia e **Shift + Enter** quebra a linha. A resposta sai sempre pelo mesmo
  número da conversa.
- Abrir a conversa zera as não lidas **no sistema**. O tique azul só vai para o lead quando alguém responde.
- Mensagens novas, status (entregue/lida) e contadores aparecem na hora, em todas as telas abertas. Se a conexão cair,
  aparece um aviso amarelo; quando ela volta, a tela busca sozinha o que chegou nesse meio tempo.
- **Áudio**: com a caixa de texto vazia, clique em 🎤 para gravar. Aparece "Gravando 0:05"; clique em **Enviar áudio**
  (ou 🗑 para descartar). O áudio chega no WhatsApp do lead como **mensagem de voz**. Na primeira vez, o navegador pede
  permissão para usar o microfone.
- **Imagem ou documento**: clique em 📎, escolha o arquivo (até 25 MB), escreva uma legenda se quiser e envie. JPG, PNG
  e WebP vão como imagem; qualquer outro arquivo (PDF, planilha etc.) vai como documento.
- **Mídias recebidas**: áudios têm player, imagens aparecem no chat (clique para ampliar) e documentos têm o botão
  **Baixar**. As mídias ficam guardadas no volume `media_data` do Docker (não no banco).

## Como atualizar (a cada nova fase)

```powershell
git pull
docker compose up -d --build
```

## API do backend (Fase 2)

Dá para abrir as rotas `GET` direto no navegador.

| Rota | O que faz |
|---|---|
| `GET /api/instances` | Lista os números e o status de cada um |
| `GET /api/conversations?tab=responderam` | Conversas em que o lead respondeu, da mais recente para a mais antiga |
| `GET /api/conversations?tab=todas` | Todas as conversas (também aceita `&instanceId=1` para filtrar por número) |
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
- **Frontend** (`frontend/`): React 19 + Vite. Na imagem Docker ele é compilado e servido pelo próprio backend.

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
