import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useMemo, useRef, useState } from 'react';
import type { CampaignDetail, ListSummary } from '../../../shared/api';
import { CAMPAIGN_MAX_DAILY_LIMIT, CAMPAIGN_MAX_NUMBERS } from '../../../shared/automations';
import { ALL_DAYS, DEFAULT_DAYS, formatDays, normalizeDays, WEEKDAYS } from '../../../shared/campaign-plan';
import { api, errorMessage } from '../../lib/api';
import { automationsApi } from '../../lib/automations';
import {
  type CampaignFormState,
  changesFrom,
  formFromCampaign,
  formProblems,
  formToInput,
  initialForm,
} from '../../lib/campaign-form';
import { fmtN, ymdSP } from '../../lib/format';
import { useDebounced } from '../../lib/hooks';
import { LIMIT_REACHED_LABEL } from '../../lib/quota';
import { useWaInstances } from '../../lib/whatsapp';
import { Dialog } from '../ui';
import { CampaignFilterFields } from './CampaignFilterFields';
import { CampaignPreviewPanel } from './CampaignPreviewPanel';
import { CampaignSummary } from './CampaignSummary';

export type CampaignSaved = 'started' | 'scheduled' | 'updated';

/**
 * Configurar uma campanha: a lista e os filtros do público, os números, o horário e os dias, as datas, o limite e o
 * cooldown. Ao lado, a prévia do servidor (público, capacidade, estimativa e calendário). Para criar, há um resumo final
 * antes de "Iniciar campanha" (ou "Agendar campanha"). Com `campaign`, edita a que já existe: vale para os próximos leads.
 * Nada é enviado por este diálogo: quem seleciona os leads e envia é o servidor.
 */
