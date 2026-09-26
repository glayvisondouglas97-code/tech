import type { ColumnType, Generated, Insertable, Selectable } from 'kysely';
import type { AutomationCondition } from '../../shared/api';
import type {
  AutomationActionType,
  AutomationAudioMode,
  AutomationRunStatus,
  AutomationStatus,
  AutomationStepRunStatus,
  AutomationTrigger,
  CampaignStatus,
} from '../../shared/automations';
import type { CampaignFilters } from '../../shared/campaign-plan';
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

// ---------- WhatsApp (Evolution API) ----------

export interface WaInstancesTable {
  id: Generated<number>;
  /** Nome da instância na Evolution (ex.: whatsapp-01). */
  name: string;
  /** Apelido exibido (ex.: "WhatsApp 3 - João"). */
  nickname: string | null;
  /** Número conectado (ex.: 5511999999999@s.whatsapp.net). */
  phone_jid: string | null;
  /** open | connecting | close */
  status: Generated<string>;
  /** Responsável pelo número: o atendente só vê as conversas dos números dele. */
  owner_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface WaContactsTable {
  id: Generated<number>;
  phone_jid: string | null;
  lid_jid: string | null;
  /** Nome do perfil do WhatsApp (pushName). */
  name: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface WaConversationsTable {
  id: Generated<number>;
  instance_id: number;
  contact_id: number;
  unread_count: Generated<number>;
  /** O contato já mandou alguma mensagem (aba "Responderam"). */
  lead_replied: Generated<boolean>;
  /** Vazio enquanto a conversa não tem mensagens (aberta pelo "Chamar" do lead, ainda sem nada enviado). */
  last_message_at: NullableTimestamp;
  last_message_preview: string | null;
  last_message_from_me: Generated<boolean>;
  /** Lead chamado por esta conversa (marca sozinho "Mensagem enviada" e "Respondeu"). */
  lead_id: number | null;
  created_at: Generated<Date>;
  /** Quando um envio segurou a vaga do PRIMEIRO contato desta conversa (um contato novo gasta uma vaga só). */
  contact_claimed_at: Generated<Date | null>;
}

/** Mensagem apagada pelo sistema: a importação de histórico e os webhooks repetidos não a trazem de volta. */
export interface WaDeletedMessagesTable {
  instance_id: number;
  wa_id: string;
  deleted_at: Generated<Date>;
}

/**
 * Biblioteca de áudios do "Chamar": várias versões da mesma mensagem, sorteadas na hora do envio.
 * O arquivo fica na pasta de mídias (audios/<id>.<ext>).
 */
export interface WaAudiosTable {
  id: Generated<number>;
  /** Nome para a equipe reconhecer (ex.: "Apresentação — 20s"). */
  label: string;
  /** Caminho do arquivo, relativo à pasta de mídias. */
  media_path: string;
  media_mime: string;
  /** Duração aproximada em segundos (informada pelo navegador ao salvar). */
  seconds: number | null;
  bytes: number;
  /** Só os ativos entram no sorteio. */
  active: Generated<boolean>;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface WaMessagesTable {
  id: Generated<number>;
  instance_id: number;
  conversation_id: number;
  /** ID da mensagem no WhatsApp (key.id): evita duplicar webhooks repetidos. */
  wa_id: string;
  remote_jid: string;
  from_me: boolean;
  /** text | image | video | audio | document | sticker | reaction | other */
  type: string;
  text: string | null;
  file_name: string | null;
  media_mime: string | null;
  /** Arquivo no volume de mídias (relativo à pasta de mídias); null = ainda não baixado. */
  media_path: string | null;
  /** PENDING | SERVER_ACK | DELIVERY_ACK | READ | PLAYED | ERROR */
  status: string | null;
  sent_at: Timestamp;
  /** Quem enviou pelo sistema (null = recebida ou enviada pelo celular). */
  sent_by: string | null;
  created_at: Generated<Date>;
}

// ---------- Automações ----------

/** A automação em si. Arquivada = status "archived" e archived_at preenchido (nada é apagado). */
export interface AutomationsTable {
  id: Generated<number>;
  name: string;
  description: string | null;
  status: Generated<AutomationStatus>;
  trigger_type: AutomationTrigger;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  archived_at: NullableTimestamp;
  /** Automação criada e mantida pelo próprio sistema (ex.: a campanha automática). Vazio nas demais. */
  system_key: Generated<string | null>;
}

/** Uma etapa da automação, na ordem de `position` (a partir de 1). */
export interface AutomationStepsTable {
  id: Generated<number>;
  automation_id: number;
  position: number;
  action_type: AutomationActionType;
  /** Espera antes de agir, em segundos (0 = imediatamente). */
  delay_seconds: Generated<number>;
  /** Texto enviado (obrigatório em "send_text"). */
  message_text: string | null;
  /** Áudio da biblioteca (wa_audios) enviado em "send_audio". Vazio se o áudio foi excluído. */
  audio_id: number | null;
  /** "fixed" (o áudio escolhido) ou "random" (sorteia entre os áudios ativos da biblioteca). */
  audio_mode: Generated<AutomationAudioMode>;
  /** Condições da etapa, em JSON (só guardadas por enquanto). Grava-se como texto JSON: array puro vai errado no pg. */
  conditions: ColumnType<AutomationCondition[], string | undefined, string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** A participação de um lead numa automação. */
export interface AutomationRunsTable {
  id: Generated<number>;
  automation_id: number;
  lead_id: number;
  /** Número de WhatsApp pelo qual a automação fala com o lead (vazio se o número foi excluído). */
  instance_id: number | null;
  /** Quem chamou o lead (ou iniciou a execução manual). */
  started_by: string | null;
  /** Campanha que criou a participação (vazio: veio do "Chamar" ou da execução manual). */
  campaign_id: number | null;
  /** Dia (em São Paulo) em que a participação ocupou uma vaga do número. Só nas de campanha. */
  slot_date: ColumnType<string | null, string | null | undefined, string | null>;
  status: Generated<AutomationRunStatus>;
  /** Posição da etapa em andamento (a próxima a executar). */
  current_step: Generated<number>;
  started_at: NullableTimestamp;
  completed_at: NullableTimestamp;
  cancelled_at: NullableTimestamp;
  cancel_reason: string | null;
  /** Quando a etapa em andamento deve agir. */
  next_run_at: NullableTimestamp;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** Histórico de cada tentativa de uma etapa numa participação. */
export interface AutomationStepRunsTable {
  id: Generated<number>;
  automation_run_id: number;
  /** Vazio se a etapa foi apagada depois. */
  step_id: number | null;
  status: Generated<AutomationStepRunStatus>;
  scheduled_at: Timestamp;
  started_at: NullableTimestamp;
  finished_at: NullableTimestamp;
  attempts: Generated<number>;
  error: string | null;
  /** Mensagem enviada por esta etapa (vazio se ainda não enviou ou se a mensagem foi apagada). */
  message_id: number | null;
  /** Áudio usado nesta tentativa (escolhido e gravado ANTES do envio) e o nome dele, que sobrevive à exclusão. */
  audio_id: number | null;
  audio_label: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** Uma campanha: iniciar uma automação para os leads de uma lista, pelos números escolhidos. */
export interface AutomationCampaignsTable {
  id: Generated<number>;
  automation_id: number;
  list_id: string | null;
  status: Generated<CampaignStatus>;
  /** Números permitidos. Vazio quando `all_numbers` (todos os cadastrados, lidos a cada ciclo). */
  instance_ids: number[];
  /** O público é a fila livre de todas as listas não arquivadas (sem `list_id`). */
  all_lists: Generated<boolean>;
  /** Os números são todos os cadastrados (número novo entra sozinho). */
  all_numbers: Generated<boolean>;
  /** Janela de envio em minutos desde a meia-noite de São Paulo: [início, fim). */
  window_start_min: number;
  window_end_min: number;
  /** Novos leads por número por dia. */
  daily_limit: number;
  /**
   * Datas no calendário de São Paulo (o driver devolve `Date` para o tipo date: use `ymd()` de `window.ts`, nunca o fuso
   * do navegador). Antes de `start_date` a campanha está agendada; depois de `end_date` não cria mais primeiros contatos.
   */
  start_date: ColumnType<Date, string, string>;
  end_date: ColumnType<Date | null, string | null, string | null>;
  /** Dias em que executa (ISO: 1 = segunda ... 7 = domingo). */
  days_of_week: ColumnType<number[], number[] | undefined, number[]>;
  /** Depois de um primeiro contato automático, nova abordagem independente só depois deste tempo (0 = sem cooldown). */
  cooldown_hours: Generated<number>;
  /** Filtros opcionais do público (JSONB). Grava-se como texto JSON. */
  filters: ColumnType<CampaignFilters, string | undefined, string>;
  started_by: string | null;
  started_at: Generated<Date>;
  ended_at: NullableTimestamp;
  end_reason: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** "Saco embaralhado" do rodízio de áudios, por escopo (campanha, automação ou número do Chamar). */
/**
 * Cota diária de contatos por número (manual + automático), uma linha por número e por dia de São Paulo.
 * `uncertain_contacts` = envio em andamento ou de resultado incerto (ocupa a vaga, mas ainda não é manual/automático).
 * Trava do banco: `total_contacts <= 20`. Ver a migração 0013.
 */
export interface WaInstanceDailyUsageTable {
  id: Generated<number>;
  instance_id: number;
  /** Dia em São Paulo. Como o driver devolve `Date` para este tipo, leia com `usage_date::text`. */
  usage_date: ColumnType<string, string, string>;
  manual_contacts: Generated<number>;
  automatic_contacts: Generated<number>;
  uncertain_contacts: Generated<number>;
  total_contacts: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface WaAudioBagsTable {
  scope: string;
  /** Áudios que ainda faltam sair neste ciclo, na ordem em que saem. */
  remaining: Generated<number[]>;
  last_audio_id: number | null;
  updated_at: Generated<Date>;
}

export interface Database {
  users: UsersTable;
  sessions: SessionsTable;
  password_tokens: PasswordTokensTable;
  settings: SettingsTable;
  lists: ListsTable;
  leads: LeadsTable;
  lead_events: LeadEventsTable;
  imports: ImportsTable;
  import_rejections: ImportRejectionsTable;
  blocked_phones: BlockedPhonesTable;
  audit_log: AuditLogTable;
  wa_instances: WaInstancesTable;
  wa_contacts: WaContactsTable;
  wa_conversations: WaConversationsTable;
  wa_messages: WaMessagesTable;
  wa_deleted_messages: WaDeletedMessagesTable;
  wa_audios: WaAudiosTable;
  automations: AutomationsTable;
  automation_steps: AutomationStepsTable;
  automation_runs: AutomationRunsTable;
  automation_step_runs: AutomationStepRunsTable;
  automation_campaigns: AutomationCampaignsTable;
  wa_audio_bags: WaAudioBagsTable;
  wa_instance_daily_usage: WaInstanceDailyUsageTable;
}

export type User = Selectable<UsersTable>;
export type Lead = Selectable<LeadsTable>;
export type NewLead = Insertable<LeadsTable>;
export type Settings = Selectable<SettingsTable>;
export type WaInstance = Selectable<WaInstancesTable>;
export type WaContact = Selectable<WaContactsTable>;
export type WaConversation = Selectable<WaConversationsTable>;
export type WaMessage = Selectable<WaMessagesTable>;
export type WaAudio = Selectable<WaAudiosTable>;
export type Automation = Selectable<AutomationsTable>;
export type AutomationStep = Selectable<AutomationStepsTable>;
export type AutomationRun = Selectable<AutomationRunsTable>;
export type AutomationStepRun = Selectable<AutomationStepRunsTable>;
export type AutomationCampaign = Selectable<AutomationCampaignsTable>;
