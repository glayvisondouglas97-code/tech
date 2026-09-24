import { Component, type ErrorInfo, type ReactNode } from 'react';

/** Se alguma tela quebrar, mostra uma mensagem com botão de recarregar em vez de uma página em branco. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Erro na tela:', error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <h1 style={{ fontSize: 22 }}>Algo deu errado nesta tela</h1>
          <p className="sub">
            Seus dados estão salvos. Recarregue a página para continuar; se o problema voltar, avise o
            responsável pelo sistema.
          </p>
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            Recarregar a página
          </button>
        </div>
      </div>
    );
  }
}
