import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router';
import type { QueueStats } from '../../shared/api';
import { type can, ROLE_LABELS } from '../../shared/roles';
import { api } from '../lib/api';
import { fmtN } from '../lib/format';
import { useOnline } from '../lib/hooks';
import { applyTheme, usePrefs } from '../lib/prefs';
import { useSession } from '../lib/session';
import { setRealtimeAuthHandler, socket } from '../lib/socket';
import { useWaCacheSync, useWaStats } from '../lib/whatsapp';
import {
  IconBell,
  IconBuilding,
  IconChart,
  IconCheckCircle,
  IconConversas,
  IconInbox,
  IconLayers,
  IconLogout,
  IconMenu,
  IconMic,
  IconMonitor,
  IconMoon,
  IconPlus,
  IconSearch,
  IconSettings,
  IconShield,
  IconSmartphone,
  IconSparkle,
  IconSun,
  IconUpload,
  IconUser,
  IconUsers,
  IconX,
  Logo,
} from './Icons';
import { Avatar } from './ui';

type NavItem = {
  to: string;
  label: string;
  /** Rótulo curto para a barra de baixo do celular. */
  short?: string;
  icon: ReactNode;
  perm?: keyof typeof can;
  /** Selo com número: fila do atendente, conversas não lidas ou números desconectados (vermelho). */
  count?: 'fila' | 'naoLidas' | 'desconectados';
  /** Só aparece com o WhatsApp (Evolution) ligado. */
  whatsapp?: boolean;
  group: 'work' | 'manage';
};

const NAV: NavItem[] = [
  { to: '/chamar', label: 'A chamar', icon: <IconInbox />, count: 'fila', group: 'work' },
  {
    to: '/conversas',
    label: 'Conversas',
    icon: <IconConversas />,
    count: 'naoLidas',
    whatsapp: true,
    group: 'work',
  },
  { to: '/chamados', label: 'Já chamados', short: 'Chamados', icon: <IconCheckCircle />, group: 'work' },
  { to: '/painel', label: 'Painel', icon: <IconChart />, group: 'work' },
  { to: '/leads', label: 'Leads', icon: <IconBuilding />, perm: 'manageLeads', group: 'manage' },
  { to: '/listas', label: 'Listas', icon: <IconLayers />, perm: 'importLists', group: 'manage' },
  {
    to: '/numeros',
    label: 'Números',
    icon: <IconSmartphone />,
    count: 'desconectados',
    whatsapp: true,
    group: 'manage',
  },
  {
    to: '/audios',
    label: 'Áudios',
    icon: <IconMic />,
    perm: 'manageAudios',
    whatsapp: true,
    group: 'manage',
  },
  {
    to: '/automacoes',
    label: 'Automações',
    icon: <IconSparkle size={18} />,
    perm: 'manageAutomations',
    whatsapp: true,
    group: 'manage',
  },
  { to: '/usuarios', label: 'Usuários', icon: <IconUsers />, perm: 'manageUsers', group: 'manage' },
  { to: '/auditoria', label: 'Auditoria', icon: <IconShield />, perm: 'viewAudit', group: 'manage' },
];

/** Volta ao topo: no computador rola a página; no celular, a área do conteúdo. */
export function scrollContentToTop() {
  window.scrollTo(0, 0);
  document.querySelector('.app-main')?.scrollTo(0, 0);
}

export function useQueueStats() {
  return useQuery({
    queryKey: ['queue-stats'],
    queryFn: () => api<QueueStats>('/queue/stats'),
    refetchInterval: 30_000,
  });
}

/** Espaço no meio da barra de cima que cada tela pode preencher (ex.: Lista / Modo foco). */
const TopbarSlot = createContext<(node: ReactNode) => void>(() => {});

export function useTopbarCenter(node: ReactNode, key: unknown) {
  const set = useContext(TopbarSlot);
  // biome-ignore lint/correctness/useExhaustiveDependencies: o conteúdo só muda quando a chave muda
  useEffect(() => {
    set(node);
    return () => set(null);
  }, [key, set]);
}

const THEMES = [
  ['auto', 'Automático', <IconMonitor key="a" />],
  ['light', 'Claro', <IconSun key="l" />],
  ['dark', 'Escuro', <IconMoon key="d" />],
] as const;

function useDarkNow(theme: 'auto' | 'light' | 'dark') {
  const [sysDark, setSysDark] = useState(() => {
    try {
      return matchMedia('(prefers-color-scheme: dark)').matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      const m = matchMedia('(prefers-color-scheme: dark)');
      const on = () => setSysDark(m.matches);
      m.addEventListener('change', on);
      return () => m.removeEventListener('change', on);
    } catch {
      return undefined;
    }
  }, []);
  return theme === 'dark' || (theme === 'auto' && sysDark);
}

