# Central de WhatsApp

Sistema web próprio que junta, num só lugar, as conversas de vários números de WhatsApp conectados pela
[Evolution API](https://github.com/evolution-foundation/evolution-api) (versão fixa **v2.3.7**).

O plano completo e as decisões estão em [`docs/PLANO.md`](docs/PLANO.md).

## O que já existe (Fase 1: infraestrutura)

| Serviço | Para quê |
|---|---|
| `evolution` | Conecta os números de WhatsApp (1 instância por número) |
| `postgres` | Banco `evolution` (usado pela Evolution) e banco `central` (usado pelo nosso sistema a partir da Fase 2) |
| `redis` | Cache da Evolution |

A Evolution só fica acessível no próprio computador (`127.0.0.1:8080`), nunca pela rede.

## Como rodar no Windows

Pré-requisitos: **Docker Desktop** aberto e **Git** instalado. Os comandos abaixo são para o **PowerShell**.

### 1. Baixar o projeto (só na primeira vez)

```powershell
git clone https://github.com/glayvisondouglas97-code/tech.git central-whatsapp
cd central-whatsapp
git checkout claude/whatsapp-evolution-central-dzt5ar
```

Nas próximas vezes, para pegar atualizações, entre na pasta e rode:

```powershell
git pull
```

### 2. Criar o arquivo de senhas `.env` (só na primeira vez)

```powershell
Copy-Item .env.example .env
[guid]::NewGuid().ToString("N")
[guid]::NewGuid().ToString("N")
```

Os dois últimos comandos geram duas senhas aleatórias. Abra o arquivo com `notepad .env`, cole uma em
`POSTGRES_PASSWORD` e a outra em `EVOLUTION_API_KEY`, e salve.
Guarde a `EVOLUTION_API_KEY`: você vai usá-la no passo 5.

> O `.env` nunca vai para o GitHub (está no `.gitignore`).

### 3. Subir os serviços

```powershell
docker compose up -d
```

Na primeira vez ele baixa as imagens, o que leva alguns minutos. Para acompanhar a Evolution iniciando:

```powershell
docker compose logs -f evolution
```

Espere aparecer `HTTP - ON: 8080` e aperte `Ctrl + C` para sair dos logs. Os serviços continuam rodando.

### 4. Conferir se está no ar

Abra no navegador: <http://localhost:8080>

Deve aparecer um texto com `"Welcome to the Evolution API, it is working!"` e `"version":"2.3.7"`.

### 5. Conectar um número (manualmente, pelo painel da Evolution)

1. Abra <http://localhost:8080/manager>.
2. Preencha **URL do Servidor** (*Server URL*) com `http://localhost:8080` e **Chave de API Global**
   (*API Key Global*) com a sua `EVOLUTION_API_KEY`. Depois clique em **Conectar**.
3. Clique em **Instância +** (*Nova Instância*):
   - **Nome**: `whatsapp-01` (sem espaços; o apelido bonito vem na Fase 5);
   - **Canal**: `Baileys`;
   - **Token** e **Número**: deixe como estão.

   Depois clique em **Salvar**.
4. Abra a instância criada e clique em **Gerar QR Code**.
5. No celular, abra o WhatsApp:
   - Android: **⋮** → **Dispositivos conectados** → **Conectar dispositivo**;
   - iPhone: **Configurações** → **Dispositivos conectados** → **Conectar dispositivo**.

   Então escaneie o QR Code.
6. O status da instância deve mudar para conectado (*open* / *Connected*).

Para conferir pelo PowerShell (troque `SUA_CHAVE` pela sua `EVOLUTION_API_KEY`):

```powershell
Invoke-RestMethod http://localhost:8080/instance/connectionState/whatsapp-01 -Headers @{ apikey = "SUA_CHAVE" }
```

A resposta deve conter `state = open`.

### 6. Conferir se a conexão sobrevive a um reinício

```powershell
docker compose restart evolution
```

Espere uns 30 segundos e rode de novo o comando `Invoke-RestMethod` do passo anterior. O resultado deve continuar
`open`, **sem** precisar escanear o QR Code outra vez.

## Comandos úteis

| Comando | O que faz |
|---|---|
| `docker compose ps` | Mostra o que está rodando |
| `docker compose logs -f evolution` | Acompanha os logs da Evolution (`Ctrl + C` para sair) |
| `docker compose down` | Para tudo. **Os dados continuam salvos** |
| `docker compose up -d` | Sobe tudo de novo |

> ⚠️ **Nunca** rode `docker compose down -v`: o `-v` apaga os volumes, ou seja, o banco de dados e as sessões
> dos números. Seria preciso escanear todos os QR Codes de novo.

## Problemas comuns

- **`defina POSTGRES_PASSWORD no arquivo .env`**: o arquivo `.env` não existe ou está sem esse valor (passo 2).
- **Porta 8080 já em uso**: outro programa está usando a porta. Feche o programa ou me avise para trocarmos a porta.
- **Troquei a senha do Postgres no `.env` depois de já ter subido**: o banco continua com a senha antiga. Volte a
  senha antiga no `.env` ou me peça ajuda.
