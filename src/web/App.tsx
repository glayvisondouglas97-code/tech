import { useQuery } from '@tanstack/react-query';
import { lazy, type ReactNode, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import type { can } from '../shared/roles';
import { Shell } from './components/Shell';
import { api } from './lib/api';
import { useSession } from './lib/session';
import { LoginPage } from './pages/LoginPage';
import { QueuePage } from './pages/QueuePage';

// Telas de gestão e menos usadas carregam sob demanda: o atendente no celular baixa só o necessário.
const AccountPage = lazy(() => import('./pages/AccountPage').then((m) => ({ default: m.AccountPage })));
const AudiosPage = lazy(() => import('./pages/AudiosPage').then((m) => ({ default: m.AudiosPage })));
const AuditPage = lazy(() => import('./pages/AuditPage').then((m) => ({ default: m.AuditPage })));
const CalledPage = lazy(() => import('./pages/CalledPage').then((m) => ({ default: m.CalledPage })));
const ConversationsPage = lazy(() =>
  import('./pages/ConversationsPage').then((m) => ({ default: m.ConversationsPage })),
);
const DashboardPage = lazy(() => import('./pages/DashboardPage').then((m) => ({ default: m.DashboardPage })));
const LeadsPage = lazy(() => import('./pages/LeadsPage').then((m) => ({ default: m.LeadsPage })));
const ListsPage = lazy(() => import('./pages/ListsPage').then((m) => ({ default: m.ListsPage })));
const NumbersPage = lazy(() => import('./pages/NumbersPage').then((m) => ({ default: m.NumbersPage })));
const SetPasswordPage = lazy(() =>
  import('./pages/SetPasswordPage').then((m) => ({ default: m.SetPasswordPage })),
);
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const SetupPage = lazy(() => import('./pages/SetupPage').then((m) => ({ default: m.SetupPage })));
const UsersPage = lazy(() => import('./pages/UsersPage').then((m) => ({ default: m.UsersPage })));

function Splash() {
  return (
    <div className="auth-wrap" aria-busy="true">
      <span className="spinner" />
      <span className="vh">Carregando…</span>
    </div>
  );
}

function PageLoading() {
  return (
    <div className="page-loading" role="status" aria-busy="true">
      <span className="spinner" />
      <span className="vh">Carregando…</span>
    </div>
  );
}

function Protected({ children, perm }: { children: ReactNode; perm?: keyof typeof can }) {
  const { me, loading, can } = useSession();
  const location = useLocation();
  const setup = useQuery({
    queryKey: ['setup'],
    queryFn: () => api<{ needed: boolean; enabled: boolean }>('/setup'),
    enabled: !loading && !me,
  });
  if (loading || (!me && setup.isLoading)) return <Splash />;
  if (!me) {
    if (setup.data?.needed) return <Navigate to="/primeiro-acesso" replace />;
    return <Navigate to="/entrar" replace state={{ from: location.pathname }} />;
  }
  if (perm && !can(perm)) return <Navigate to="/chamar" replace />;
  return (
    <Shell>
      <Suspense fallback={<PageLoading />}>{children}</Suspense>
    </Shell>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<Splash />}>
        <Routes>
          <Route path="/entrar" element={<LoginPage />} />
          <Route path="/definir-senha" element={<SetPasswordPage />} />
          <Route path="/primeiro-acesso" element={<SetupPage />} />
          <Route
            path="/chamar"
            element={
              <Protected>
                <QueuePage />
              </Protected>
            }
          />
          <Route
            path="/conversas/:id?"
            element={
              <Protected>
                <ConversationsPage />
              </Protected>
            }
          />
          <Route
            path="/numeros"
            element={
              <Protected>
                <NumbersPage />
              </Protected>
            }
          />
          <Route
            path="/audios"
            element={
              <Protected perm="manageAudios">
                <AudiosPage />
              </Protected>
            }
          />
          <Route
            path="/chamados"
            element={
              <Protected>
                <CalledPage />
              </Protected>
            }
          />
          <Route
            path="/painel"
            element={
              <Protected>
                <DashboardPage />
              </Protected>
            }
          />
          <Route
            path="/leads"
            element={
              <Protected perm="manageLeads">
                <LeadsPage />
              </Protected>
            }
          />
          <Route
            path="/listas"
            element={
              <Protected perm="importLists">
                <ListsPage />
              </Protected>
            }
          />
          <Route
            path="/usuarios"
            element={
              <Protected perm="manageUsers">
                <UsersPage />
              </Protected>
            }
          />
          <Route path="/equipe" element={<Navigate to="/usuarios" replace />} />
          <Route
            path="/auditoria"
            element={
              <Protected perm="viewAudit">
                <AuditPage />
              </Protected>
            }
          />
          <Route
            path="/configuracoes"
            element={
              <Protected perm="manageSettings">
                <SettingsPage />
              </Protected>
            }
          />
          <Route
            path="/conta"
            element={
              <Protected>
                <AccountPage />
              </Protected>
            }
          />
          <Route path="*" element={<Navigate to="/chamar" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