/** Avatar no canto de cima: conta, tema e sair. */
function UserMenu() {
  const { me, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const [prefs, setPrefs] = usePrefs();
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  if (!me) return null;
  return (
    <div className="menu-wrap" ref={ref}>
      <button
        type="button"
        className="avatar-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${me.name}: conta, tema e sair`}
        onClick={() => setOpen((o) => !o)}
      >
        <Avatar name={me.name} large />
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-head">
            <Avatar name={me.name} />
            <span>
              <b>{me.name}</b>
              <small>
                {ROLE_LABELS[me.role]} · {me.email}
              </small>
            </span>
          </div>
          <hr />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              navigate('/conta');
            }}
          >
            <IconUser size={16} /> Minha conta e senha
          </button>
          <div className="menu-label">Tema</div>
          <div className="seg seg-sm" role="radiogroup" aria-label="Tema">
            {THEMES.map(([v, l, icon]) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={prefs.theme === v}
                title={l}
                onClick={() => {
                  setPrefs({ theme: v });
                  applyTheme(v);
                }}
              >
                {icon}
                <span>{l}</span>
              </button>
            ))}
          </div>
          <hr />
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={async () => {
              setOpen(false);
              await signOut();
              navigate('/entrar');
            }}
          >
            <IconLogout size={16} /> Sair
          </button>
        </div>
      )}
    </div>
  );
}

/** Ação principal de quem está logado: o gestor importa listas; o atendente pega leads. */
function usePrimaryAction() {
  const { can } = useSession();
  return can('importLists')
    ? { to: '/listas', label: 'Importar lista', icon: <IconUpload /> }
    : { to: '/chamar', label: 'Pegar leads', icon: <IconPlus /> };
}

function TopActions() {
  const { can } = useSession();
  const stats = useQueueStats();
  const location = useLocation();
  const action = usePrimaryAction();
  const due = stats.data?.retornosHoje ?? 0;
  return (
    <div className="top-actions">
      {location.pathname !== action.to && (
        <Link to={action.to} className="btn btn-primary cta-pill">
          {action.icon}
          {action.label}
        </Link>
      )}
      {can('manageLeads') && (
        <Link to="/leads" className="round-btn" aria-label="Buscar leads" title="Buscar leads">
          <IconSearch size={18} />
        </Link>
      )}
      <Link
        to="/chamar"
        className="round-btn"
        aria-label={due ? `${due} retornos agendados para hoje` : 'Sem retornos para hoje'}
        title="Retornos agendados para hoje"
      >
        <IconBell />
        {due > 0 && <span className="bell-count">{due > 99 ? '99+' : due}</span>}
      </Link>
      <UserMenu />
    </div>
  );
}

