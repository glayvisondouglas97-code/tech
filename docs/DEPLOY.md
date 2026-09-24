# Colocar a Central no VPS (domínio + HTTPS)

Este guia instala o sistema num VPS com Ubuntu, com o endereço `https://whats.suaempresa.com.br` (troque pelo seu
domínio em todos os comandos). O HTTPS é automático: o **Caddy** pede e renova o certificado sozinho.

**O que você precisa:**
- Um VPS com **Ubuntu 24.04** (ou 22.04), **2 vCPU, 4 GB de RAM e 40 GB de disco** ou mais.
- O **IP** do VPS e o acesso **SSH**: usuário `root` (ou outro com `sudo`) e a senha ou chave.
- Acesso ao painel do seu **domínio** (Registro.br, Cloudflare, Hostinger etc.).

## 1. Apontar o domínio para o VPS

No painel do domínio, crie um registro **A**:

| Tipo | Nome | Valor |
|---|---|---|
| A | `whats` | IP do VPS |

- Se o domínio estiver na **Cloudflare**, deixe a nuvem **cinza** ("somente DNS"). Com a nuvem laranja, o Caddy não
  consegue emitir o certificado.
- Pode levar de alguns minutos a algumas horas para valer. Para conferir, no PowerShell do seu computador:
  `nslookup whats.suaempresa.com.br`. Tem que aparecer o IP do VPS.

## 2. Entrar no VPS

No PowerShell do seu computador:

```powershell
ssh root@IP_DO_VPS
```

Os próximos comandos são digitados **dentro do VPS**.

## 3. Instalar o Docker e liberar só as portas necessárias

```bash
curl -fsSL https://get.docker.com | sh
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
```

Só as portas 80 e 443 (Caddy) ficam abertas na internet. A Evolution, o banco e o backend só aceitam conexões de
dentro do próprio servidor. Se o provedor do VPS tiver um firewall no painel dele, libere lá também as portas 80 e 443.

## 4. Baixar o projeto

O repositório é privado, então o GitHub vai pedir um **token** no lugar da senha. Para criar:
GitHub → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** →
**Generate new token**. Em *Repository access*, escolha só o repositório `tech`. Em *Permissions*, dê
**Contents: Read-only**. Copie o token gerado.

```bash
git clone https://github.com/glayvisondouglas97-code/tech.git /opt/central-whatsapp
cd /opt/central-whatsapp
git checkout claude/whatsapp-evolution-central-dzt5ar
```

Quando pedir *Username*, digite o seu usuário do GitHub. Em *Password*, cole o token.

## 5. Criar o arquivo `.env` (senhas novas, só do VPS)

Troque `whats.suaempresa.com.br` pelo seu endereço antes de rodar:

```bash
cp .env.example .env
sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 16)/; s/^EVOLUTION_API_KEY=.*/EVOLUTION_API_KEY=$(openssl rand -hex 16)/; s/^WEBHOOK_TOKEN=.*/WEBHOOK_TOKEN=$(openssl rand -hex 16)/" .env
echo "DOMAIN=whats.suaempresa.com.br" >> .env
echo "COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml" >> .env
cat .env
```

O `cat` mostra o arquivo pronto: três senhas aleatórias, o `DOMAIN` e o `COMPOSE_FILE`. Esta última linha faz o
`docker compose` usar também o Caddy (HTTPS). **Guarde uma cópia desse arquivo em lugar seguro**, porque sem ele os
backups do banco não abrem.

## 6. Subir o sistema

```bash
docker compose up -d --build
docker compose ps
docker compose logs caddy --tail 30
```

A primeira vez leva alguns minutos. No log do Caddy, procure `certificate obtained successfully`. Depois disso, abra
**https://whats.suaempresa.com.br** no navegador: deve aparecer a tela de login, com o cadeado de site seguro.

## 7. Criar o primeiro acesso

```bash
docker compose exec app node src/cli.ts criar-admin "Seu Nome" voce@email.com
```

Entre no site com o e-mail e a senha provisória mostrada. Depois:
1. troque a senha em **Minha senha** (clique no círculo com as suas iniciais, no canto de baixo à esquerda);
2. cadastre a equipe em **Usuários** → **Adicionar pessoa**.

## 8. Conectar os números (e desligar o sistema do seu computador)

1. No seu computador, **pare o sistema local** para ele não disputar os números com o VPS. No PowerShell, dentro da
   pasta do projeto, rode `docker compose down`.
2. Em cada celular: WhatsApp → **Dispositivos conectados** → toque no aparelho **Central WhatsApp** antigo →
   **Desconectar**.
3. No site do VPS: **Números** → **Adicionar número** → digite o apelido → **Criar e conectar** → escaneie o QR Code
   com cada celular.

O histórico dos últimos 14 dias de cada número é importado sozinho ao conectar.

Para a equipe usar no celular, basta abrir o endereço `https://` no navegador do celular e adicionar à tela inicial
(passo a passo no [README](../README.md#no-celular)).

## 9. Backups

O backup roda todo dia às 3h e fica em `/opt/central-whatsapp/backups` (últimos 7 dias). Como ele fica no mesmo
servidor, **copie a pasta para o seu computador de vez em quando** (ex.: toda semana). No PowerShell do seu computador:

```powershell
scp -r root@IP_DO_VPS:/opt/central-whatsapp/backups C:\Users\D7\Desktop\backups-central
```

Se o provedor do VPS oferecer **backup/snapshot automático** do servidor, vale ativar também.

Para restaurar, os comandos estão no [README](../README.md#backup). No VPS eles são os mesmos, dentro de
`/opt/central-whatsapp`.

## 10. Atualizar o sistema no VPS

```bash
cd /opt/central-whatsapp
git pull
docker compose up -d --build
```

## Painel da Evolution no VPS (só para emergências)

Ele não fica aberto na internet. Para acessar, abra um "túnel" pelo PowerShell do seu computador e deixe essa janela
aberta:

```powershell
ssh -L 8080:localhost:8080 root@IP_DO_VPS
```

Então abra <http://localhost:8080/manager> no navegador. A chave é a `EVOLUTION_API_KEY` do `.env` do VPS.

## Problemas comuns

- **O site não abre ou dá erro de certificado:**
  - confira se o `nslookup` mostra o IP do VPS (passo 1);
  - confira se as portas 80/443 estão liberadas no painel do provedor;
  - na Cloudflare, confira se a nuvem está cinza.

  Veja o motivo em `docker compose logs caddy --tail 50`.
- **`defina DOMAIN no arquivo .env`**: faltou a linha `DOMAIN=` (passo 5).
- **Ver se falta memória:** `free -h` e `docker stats --no-stream`.
- **Esqueci a senha de administrador:** `docker compose exec app node src/cli.ts redefinir-senha voce@email.com`.
