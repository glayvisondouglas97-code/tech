import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo } from 'react';
import type { AppConfig, Me, SessionInfo } from '../../shared/api';
import { can } from '../../shared/roles';
import { ApiError, api, setCsrfToken as setApiCsrf, setUnauthorizedHandler } from './api';
import { setUploadCsrf } from './whatsapp';

/** O mesmo token CSRF vale para a API e para os envios de arquivo do chat. */
function setCsrfToken(token: string) {
  setApiCsrf(token);
  setUploadCsrf(token);
}

interface SessionValue {
  me: Me | null;
  loading: boolean;
  config: AppConfig | null;
  signedIn: (s: SessionInfo) => void;
  signOut: () => Promise<void>;
  can: (p: keyof typeof can) => boolean;
}

const Ctx = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const session = useQuery({
    queryKey: ['session'],
    queryFn: async () => {
      try {
        const s = await api<SessionInfo>('/auth/me');
        setCsrfToken(s.csrfToken);
        return s;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: 2,
  });
  const me = session.data?.user ?? null;

  const config = useQuery({
    queryKey: ['app-config'],
    queryFn: () => api<AppConfig>('/app-config'),
    enabled: !!me,
    staleTime: 60_000,
  });

  // Troca de usuário: descarta os dados do usuário anterior, mas mantém a consulta da sessão
  // (apagar tudo com qc.clear() desliga o observador da sessão e a tela não percebe o login).
  const resetOthers = useCallback(() => {
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' });
  }, [qc]);

  const signedIn = useCallback(
    (s: SessionInfo) => {
      setCsrfToken(s.csrfToken);
      resetOthers();
      qc.setQueryData(['session'], s);
    },
    [qc, resetOthers],
  );

  const signOut = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {}
    setCsrfToken('');
    qc.setQueryData(['session'], null);
    resetOthers();
  }, [qc, resetOthers]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      qc.setQueryData(['session'], null);
    });
    return () => setUnauthorizedHandler(null);
  }, [qc]);

  const value = useMemo<SessionValue>(
    () => ({
      me,
      loading: session.isLoading,
      config: config.data ?? null,
      signedIn,
      signOut,
      can: (p) => (me ? can[p](me.role) : false),
    }),
    [me, session.isLoading, config.data, signedIn, signOut],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession fora do SessionProvider');
  return v;
}

/** Para páginas que só aparecem logado. */
export function useMe(): Me {
  const { me } = useSession();
  if (!me) throw new Error('usuário não logado');
  return me;
}