function NavCount({
  count,
  className,
}: {
  count: { value: number; bad?: boolean } | null;
  className: string;
}) {
  if (!count) return null;
  return (
    <span className={`${className}${count.bad ? ' bad' : ''}`}>
      {count.value > 99 ? '99+' : fmtN(count.value)}
    </span>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { config, can, me } = useSession();
  const stats = useQueueStats();
  const mine = stats.data?.minhaFila ?? 0;
  const whatsapp = !!config?.whatsapp;
  const waStats = useWaStats(whatsapp);
  const qc = useQueryClient();
  useWaCacheSync(whatsapp);
  // Tempo real do WhatsApp: liga com o login; se o servidor recusar (sessão encerrada), confere a sessão.
  useEffect(() => {
    if (!whatsapp) return;
    setRealtimeAuthHandler(() => void qc.invalidateQueries({ queryKey: ['session'] }));
    socket.connect();
    return () => {
      setRealtimeAuthHandler(null);
      socket.disconnect();
    };
  }, [whatsapp, qc]);
  const countOf = (n: NavItem): { value: number; bad?: boolean } | null => {
    const value =
      n.count === 'fila'
        ? mine
        : n.count === 'naoLidas'
          ? (waStats.data?.unreadConversations ?? 0)
          : n.count === 'desconectados'
            ? (waStats.data?.disconnectedInstances ?? 0)
            : 0;
    return value > 0 ? { value, bad: n.count === 'desconectados' } : null;
  };
  const name = config?.companyName || 'Chamador de Leads';
  const [drawer, setDrawer] = useState(false);
  const [center, setCenterState] = useState<ReactNode>(null);
  const setCenter = useCallback((n: ReactNode) => setCenterState(n), []);
  const [prefs, setPrefs] = usePrefs();
  const dark = useDarkNow(prefs.theme);
  const online = useOnline();
  const location = useLocation();
  const action = usePrimaryAction();
  const items = NAV.filter((n) => (!n.perm || can(n.perm)) && (!n.whatsapp || whatsapp));
  const manage = items.filter((n) => n.group === 'manage');

  // Conversas não lidas no título da aba do navegador: "(3) Nome da empresa".
  const unread = waStats.data?.unreadConversations ?? 0;
  useEffect(() => {
    document.title = unread ? `(${unread}) ${name}` : name;
  }, [name, unread]);
  // Ao trocar de tela: fecha a gaveta do celular e volta o conteúdo ao topo (no celular, quem rola é a área
  // do conteúdo, não a página).
  // biome-ignore lint/correctness/useExhaustiveDependencies: reage só à troca de rota
  useEffect(() => {
    setDrawer(false);
    scrollContentToTop();
  }, [location.pathname]);
  useEffect(() => {
    if (!drawer) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setDrawer(false);
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [drawer]);

  const link = (n: NavItem) => (
    <NavLink
      key={n.to}
      to={n.to}
      className={({ isActive }) => `side-link${isActive ? ' active' : ''}`}
      title={n.label}
    >
      <span className="side-ic">
        {n.icon}
        <NavCount count={countOf(n)} className="side-count" />
      </span>
      <span className="side-text">{n.label}</span>
    </NavLink>
  );

  const toggleTheme = () => {
    const next = dark ? 'light' : 'dark';
    setPrefs({ theme: next });
    applyTheme(next);
  };

  return (
    <TopbarSlot.Provider value={setCenter}>
      <div className="app">
        <a className="skip" href="#conteudo">
          Pular para o conteúdo
        </a>
        <aside className={`side${drawer ? ' open' : ''}`} aria-label="Menu">
          <div className="side-head">
            <Link to="/chamar" className="side-link side-brand" title={name}>
              <span className="side-ic side-logo">
                {config?.logoUrl ? <img src={config.logoUrl} alt="" /> : <Logo size={24} />}
              </span>
              <span className="side-text">{name}</span>
            </Link>
            <button
              type="button"
              className="side-close"
              aria-label="Fechar menu"
              onClick={() => setDrawer(false)}
            >
              <IconX />
            </button>
          </div>
          <Link to={action.to} className="side-link side-plus" title={action.label}>
            <span className="side-ic">
              <IconPlus />
            </span>
            <span className="side-text">{action.label}</span>
          </Link>
          <nav className="side-nav" aria-label="Seções">
            {items.filter((n) => n.group === 'work').map(link)}
            {manage.length > 0 && (
              <p className="side-sep">
                <span className="side-text">Gestão</span>
              </p>
            )}
            {manage.map(link)}
          </nav>
          <div className="side-foot">
            {can('manageSettings') && (
              <NavLink
                to="/configuracoes"
                className={({ isActive }) => `side-link${isActive ? ' active' : ''}`}
                title="Configurações"
              >
                <span className="side-ic">
                  <IconSettings />
                </span>
                <span className="side-text">Configurações</span>
              </NavLink>
            )}
            <button
              type="button"
              className="side-link"
              onClick={toggleTheme}
              title={dark ? 'Usar tema claro' : 'Usar tema escuro'}
            >
              <span className="side-ic">{dark ? <IconSun /> : <IconMoon />}</span>
              <span className="side-text">{dark ? 'Tema claro' : 'Tema escuro'}</span>
            </button>
            {me && (
              <NavLink
                to="/conta"
                className={({ isActive }) => `side-link side-me${isActive ? ' active' : ''}`}
                title="Minha conta"
              >
                <span className="side-ic">
                  <Avatar name={me.name} />
                </span>
                <span className="side-text">
                  {me.name}
                  <small>{ROLE_LABELS[me.role]}</small>
                </span>
              </NavLink>
            )}
          </div>
        </aside>
        {drawer && <div className="scrim" aria-hidden="true" onClick={() => setDrawer(false)} />}

        <div className="app-main">
          <header className="topbar-d">
            <span />
            <div className="top-center">{center}</div>
            <TopActions />
          </header>
          <header className="topbar">
            <Link to="/chamar" className="brand">
              {config?.logoUrl ? <img src={config.logoUrl} alt="" /> : <Logo />}
              <span>{name}</span>
            </Link>
            <TopActions />
          </header>
          {!online && (
            <div className="offline" role="status">
              Sem internet. O que você fizer agora pode não ser salvo; espere a conexão voltar.
            </div>
          )}
          <main id="conteudo">{children}</main>
        </div>

        <nav className="tabbar" aria-label="Atalhos">
          {items
            .filter((n) => n.group === 'work')
            .map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                className={({ isActive }) => `tabbar-link${isActive ? ' active' : ''}`}
              >
                <span className="tabbar-ic">
                  {n.icon}
                  <NavCount count={countOf(n)} className="count" />
                </span>
                {n.short ?? n.label}
              </NavLink>
            ))}
          <button
            type="button"
            className="tabbar-link"
            aria-expanded={drawer}
            onClick={() => setDrawer(true)}
          >
            <span className="tabbar-ic">
              <IconMenu />
            </span>
            Menu
          </button>
        </nav>
      </div>
    </TopbarSlot.Provider>
  );
}
