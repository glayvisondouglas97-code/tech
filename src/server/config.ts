import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v === '' ? def : ['1', 'true', 'sim', 'yes', 'on'].includes(v.toLowerCase()),
    );

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().min(1, 'Defina DATABASE_URL com o endereço do Postgres.'),
  APP_URL: z
    .string()
    .url('APP_URL precisa ser um endereço completo, como https://leads.suaempresa.com.br')
    .default('http://localhost:5173')
    .transform((v) => v.replace(/\/+$/, '')),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  SETUP_TOKEN: z
    .string()
    .optional()
    .transform((v) => (v?.trim() ? v.trim() : null)),
  MIGRATE_ON_START: bool(true),
  JOBS_ENABLED: bool(true),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: bool(false),
  /** Pasta com o front-end compilado. Vazio = não serve arquivos estáticos (modo desenvolvimento). */
  WEB_DIST: z.string().optional(),
  // ---------- WhatsApp pela Evolution API ----------
  /** Endereço da Evolution (rede interna do Docker). Vazio = sem WhatsApp (ex.: testes). */
  EVOLUTION_URL: z
    .string()
    .optional()
    .transform((v) => (v?.trim() ? v.trim().replace(/\/+$/, '') : null)),
  EVOLUTION_API_KEY: z.string().default(''),
  /** Endereço em que a Evolution entrega os webhooks (rede interna do Docker). */
  WEBHOOK_URL: z.string().default('http://app:3000/webhook/evolution'),
  /** Token secreto que a Evolution manda em cada webhook. */
  WEBHOOK_TOKEN: z.string().default(''),
  /** Pasta das mídias (áudios, imagens, documentos). No Docker é um volume próprio. */
  MEDIA_DIR: z.string().default('media'),
  /** Quantos dias de histórico importar ao conectar um número. */
  HISTORY_DAYS: z.coerce.number().int().min(1).max(90).default(14),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Na Render e na Railway o endereço público vem da própria hospedagem.
  const hostUrl =
    env.RENDER_EXTERNAL_URL ||
    (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : undefined);
  const parsed = schema.safeParse({ ...env, APP_URL: env.APP_URL || hostUrl });
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuração inválida:\n${msg}`);
  }
  const cfg = parsed.data;
  if (cfg.EVOLUTION_URL && (!cfg.EVOLUTION_API_KEY || cfg.WEBHOOK_TOKEN.length < 16)) {
    throw new Error(
      'Com EVOLUTION_URL definido, defina também EVOLUTION_API_KEY e WEBHOOK_TOKEN (pelo menos 16 caracteres).',
    );
  }
  return cfg;
}

export function isSecureUrl(cfg: Config): boolean {
  return cfg.APP_URL.startsWith('https://');
}
