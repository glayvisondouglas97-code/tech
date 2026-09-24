/** Hierarquia: dono > administrador > supervisor > atendente. */
export const ROLES = ['dono', 'admin', 'supervisor', 'atendente'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  dono: 'Dono',
  admin: 'Administrador',
  supervisor: 'Supervisor',
  atendente: 'Atendente',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  dono: 'Acesso master: tudo, inclusive criar e remover administradores, excluir listas e usar a LGPD. As ações do dono só aparecem para outro dono.',
  admin:
    'Gerencia supervisores e atendentes, configurações, listas e vê a auditoria completa da equipe. Não mexe em donos nem em outros administradores.',
  supervisor:
    'Acompanha a equipe inteira, importa listas, redistribui e exporta. Não mexe em configurações nem em usuários.',
  atendente: 'Trabalha só nos leads dele.',
};

const isManager = (r: Role) => r !== 'atendente';
const isAdmin = (r: Role) => r === 'dono' || r === 'admin';
const isOwner = (r: Role) => r === 'dono';

/**
 * Matriz de permissões. O servidor aplica cada uma destas regras;
 * a interface só usa a mesma tabela para esconder o que não pode ser usado.
 */
export const can = {
  /** Ver leads, histórico e números de todos os atendentes. */
  seeAllLeads: isManager,
  /** Atribuir, devolver e redistribuir leads de qualquer pessoa; editar resultado de qualquer lead. */
  manageLeads: isManager,
  importLists: isManager,
  exportData: isManager,
  /** Arquivar e renomear listas. */
  manageLists: isAdmin,
  /** Excluir listas de vez (com todo o histórico). */
  deleteLists: isOwner,
  /** Cadastrar, desativar e redefinir senha de supervisores e atendentes. */
  manageUsers: isAdmin,
  /** Cadastrar e gerenciar administradores e donos. */
  manageAdmins: isOwner,
  manageSettings: isAdmin,
  /** Auditoria: tudo o que a equipe fez. O administrador não vê as ações dos donos. */
  viewAudit: isAdmin,
  /** Ferramentas da LGPD (buscar, exportar, anonimizar e excluir dados de uma pessoa). */
  privacy: isOwner,
  /**
   * Ver as conversas de todos os números de WhatsApp. Sem isso (atendente), só as dos números de que a
   * pessoa é responsável.
   */
  seeAllNumbers: isManager,
  /**
   * Conectar, renomear e trocar o responsável de qualquer número. Todo usuário pode cadastrar os próprios
   * números e cuidar deles.
   */
  manageNumbers: isAdmin,
} satisfies Record<string, (r: Role) => boolean>;

/** Papéis que cada papel pode criar e gerenciar. */
export function manageableRoles(actor: Role): Role[] {
  if (actor === 'dono') return [...ROLES];
  if (actor === 'admin') return ['supervisor', 'atendente'];
  return [];
}
