import type { ColumnType, Generated, Insertable, Selectable } from 'kysely';
import type { ResultId } from '../../shared/results';
import type { Role } from '../../shared/roles';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;

export type LeadStatus = 'pendente' | 'chamado' | 'bloqueado';
export type AssignedVia = 'pegou' | 'importacao' | 'gestor' | 'retorno';
export type PhoneType = 'movel' | 'fixo';
export type ImportStatus = 'rascunho' | 'processando' | 'concluida' | 'falhou' | 'descartada';
export type Distribution = 'fila' | 'dividir' | 'pessoa';

export interface UsersTable {
  id: Generated<string>;
  name: string;
  email: string;
  password_hash: string | null;
  role: Role;
  active: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  last_login_at: Date | null;
  password_changed_at: Date | null;
  daily_pull_limit: ColumnType<number | null, number | null | undefined, number | null>;
}

export interface SessionsTable {
  id: string;
  user_id: string;
  csrf_token: string;
  created_at: Generated<Date>;
  last_seen_at: Generated<Date>;
  expires_at: Timestamp;
  ip: string | null;
  user_agent: string | null;
}

export interface PasswordTokensTable {
  id: string;
  user_id: string;
  purpose: 'convite' | 'redefinir';
  created_by: string | null;
  created_at: Generated<Date>;
  expires_at: Timestamp;
  used_at: NullableTimestamp;
}

export interface SettingsTable {
  id: Generated<number>;
  company_name: Generated<string>;
  logo: Buffer | null;
  logo_mime: string | null;
  logo_updated_at: NullableTimestamp;
  pull_size: Generated<number>;
  max_queue: Generated<number>;
  expire_hours: Generated<number>;
  hourly_contact_warning: Generated<number>;
  default_ddd: string | null;
  daily_pull_limit: Generated<number>;
  updated_at: Generated<Date>;
  updated_by: string | null;
}

export interface MessageTemplatesTable {
  id: Generated<string>;
  name: string;
  body: string;
  is_default: Generated<boolean>;
  sort: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ListsTable {
  id: Generated<string>;
  name: string;
  created_by: string | null;
  created_at: Generated<Date>;
  archived_at: NullableTimestamp;
  extra_columns: Generated<string[]>;
  total: Generated<number>;
  distribution: Distribution;
  source_file: string | null;
  import_id: string | null;
}

export interface LeadsTable {
  id: Generated<number>;
  list_id: string;
  row_number: number;
  name: Generated<string>;
  name_search: Generated<string>;
  company: Generated<string>;
  company_search: Generated<string>;
  phone: string;
  /** Calculado pelo banco a partir do telefone (só números brasileiros). */
  ddd: ColumnType<string | null, never, never>;
  phone_type: PhoneType | null;
  extra_phones: Generated<string[]>;
  extra: ColumnType<
    Record<string, string>,
    Record<string, string> | string | undefined,
    Record<string, string> | string
  >;
  status: Generated<LeadStatus>;
  assigned_to: string | null;
  assigned_at: NullableTimestamp;
  assigned_via: AssignedVia | null;
  whatsapp_opened_at: NullableTimestamp;
  called_by: string | null;
  called_at: NullableTimestamp;
  result: ResultId | null;
  note: string | null;
  callback_at: NullableTimestamp;
  anonymized_at: NullableTimestamp;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  version: Generated<number>;
}

export interface LeadEventsTable {
  id: Generated<number>;
  lead_id: number;
  user_id: string | null;
  type: string;
  data: ColumnType<
    Record<string, unknown>,
    Record<string, unknown> | string | undefined,
    Record<string, unknown> | string
  >;
  created_at: Generated<Date>;
}

export interface ImportsTable {
  id: Generated<string>;
  created_by: string | null;
  created_at: Generated<Date>;
  status: Generated<ImportStatus>;
  source: 'arquivo' | 'colado';
  file_name: string;
  file_sha256: string;
  file_size: number;
  file_data: Buffer | null;
  options: ColumnType<unknown, unknown, unknown> | null;
  summary: ColumnType<unknown, unknown, unknown> | null;
  list_id: string | null;
  error: string | null;
  started_at: NullableTimestamp;
  finished_at: NullableTimestamp;
}

export interface ImportRejectionsTable {
  import_id: string;
  row_number: number;
  reason: string;
  values: string[];
}

export interface BlockedPhonesTable {
  phone: string;
  reason: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface AuditLogTable {
  id: Generated<number>;
  user_id: string | null;
  action: string;
  entity: string | null;
  entity_id: string | null;
  details: ColumnType<Record<string, unknown>, Record<string, unknown> | string | undefined, never>;
  ip: string | null;
  created_at: Generated<Date>;
}

export interface WhatsappWebhookEventsTable {
  id: Generated<number>;
  received_at: Generated<Date>;
  payload: ColumnType<unknown, unknown, unknown>;
}

export interface Database {
  users: UsersTable;
  sessions: SessionsTable;
  password_tokens: PasswordTokensTable;
  settings: SettingsTable;
  message_templates: MessageTemplatesTable;
  lists: ListsTable;
  leads: LeadsTable;
  lead_events: LeadEventsTable;
  imports: ImportsTable;
  import_rejections: ImportRejectionsTable;
  blocked_phones: BlockedPhonesTable;
  audit_log: AuditLogTable;
  whatsapp_webhook_events: WhatsappWebhookEventsTable;
}

export type User = Selectable<UsersTable>;
export type Lead = Selectable<LeadsTable>;
export type NewLead = Insertable<LeadsTable>;
export type Settings = Selectable<SettingsTable>;
