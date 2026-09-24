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
| `app` | Nosso backend: recebe os webhooks, grava contatos, conversas e mensagens, envia respostas |

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

### 4. Conectar um número

1. Abra <http://localhost:8080/manager>.
2. Preencha **URL do Servidor** (*Server URL*) com `http://localhost:8080` e **Chave de API Global**
   (*API Key Global*) com a sua `EVOLUTION_API_KEY`.
3. Clique em **Instância +**:
   - **Nome** sem espaços, ex.: `whatsapp-01`;
   - **Canal**: `Baileys`.

   Depois clique em **Salvar**.
4. Abra a instância, clique em **Gerar QR Code** e escaneie no celular: WhatsApp → **Dispositivos conectados**
   → **Conectar dispositivo**.

O backend configura sozinho, em cada número, o webhook, a opção de ignorar grupos e a opção de não marcar como lida
automaticamente. **Não altere essas opções no painel da Evolution.** A Fase 5 vai trazer uma tela própria de números.

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
| `POST /api/instances/NOME/import-history` | Reimporta o histórico dos últimos 14 dias de um número |

## Comandos úteis

| Comando | O que faz |
|---|---|
| `docker compose ps` | Mostra o que está rodando |
| `docker compose logs -f app` | Acompanha os logs do backend (`Ctrl + C` para sair) |
| `docker compose logs -f evolution` | Acompanha os logs da Evolution |
| `docker compose down` | Para tudo. **Os dados continuam salvos** |
| `docker compose up -d` | Sobe tudo de novo |

> ⚠️ **Nunca** rode `docker compose down -v`: o `-v` apaga os volumes, ou seja, o banco de dados e as sessões
> dos números. Seria preciso escanear todos os QR Codes de novo.

## Problemas comuns

- **`defina WEBHOOK_TOKEN no arquivo .env`** (ou outra variável): falta essa linha no `.env` (passo 2).
- **`'Invoke-RestMethod' não é reconhecido`**: você está no Prompt de Comando (cmd). Abra o PowerShell.
- **`ports are not available` / `bind` na porta 3100**: outro programa usa a porta. Adicione `APP_PORT=3200` (ou outro
  número) no `.env` e rode `docker compose up -d` de novo. Na porta 8080 (Evolution), me avise.
- **Troquei a senha do Postgres no `.env` depois de já ter subido**: o banco continua com a senha antiga. Volte a
  senha antiga no `.env` ou me peça ajuda.

## Desenvolvimento (backend)

O backend é Node 24 + TypeScript, rodando o `.ts` direto (sem etapa de compilação), com Express e Prisma 7.

```powershell
cd backend
npm install
npm test          # testes das regras de mensagens (@lid, grupos, tipos, status)
npm run check     # verificação de tipos
```
