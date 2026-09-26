/** Campanha automática: chamadas à API, cache e tempo real (a aba Automações). */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import type { AutoCampaignState } from '../../shared/auto-campaign';
import { api } from './api';
import { useRealtimeOnline, useReconnect, useSocketEvent } from './socket';

export const AUTO_CAMPAIGN_KEY = ['auto-campaign'] as const;

export const autoCampaignApi = {
  state: () => api<AutoCampaignState>('/auto-campaign'),
  activate: () => api<AutoCampaignState>('/auto-campaign/activate', { body: {} }),
  pause: () => api<AutoCampaignState>('/auto-campaign/pause', { body: {} }),
};

/** Com a campanha enviando, o servidor avisa a cada ciclo: a tela recarrega no máximo uma vez a cada 15 s. */
const MIN_REFRESH_MS = 15_000;

/**
 * A situação e as métricas da campanha automática. O servidor avisa pelo tempo real quando algo muda (envios, ativar,
 * pausar) e a tela busca de novo, sem martelar o banco: no máximo uma recarga a cada 15 s. Sem tempo real, refaz a cada
 * 30 s; com ele, a cada 60 s só por garantia (o "para enviar hoje" muda com o relógio).
 */
export function useAutoCampaign() {
  const qc = useQueryClient();
  const online = useRealtimeOnline();
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = () => {
    if (timer.current) return;
    const wait = Math.max(0, last.current + MIN_REFRESH_MS - Date.now());
    timer.current = setTimeout(() => {
      timer.current = null;
      last.current = Date.now();
      void qc.invalidateQueries({ queryKey: AUTO_CAMPAIGN_KEY });
    }, wait);
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  useSocketEvent('campaign:updated', refresh);
  useReconnect(refresh);

  return useQuery({
    queryKey: AUTO_CAMPAIGN_KEY,
    queryFn: autoCampaignApi.state,
    refetchInterval: online ? 60_000 : 30_000,
  });
}
