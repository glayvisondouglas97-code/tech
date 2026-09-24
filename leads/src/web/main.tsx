import '@fontsource/poppins/400.css';
import '@fontsource/poppins/500.css';
import '@fontsource/poppins/600.css';
import '@fontsource/poppins/700.css';
import './styles.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider } from './components/Toasts';
import { ApiError } from './lib/api';
import { SessionProvider } from './lib/session';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
  },
});

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <SessionProvider>
            <App />
          </SessionProvider>
        </ToastProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);

// PWA: instala no celular. Só no build de produção (no desenvolvimento atrapalharia o recarregamento).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
