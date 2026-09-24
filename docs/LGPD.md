# LGPD: o que o sistema faz

**Dados tratados:** nome, telefone e colunas extras das planilhas importadas; resultado dos contatos e observações; conversas de WhatsApp (mensagens, áudios, imagens e documentos); dados de login da equipe.

## Minimização e acesso
- Atendente recebe do servidor só os leads da fila dele e os que ele chamou. Supervisor e administrador veem tudo.
- Senhas com Argon2id; tokens de sessão e de convite guardados só como hash.
- Sessão em cookie `HttpOnly`, `SameSite=Lax` (e `Secure` com HTTPS), expira após 7 dias sem uso (máximo 30).
- Proteção CSRF (token por sessão + conferência de origem), limite de tentativas de login, cabeçalhos de segurança (CSP, HSTS com HTTPS).
- Fontes da interface servidas pelo próprio sistema (sem Google Fonts, que enviaria o IP da equipe ao Google).
- Exportações (CSV/Excel) só para supervisor e administrador, e ficam registradas.

## Registro de acessos e ações (Configurações › Registro de ações)
Login (e tentativas erradas), saída, troca de senha, convites, alterações de usuários, importação, arquivamento/exclusão de listas, exportações, configurações, bloqueios e toda ação sobre dados de titulares. O registro guarda quem, o quê, quando e o IP, sem copiar nome/telefone do lead (telefones aparecem mascarados). Retenção: 2 anos.

## Direitos do titular (Configurações › Privacidade)
Pelo telefone, o administrador pode:
- **Consultar** e **baixar** tudo o que existe sobre a pessoa (JSON com registros, histórico e mensagens de WhatsApp) — acesso e portabilidade.
- **Anonimizar:** apaga nome, telefone, colunas extras, observações, cópias cruas (linhas rejeitadas de importação) e as conversas de WhatsApp (mensagens e arquivos); mantém só os números agregados.
- **Excluir** de vez os registros, o histórico e as conversas de WhatsApp (mensagens e arquivos).
- Em ambos, opção de manter o número na lista de **não contatar** (recomendado, para honrar o pedido em importações futuras).
- Atendentes podem marcar "Não quer contato" na hora; o número nunca mais entra na fila.

## Retenção automática
- Arquivo de importação: apagado ao concluir (rascunhos abandonados em 1 dia; falhas em 7 dias).
- Linhas recusadas de importação: 90 dias.
- Sessões expiradas e links de senha usados/vencidos: removidos periodicamente.
- Leads e conversas de WhatsApp: ficam até a empresa arquivar/excluir a lista ou atender pedido do titular. Defina uma política (ex.: excluir listas com mais de 12 meses) e use **Listas › Excluir**.

## O que cabe à empresa
- Base legal para contatar os leads (ex.: consentimento ou legítimo interesse) e aviso de privacidade.
- Contrato de operador com a hospedagem do VPS (verifique os termos de processamento de dados do provedor).
- Canal para pedidos de titulares e prazo de resposta.
