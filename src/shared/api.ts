/** Formatos trocados entre o servidor e a interface. */
import type {
  AutomationActionType,
  AutomationAudioMode,
  AutomationConditionOperator,
  AutomationRunStatus,
  AutomationStatus,
  AutomationStepRunStatus,
  AutomationTrigger,
  CampaignStatus,
} from './automations';
import type {
  CalendarDay,
  CampaignAudience,
  CampaignEstimate,
  CampaignFilters,
  CampaignScheduleInfo,
  CampaignStats,
} from './campaign-plan';
import type { ResultId } from './results';
import type { Role } from './roles';

export interface UserRef {
  id: string;
  name: string;
}

export interface Me {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export interface SessionInfo {
  user: Me;
  csrfToken: string;
}

/** Configuração que todo usuário logado recebe. */
export interface AppConfig {
  companyName: string;
  logoUrl: string | null;
  pullSize: number;
  maxQueue: number;
  hourlyContactWarning: number;
  /** WhatsApp pela Evolution ligado (conversas e números). */
  whatsapp?: boolean;
}

export interface AdminSettings {
  companyName: string;
  hasLogo: boolean;
  pullSize: number;
  maxQueue: number;
  expireHours: number;
  hourlyContactWarning: number;
  defaultDdd: string | null;
  /** Limite diário padrão de leads que cada atendente pode pegar (0 = sem limite). */
  dailyPullLimit: number;
}

export type LeadStatus = 'pendente' | 'chamado' | 'bloqueado';

export interface LeadItem {
  id: number;
  version: number;
  /** Nome da empresa (os leads são pessoa jurídica). */
  company: string;
  /** Nome do sócio / proprietário. */
  name: string;
  phone: string;
  ddd: string | null;
  phoneDisplay: string;
  phoneType: 'movel' | 'fixo' | null;
  extraPhones: { phone: string; display: string }[];
  extra: Record<string, string>;
  list: { id: string; name: string; archived: boolean };
  status: LeadStatus;
  assignedTo: UserRef | null;
  assignedAt: string | null;
  whatsappOpenedAt: string | null;
  calledBy: UserRef | null;
  calledAt: string | null;
  result: ResultId | null;
  note: string | null;
  callbackAt: string | null;
  anonymized: boolean;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface QueueResponse {
  items: LeadItem[];
  total: number;
  callbacks: LeadItem[];
  /** DDDs presentes na fila do atendente (para o filtro). */
  ddds: DddCount[];
}

export interface DddCount {
  ddd: string;
  count: number;
}

export interface QueueStats {
  minhaFila: number;
  chameiHoje: number;
  semWhatsappHoje: number;
  livres: number;
  retornosHoje: number;
  /** Máximo de leads por pedido. */
  pullSize: number;
  maxQueue: number;
  /** Leads que o atendente pegou hoje e o limite diário dele (0 = sem limite). */
  pegouHoje: number;
  limiteDiario: number;
}

export interface LeadEvent {
  id: number;
  type: string;
  user: UserRef | null;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface LeadDetail {
  lead: LeadItem;
  events: LeadEvent[];
}

export interface PullResult {
  count: number;
  leads: LeadItem[];
}

export interface WhatsappOpenResult {
  ok: true;
  /** Aviso quando o atendente abriu muitas conversas na última hora. */
  warning: string | null;
}

// ---------- Painel ----------

export interface AttendantStats {
  user: UserRef & { role: Role; active: boolean };
  hoje: number;
  d7: number;
  d30: number;
  total: number;
  interessados: number;
  fechados: number;
  semWhatsapp: number;
  /** Fechados ÷ chamados (sem contar "Sem WhatsApp"), em %. null se não chamou ninguém. */
  conversao: number | null;
  fila: number;
  /** Últimos 14 dias, do mais antigo para hoje: chamados e "sem WhatsApp" por dia. */
  spark: { chamados: number[]; semWhatsapp: number[] };
}

export interface ListProgress {
  id: string;
  name: string;
  createdAt: string;
  archived: boolean;
  total: number;
  /** Empresas diferentes na lista e telefones (principal + extras). */
  empresas: number;
  telefones: number;
  chamados: number;
  semWhatsapp: number;
  comAtendentes: number;
  livres: number;
  /** Empresas que ainda têm lead na fila livre (faltam pegar). */
  empresasLivres: number;
  bloqueados: number;
}

export interface Dashboard {
  totals: {
    leads: number;
    chamados: number;
    semWhatsapp: number;
    comAtendentes: number;
    livres: number;
    bloqueados: number;
    hoje: number;
    listas: number;
  };
  perAttendant: AttendantStats[];
  results: { result: ResultId; count: number }[];
  lists: ListProgress[];
  daily: { day: string; count: number; semWhatsapp: number }[];
  stale: { count: number; hours: number };
  generatedAt: string;
}

// ---------- Importação ----------

export interface ImportColumn {
  index: number;
  letter: string;
  label: string;
}

export interface ImportMapping {
  hasHeader: boolean;
  /** -1 = sem coluna de empresa. */
  companyColumn: number;
  nameColumn: number;
  phoneColumn: number;
  defaultDdd: string | null;
}

export type Distribution =
  | { mode: 'fila' }
  | { mode: 'dividir'; userIds: string[] }
  | { mode: 'pessoa'; userId: string };

export interface ImportOptions extends ImportMapping {
  sheet: string | null;
  listName: string;
  dedupeInFile: boolean;
  dedupeBase: 'todos' | 'pendentes' | 'nenhum';
  distribution: Distribution;
}

export interface ImportDraft {
  id: string;
  fileName: string;
  sheets: string[];
  sheet: string | null;
  rowCount: number;
  columns: ImportColumn[];
  sample: string[][];
  suggestion: ImportOptions;
  previous: { date: string; listName: string | null } | null;
}

export interface ImportCounts {
  total: number;
  valid: number;
  invalid: number;
  duplicatesInFile: number;
  duplicatesInBase: number;
  blocked: number;
  /** Entre os válidos: empresas diferentes e total de telefones (principal + extras). */
  companies: number;
  phones: number;
}

export interface ImportPreview {
  columns: ImportColumn[];
  counts: ImportCounts;
  extraColumns: string[];
  validSample: {
    rowNumber: number;
    company: string;
    name: string;
    phoneDisplay: string;
    phoneType: 'movel' | 'fixo' | null;
    extra: Record<string, string>;
  }[];
  rejectedSample: { rowNumber: number; reason: string; values: string[] }[];
  perAttendant: { user: UserRef; count: number }[];
}

export type ImportStatus = 'rascunho' | 'processando' | 'concluida' | 'falhou' | 'descartada';

export interface ImportState {
  id: string;
  status: ImportStatus;
  fileName: string;
  createdAt: string;
  createdBy: UserRef | null;
  finishedAt: string | null;
  error: string | null;
  counts: ImportCounts | null;
  list: { id: string; name: string } | null;
  rejectedCount: number;
  progress: { phase: string; done: number; total: number } | null;
}

// ---------- Gestão ----------

export interface ListSummary extends ListProgress {
  createdBy: UserRef | null;
  distribution: 'fila' | 'dividir' | 'pessoa';
  sourceFile: string | null;
  extraColumns: string[];
}

export interface TeamMember {
  id: string;
  name: string;
  role: Role;
}

export interface UserAdmin {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  pendingInvite: boolean;
  queue: number;
  /** Limite diário próprio (null = usa o padrão da empresa) e quantos pegou hoje. */
  dailyPullLimit: number | null;
  pulledToday: number;
}

export interface InviteLink {
  url: string;
  expiresAt: string;
}

export interface BlockedPhone {
  phone: string;
  display: string;
  reason: string | null;
  createdAt: string;
  createdBy: UserRef | null;
}

export interface AuditItem {
  id: number;
  user: UserRef | null;
  action: string;
  entity: string | null;
  entityId: string | null;
  details: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}

export interface PrivacySearch {
  phone: string;
  display: string;
  blocked: boolean;
  leads: {
    id: number;
    company: string;
    name: string;
    listName: string;
    status: LeadStatus;
    createdAt: string;
    calledAt: string | null;
    events: number;
  }[];
}

// ---------- Automações ----------

/**
 * Condição de uma etapa: `{ field, operator, value }`. O tipo do valor depende do campo.
 * Por enquanto só é guardada; o executor é quem vai interpretá-la.
 */
export type AutomationCondition =
  | { field: 'lead_result'; operator: AutomationConditionOperator; value: ResultId }
  | { field: 'lead_replied'; operator: AutomationConditionOperator; value: boolean }
  | { field: 'lead_status'; operator: AutomationConditionOperator; value: LeadStatus }
  /** Id da lista (lists.id) de onde o lead veio. */
  | { field: 'lead_list'; operator: AutomationConditionOperator; value: string };

/** O que se envia para criar ou trocar uma etapa (na alteração, cada campo é opcional). */
export interface AutomationStepInput {
  actionType: AutomationActionType;
  /** Espera antes de agir, em segundos, depois da etapa anterior (ou do começo, na primeira). 0 = imediatamente. */
  delaySeconds: number;
  /** Texto da mensagem (só em "send_text"), com variáveis como {{nome}}. */
  messageText: string | null;
  /** Áudio da biblioteca do Chamar (só em "send_audio", modo fixo). */
  audioId: number | null;
  /** "fixed" = o áudio de `audioId`; "random" = sorteia entre os áudios ativos da biblioteca. */
  audioMode: AutomationAudioMode;
  /** A etapa só age se todas as condições forem verdadeiras. */
  conditions: AutomationCondition[];
}

export interface AutomationStep extends AutomationStepInput {
  id: number;
  /** Ordem da etapa dentro da automação (a partir de 1). */
  position: number;
}

/** Quantas participações de leads a automação tem em cada situação. */
export type AutomationRunCounts = Record<AutomationRunStatus, number>;

export interface AutomationItem {
  id: number;
  name: string;
  description: string | null;
  status: AutomationStatus;
  trigger: AutomationTrigger;
  steps: AutomationStep[];
  /** Participações de leads (o que o executor já fez ou está fazendo). */
  runs: AutomationRunCounts;
  /** Quando o último lead entrou na automação (null = nenhum ainda). */
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: UserRef | null;
}

/** O que aconteceu com uma etapa numa participação (uma linha por etapa). */
export interface AutomationStepRunItem {
  /** Vazio se a etapa foi excluída depois. */
  stepId: number | null;
  /** Posição que a etapa tinha (vazio se ela foi excluída). */
  position: number | null;
  status: AutomationStepRunStatus;
  /** Tentativas de envio. Uma etapa nunca é reenviada quando não dá para saber se a primeira chegou. */
  attempts: number;
  /** Erro (etapa que falhou) ou explicação (etapa pulada: qual condição não foi atendida). */
  error: string | null;
  /** Mensagem que a etapa enviou (vazio se não enviou). */
  messageId: number | null;
  scheduledAt: string;
  finishedAt: string | null;
  /** Áudio usado nesta etapa (o nome sobrevive se o áudio for excluído da biblioteca). */
  audio: { id: number | null; label: string } | null;
}

/** A participação de um lead numa automação. */
export interface AutomationRunItem {
  id: number;
  automationId: number;
  /** Campanha que criou a participação (vazio: veio do Chamar ou da execução manual). */
  campaignId: number | null;
  /** Vazio se o lead foi excluído. Lead anonimizado aparece como "Anonimizado". */
  lead: { id: number; label: string; name: string | null; company: string | null } | null;
  /** Número de WhatsApp pelo qual a automação fala (vazio se o número foi excluído). */
  instance: { id: number; label: string } | null;
  status: AutomationRunStatus;
  /** Posição da etapa em andamento (a próxima a executar). */
  currentStep: number;
  startedAt: string | null;
  /** Quando a etapa em andamento deve agir. */
  nextRunAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  /** Motivo do cancelamento ou da falha (código; ver `runReasonLabel`). */
  reason: string | null;
  steps: AutomationStepRunItem[];
}

// ---------- Campanhas ----------

/** Um número de WhatsApp numa campanha: situação e uso do dia (o limite é por número, por dia, em São Paulo). */
export interface CampaignNumber {
  id: number;
  label: string;
  /** Telefone conectado, só dígitos (vazio se nunca conectou). */
  phone: string | null;
  /** open | connecting | close */
  status: string;
  connected: boolean;
  /** Teto de contatos por dia deste número nesta campanha (no máximo 20, o limite de todo número). */
  dailyLimit: number;
  /** Contatos manuais (botão Chamar) enviados hoje por este número. */
  manualToday: number;
  /** Contatos automáticos (campanhas) enviados hoje por este número. */
  automaticToday: number;
  /** Envio em andamento ou de resultado incerto: ocupa a vaga, mas ainda não é manual nem automático. */
  uncertainToday: number;
  /** Total de hoje: manual + automático + incerto (a cota é UMA só para os dois). */
  usedToday: number;
  remainingToday: number;
  /** O dia deste número está cheio: ele não inicia novos contatos até amanhã (fuso de São Paulo). */
  limitReached: boolean;
}

export interface CampaignCounts {
  /** Leads que já entraram na campanha (uma participação cada). */
  total: number;
  /** Aguardando a vez ou enviando. */
  waiting: number;
  completed: number;
  cancelled: number;
  failed: number;
}

export interface CampaignItem {
  id: number;
  automationId: number;
  status: CampaignStatus;
  list: { id: string; name: string } | null;
  instanceIds: number[];
  /** "10:00" (horário de São Paulo). */
  windowStart: string;
  windowEnd: string;
  dailyLimitPerNumber: number;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  startedBy: UserRef | null;
  counts: CampaignCounts;
  /** Data inicial (AAAA-MM-DD, São Paulo). Antes dela a campanha está agendada e nada é enviado. */
  startDate: string;
  /** Data final (inclusive). Depois dela nenhum primeiro contato novo sai. Vazio = sem data final. */
  endDate: string | null;
  /** Dias em que executa (1 = segunda ... 7 = domingo). */
  daysOfWeek: number[];
  /** Depois de um primeiro contato automático, nova abordagem independente só depois desse tempo (0 = sem cooldown). */
  cooldownHours: number;
  filters: CampaignFilters;
  /** Se está agendada, executando ou esperando a próxima abertura (contas do servidor). */
  schedule: CampaignScheduleInfo;
}

/** Os próximos envios já agendados (um por número no máximo). */
export interface CampaignNextSend {
  runId: number;
  at: string;
  lead: { id: number; label: string };
  instance: { id: number; label: string };
}

export interface CampaignDetail extends CampaignItem {
  numbers: CampaignNumber[];
  /** Leads da lista que ainda podem entrar (a fila livre, sem bloqueio, anonimização nem participação). */
  eligibleLeads: number;
  /** Novos contatos por dia, somando os números conectados (com o dia vazio). */
  dailyCapacity: number;
  /** Quantos contatos novos ainda cabem HOJE: só números conectados e com vaga, já descontados os manuais. */
  availableToday: number;
  nextSends: CampaignNextSend[];
}

/** O que o gestor vê antes de iniciar: o público, os números, a capacidade, a estimativa e o calendário. */
export interface CampaignPreview {
  list: { id: string; name: string } | null;
  automation: { id: number; name: string };
  /** Quantos leads da lista entram, e por que os outros ficam de fora. Contado pelo servidor, sem carregar leads. */
  audience: CampaignAudience;
  estimate: CampaignEstimate;
  /** Os próximos dias: quando executa e quantos contatos cabem. */
  calendar: CalendarDay[];
  schedule: CampaignScheduleInfo;
  /** Igual a `audience.eligible` (mantido por compatibilidade). */
  eligibleLeads: number;
  numbers: CampaignNumber[];
  /** Números escolhidos que estão conectados agora. */
  connectedNumbers: number;
  dailyCapacity: number;
  /** Contatos novos que ainda cabem HOJE nos números escolhidos (números cheios não entram na soma). */
  availableToday: number;
  /** Áudios ativos na biblioteca (o sorteio usa esses). */
  activeAudios: number;
}

export interface CampaignInput {
  listId: string;
  instanceIds: number[];
  windowStart: string;
  windowEnd: string;
  dailyLimitPerNumber: number;
  /** Data inicial (AAAA-MM-DD). Vazio = hoje (começa agora). Uma data futura deixa a campanha agendada. */
  startDate?: string;
  endDate?: string | null;
  /** Padrão: segunda a sexta. */
  daysOfWeek?: number[];
  /** Padrão: 24 horas. */
  cooldownHours?: number;
  filters?: CampaignFilters;
}

/** Alterar uma campanha em andamento ou agendada (só o que foi enviado muda). */
export type CampaignUpdateInput = Partial<CampaignInput>;

/** Os próximos dias da campanha e a estimativa de duração (do servidor). */
export interface CampaignCalendar {
  days: CalendarDay[];
  estimate: CampaignEstimate;
}

/** Contadores e explicações de uma campanha (`GET .../stats`). */
export type CampaignStatsResult = CampaignStats;

/** Corpo de `POST /automations/:id/run`: um lead e o número pelo qual falar. */
export interface ManualRunInput {
  leadId: number;
  instanceId: number;
}

// ---------- Auditoria ----------

export interface ActivityUserRow {
  user: UserRef & { role: Role; active: boolean };
  /** Quantas vezes pediu leads e quantos recebeu nesses pedidos. */
  pedidos: number;
  puxados: number;
  /** Leads que chegaram por distribuição na importação ou atribuição do gestor. */
  recebidos: number;
  abriuWhatsapp: number;
  chamados: number;
  semWhatsapp: number;
  resultados: number;
  observacoes: number;
  devolvidos: number;
  bloqueios: number;
  acessosNegados: number;
  /** Total de ações registradas no período. */
  acoes: number;
}

export interface ActivitySummary {
  from: string;
  to: string;
  users: ActivityUserRow[];
  daily: { day: string; user: UserRef; puxados: number; chamados: number }[];
  topPuller: { user: UserRef; count: number } | null;
  topCaller: { user: UserRef; count: number } | null;
}

export interface ActivityItem {
  id: string;
  createdAt: string;
  user: UserRef | null;
  action: string;
  details: Record<string, unknown>;
  lead: { id: number; company: string; name: string } | null;
  ip: string | null;
}
