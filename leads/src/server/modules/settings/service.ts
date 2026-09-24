import type { Kysely } from 'kysely';
import type { AdminSettings, AppConfig, MessageTemplate } from '../../../shared/api';
import type { Database, Settings } from '../../db/schema';

export async function getSettings(db: Kysely<Database>): Promise<Settings> {
  return db.selectFrom('settings').selectAll().where('id', '=', 1).executeTakeFirstOrThrow();
}

export async function listTemplates(db: Kysely<Database>): Promise<MessageTemplate[]> {
  const rows = await db
    .selectFrom('message_templates')
    .select(['id', 'name', 'body', 'is_default'])
    .orderBy('is_default', 'desc')
    .orderBy('sort')
    .orderBy('created_at')
    .execute();
  return rows.map((r) => ({ id: r.id, name: r.name, body: r.body, isDefault: r.is_default }));
}

export function logoUrl(s: Settings): string | null {
  return s.logo ? `/api/branding/logo?v=${s.logo_updated_at?.getTime() ?? 0}` : null;
}

export async function getAppConfig(db: Kysely<Database>): Promise<AppConfig> {
  const [s, templates] = await Promise.all([getSettings(db), listTemplates(db)]);
  return {
    companyName: s.company_name,
    logoUrl: logoUrl(s),
    pullSize: s.pull_size,
    maxQueue: s.max_queue,
    hourlyContactWarning: s.hourly_contact_warning,
    templates,
  };
}

export function toAdminSettings(s: Settings): AdminSettings {
  return {
    companyName: s.company_name,
    hasLogo: !!s.logo,
    pullSize: s.pull_size,
    maxQueue: s.max_queue,
    expireHours: s.expire_hours,
    hourlyContactWarning: s.hourly_contact_warning,
    defaultDdd: s.default_ddd,
    dailyPullLimit: s.daily_pull_limit,
  };
}