export function CampaignDialog({
  automationId,
  automationName,
  campaign,
  onClose,
  onDone,
}: {
  automationId: number;
  automationName: string;
  campaign?: CampaignDetail;
  onClose: () => void;
  onDone: (campaign: CampaignDetail, kind: CampaignSaved) => void;
}) {
  const editing = campaign !== undefined;
  const lists = useQuery({
    queryKey: ['automation-lists'],
    queryFn: () => api<ListSummary[]>('/lists?archived=0'),
    staleTime: 60_000,
  });
  const instances = useWaInstances();
  const original = useRef(campaign ? formFromCampaign(campaign) : initialForm());
  const [form, setForm] = useState<CampaignFormState>(original.current);
  const [step, setStep] = useState<'form' | 'summary'>('form');
  const [error, setError] = useState<string | null>(null);
  const today = ymdSP();

  // Depois que o primeiro lead entra, a lista não muda; e só uma campanha ainda agendada muda a data inicial.
  const locked = editing && campaign.counts.total > 0;
  const startEditable = !editing || campaign.schedule.state === 'scheduled';

  const patch = (changes: Partial<CampaignFormState>) => {
    setError(null);
    setForm((f) => ({ ...f, ...changes }));
  };

  const problems = formProblems(form, today);
  const input = useMemo(() => formToInput(form, today), [form, today]);
  const inputKey = input ? JSON.stringify(input) : '';
  // A prévia consulta o servidor: espera a pessoa parar de digitar.
  const settledKey = useDebounced(inputKey, 350);
  const preview = useQuery({
    queryKey: ['automation-campaign-preview', automationId, settledKey],
    queryFn: () => automationsApi.campaignPreview(automationId, JSON.parse(settledKey)),
    enabled: settledKey !== '',
    staleTime: 0,
    placeholderData: keepPreviousData,
  });
  const data = settledKey === '' ? undefined : preview.data;
  const upToDate = inputKey !== '' && inputKey === settledKey && !preview.isFetching;

  const save = useMutation({
    mutationFn: async () => {
      if (!input) throw new Error('Confira os campos da campanha.');
      if (campaign) {
        return automationsApi.updateCampaign(automationId, campaign.id, changesFrom(original.current, form));
      }
      return automationsApi.startCampaign(automationId, input);
    },
    onSuccess: (saved) =>
      onDone(saved, editing ? 'updated' : form.when === 'scheduled' ? 'scheduled' : 'started'),
    onError: (e) => setError(errorMessage(e)),
  });

  const all = instances.data ?? [];
  const connected = all.filter((i) => i.status === 'open');
  const changed = editing ? Object.keys(changesFrom(original.current, form)).length > 0 : true;
  const canContinue =
    problems.length === 0 &&
    upToDate &&
    !!data &&
    data.audience.eligible > 0 &&
    data.connectedNumbers > 0 &&
    (editing ? changed : true);
  const scheduled = form.when === 'scheduled';
  const waiting = input
    ? null
    : !form.listId || form.numbers.length === 0
      ? 'Escolha a lista e pelo menos um número para ver quantos leads entram.'
      : 'Corrija os campos indicados para ver a prévia.';

  function toggleNumber(id: number) {
    patch({
      numbers: form.numbers.includes(id) ? form.numbers.filter((n) => n !== id) : [...form.numbers, id],
    });
  }

  function toggleDay(day: number) {
    patch({
      days: form.days.includes(day) ? form.days.filter((d) => d !== day) : normalizeDays([...form.days, day]),
    });
  }

  function submitForm(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (problems.length) return setError(problems[0] ?? null);
    if (editing) return save.mutate();
    setStep('summary');
  }

  const listName = lists.data?.find((l) => l.id === form.listId)?.name ?? '';
  const numberLabels = form.numbers.map((id) => {
    const i = all.find((n) => n.id === id);
    return i ? i.nickname || i.name : `Número ${id}`;
  });

  if (step === 'summary' && input && data) {
    return (
      <Dialog open onClose={onClose} title="Resumo da campanha">
        <div className="stack camp-form" style={{ gap: 16 }}>
          <CampaignSummary
            automationName={automationName}
            listName={listName}
            numberLabels={numberLabels}
            input={input}
            preview={data}
            scheduled={scheduled}
          />
          {error && (
            <p className="banner bad" role="alert">
              {error}
            </p>
          )}
          <div className="row end">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setStep('form')}
              disabled={save.isPending}
            >
              Voltar
            </button>
            <button type="button" className="btn btn-line" onClick={onClose} disabled={save.isPending}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={save.isPending}
              aria-busy={save.isPending}
              onClick={() => save.mutate()}
              data-testid="confirmar-campanha"
            >
              {scheduled ? 'Agendar campanha' : 'Iniciar campanha'}
            </button>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog open onClose={onClose} title={editing ? 'Editar campanha' : 'Nova campanha'}>
      <form className="stack auto-form camp-form" style={{ gap: 16 }} onSubmit={submitForm} noValidate>
        <p className="banner" role="note">
          <span>
            <b>Antes de iniciar:</b> mandar mensagem em massa para quem não pediu contato pode levar o
            WhatsApp a restringir ou banir o número. O limite diário, o horário de trabalho e o rodízio de
            números reduzem o volume por número, mas <b>não garantem</b> que o número não seja bloqueado.
          </span>
        </p>
        {editing && (
          <p className="sub">
            O que você mudar vale para os <b>próximos</b> leads. Quem já entrou continua como está
            {locked ? '; a lista não muda depois que o primeiro lead entrou' : ''}.
          </p>
        )}

        <section className="camp-section" aria-label="Lista">
          <label className="field">
            <span>Lista de leads</span>
            <select
              className="select"
              value={form.listId}
              onChange={(e) => patch({ listId: e.target.value })}
              disabled={lists.isLoading || locked}
              data-testid="campo-lista"
            >
              <option value="">Escolha a lista…</option>
              {(lists.data ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} — {fmtN(l.livres)} na fila livre
                </option>
              ))}
            </select>
            <small>
              Entram só os leads da fila livre (sem atendente), que não estão em "não contatar", têm celular e
              ainda não participam desta automação.
            </small>
          </label>
          <CampaignFilterFields form={form} onChange={patch} />
        </section>

        <fieldset className="field auto-numbers camp-section">
          <legend>Números de WhatsApp</legend>
          {instances.isLoading ? (
            <span className="spinner" role="status" aria-label="Carregando os números" />
          ) : all.length === 0 ? (
            <p className="note">Nenhum número cadastrado. Conecte um na tela Números.</p>
          ) : (
            <>
              <ul className="auto-number-list">
                {all.map((i) => {
                  const on = i.status === 'open';
                  return (
                    <li key={i.id} className={`auto-number${form.numbers.includes(i.id) ? ' on' : ''}`}>
                      <label>
                        <input
                          type="checkbox"
                          checked={form.numbers.includes(i.id)}
                          onChange={() => toggleNumber(i.id)}
                        />
                        <span className="auto-number-main">
                          <b>{i.nickname || i.name}</b>
                          <small>{i.phone ?? 'sem telefone conectado'}</small>
                          <small data-testid={`campanha-cota-${i.id}`}>
                            {i.usage.limitReached
                              ? LIMIT_REACHED_LABEL
                              : `${i.usage.total}/${i.usage.limit} hoje · disponível ${i.usage.remaining}`}
                          </small>
                        </span>
                        {i.usage.limitReached && <span className="pill t-bad">Limite atingido</span>}
                        <span className={`pill t-${on ? 'ok' : 'mute'}`}>
                          {on ? 'Conectado' : 'Desconectado'}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              <div className="row auto-number-tools">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() =>
                    patch({ numbers: connected.map((i) => i.id).slice(0, CAMPAIGN_MAX_NUMBERS) })
                  }
                >
                  Marcar os conectados
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => patch({ numbers: [] })}>
                  Limpar
                </button>
              </div>
            </>
          )}
          <small>
            Número desconectado fica fora do rodízio até voltar (e volta sozinho quando reconectar). Cada lead
            é atendido por um único número.
          </small>
        </fieldset>

        <p className="camp-note" data-testid="campo-audios">
          <b>Áudios:</b>{' '}
          {data
            ? data.activeAudios > 0
              ? `${data.activeAudios} ${data.activeAudios === 1 ? 'áudio ativo' : 'áudios ativos'} na biblioteca. Etapas que sorteiam áudio usam todos, sem repetir até usar o conjunto inteiro.`
              : 'nenhum áudio ativo na biblioteca.'
            : 'as etapas de áudio usam a biblioteca de áudios, com sorteio sem repetir.'}
        </p>

        <section className="camp-section" aria-label="Horário e dias">
          <div className="auto-camp-grid">
            <label className="field">
              <span>Horário de trabalho: das</span>
              <input
                className="input"
                type="time"
                step={60}
                value={form.windowStart}
                onChange={(e) => patch({ windowStart: e.target.value })}
                data-testid="campo-inicio-janela"
              />
            </label>
            <label className="field">
              <span>até</span>
              <input
                className="input"
                type="time"
                step={60}
                value={form.windowEnd}
                onChange={(e) => patch({ windowEnd: e.target.value })}
                data-testid="campo-fim-janela"
              />
            </label>
            <label className="field">
              <span>Contatos por número, por dia (no máximo {CAMPAIGN_MAX_DAILY_LIMIT})</span>
              <input
                className="input"
                inputMode="numeric"
                value={form.limitText}
                onChange={(e) => patch({ limitText: e.target.value })}
                aria-invalid={problems.some((p) => p.startsWith('O limite'))}
                data-testid="campo-limite"
              />
            </label>
          </div>
          <small className="auto-camp-hint">
            Horário de São Paulo: envia a partir do início e até antes do fim (das 10:00 às 16:00 envia às
            10:00 e não às 16:00). O limite é só das campanhas e não tem relação com o limite de leads que
            cada atendente pode pegar. A cota conta contatos manuais e automáticos juntos, e o dia recomeça à
            meia-noite.
          </small>

          <fieldset className="field camp-days" data-testid="campo-dias">
            <legend>Dias da semana</legend>
            <div className="camp-day-chips">
              {WEEKDAYS.map((d) => (
                <label key={d.iso} className={`camp-day${form.days.includes(d.iso) ? ' on' : ''}`}>
                  <input
                    type="checkbox"
                    checked={form.days.includes(d.iso)}
                    onChange={() => toggleDay(d.iso)}
                    aria-label={d.long}
                    data-testid={`dia-${d.iso}`}
                  />
                  <span>{d.short}</span>
                </label>
              ))}
            </div>
            <div className="row auto-number-tools">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => patch({ days: [...DEFAULT_DAYS] })}
              >
                Seg–Sex
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => patch({ days: [...ALL_DAYS] })}
              >
                Todos os dias
              </button>
              <span className="sub small">Executa: {formatDays(form.days)}</span>
            </div>
          </fieldset>
        </section>

        <section className="camp-section" aria-label="Início e fim">
          {!editing && (
            <fieldset className="field camp-when">
              <legend>Quando começar</legend>
              <label className="camp-radio">
                <input
                  type="radio"
                  name="camp-when"
                  checked={form.when === 'now'}
                  onChange={() => patch({ when: 'now' })}
                  data-testid="quando-agora"
                />
                <span>
                  <b>Iniciar agora</b>
                  <small>
                    Começa hoje. Fora do horário ou em dia sem execução, espera a próxima janela válida.
                  </small>
                </span>
              </label>
              <label className="camp-radio">
                <input
                  type="radio"
                  name="camp-when"
                  checked={form.when === 'scheduled'}
                  onChange={() => patch({ when: 'scheduled', startDate: form.startDate || '' })}
                  data-testid="quando-agendar"
                />
                <span>
                  <b>Agendar campanha</b>
                  <small>Fica "Agendada" e nada é enviado antes da data de início.</small>
                </span>
              </label>
            </fieldset>
          )}
          <div className="auto-camp-grid camp-dates">
            {(scheduled || (editing && startEditable)) && (
              <label className="field">
                <span>Data de início</span>
                <input
                  className="input"
                  type="date"
                  min={today}
                  value={form.startDate}
                  disabled={editing && !startEditable}
                  onChange={(e) => patch({ startDate: e.target.value, when: 'scheduled' })}
                  data-testid="campo-data-inicio"
                />
              </label>
            )}
            <label className="field">
              <span>Data final (opcional)</span>
              <input
                className="input"
                type="date"
                min={today}
                value={form.endDate}
                onChange={(e) => patch({ endDate: e.target.value })}
                data-testid="campo-data-fim"
              />
              <small>Vale até o fim desse dia. Sem data final, segue até acabarem os leads.</small>
            </label>
            <label className="field">
              <span>Cooldown (horas)</span>
              <input
                className="input"
                inputMode="numeric"
                value={form.cooldownText}
                onChange={(e) => patch({ cooldownText: e.target.value })}
                aria-invalid={problems.some((p) => p.startsWith('O cooldown'))}
                data-testid="campo-cooldown"
              />
              <small>
                Depois de um primeiro contato automático, o lead não recebe uma nova abordagem independente
                antes disso. As etapas seguintes da mesma execução não esperam. 0 = sem cooldown.
              </small>
            </label>
          </div>
        </section>

        <CampaignPreviewPanel
          preview={data}
          fetching={preview.isFetching}
          error={preview.error}
          waiting={waiting}
        />

        {problems.length > 0 && input === null && form.listId && form.numbers.length > 0 && (
          <ul className="camp-problems" role="alert">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {error && (
          <p className="banner bad" role="alert">
            {error}
          </p>
        )}

        <div className="row end">
          <button type="button" className="btn btn-line" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!canContinue || save.isPending}
            aria-busy={save.isPending}
            data-testid="continuar-campanha"
          >
            {editing ? 'Salvar alterações' : 'Revisar e continuar'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
