import { fileURLToPath } from 'node:url';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variável de ambiente ${name} não definida`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required('DATABASE_URL'),
  evolutionUrl: required('EVOLUTION_URL').replace(/\/$/, ''),
  evolutionApiKey: required('EVOLUTION_API_KEY'),
  // Endereço em que a Evolution entrega os webhooks (rede interna do Docker).
  webhookUrl: required('WEBHOOK_URL'),
  webhookToken: required('WEBHOOK_TOKEN'),
  // Quantos dias de histórico importar ao conectar um número.
  historyDays: Number(process.env.HISTORY_DAYS ?? 14),
  // Pasta das mídias (áudios, imagens, documentos). No Docker é um volume próprio.
  mediaDir: process.env.MEDIA_DIR ?? fileURLToPath(new URL('../media', import.meta.url)),
};
