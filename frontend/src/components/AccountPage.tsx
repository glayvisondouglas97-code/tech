import { ChevronRight, KeyRound, LogOut } from 'lucide-react';
import type { CurrentUser } from '../api.ts';
import { Avatar } from './ui.tsx';

// Conta (no celular, pela barra de baixo): troca de senha e saída.
export function AccountPage({ user, onChangePassword, onLogout }: { user: CurrentUser; onChangePassword: () => void; onLogout: () => void }) {
  return (
    <main className="page">
      <div className="page-inner narrow">
        <header className="page-header">
          <div>
            <h1>Conta</h1>
          </div>
        </header>
        <div className="account-card">
          <Avatar name={user.name} seed={user.email} size="lg" />
          <strong>{user.name}</strong>
          <span>{user.email}</span>
          <span className="badge plain">{user.isAdmin ? 'Administrador' : 'Atendente'}</span>
        </div>
        <div className="settings-list">
          <button className="menu-item" onClick={onChangePassword}>
            <KeyRound aria-hidden />
            <span className="menu-item-label">Minha senha</span>
            <ChevronRight aria-hidden />
          </button>
          <button className="menu-item danger" onClick={onLogout}>
            <LogOut aria-hidden />
            <span className="menu-item-label">Sair</span>
          </button>
        </div>
      </div>
    </main>
  );
}
