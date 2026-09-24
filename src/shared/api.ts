/** Formatos trocados entre o servidor e a interface. */
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

export interface MessageTemplate {
  id: string;
  name: string;
  body: string;
  isDefault: boolean;
}

/** Configuração que todo usuário logado recebe. */
export interface AppConfig {
  companyName: string;
  logoUrl: string | null;
  pullSize: number;
  maxQueue: number;
  hourlyContactWarning: number;
  templates: MessageTemplate[];
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
