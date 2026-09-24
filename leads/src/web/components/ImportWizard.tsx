import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { ImportDraft, ImportOptions, ImportPreview, ImportState } from '../../shared/api';
import { api, errorMessage } from '../lib/api';
import { fmtDate, fmtN, plural } from '../lib/format';
import { useDebounced } from '../lib/hooks';
import { useTeam } from '../pages/CalledPage';
import { IconFile } from './Icons';
import { useToast } from './Toasts';
import { downloadText } from './ui';

const ACCEPT = '.xlsx,.xls,.xlsm,.ods,.csv,.txt,.tsv';

function modelCsv() {
  downloadText(
    'modelo-lista-de-leads.csv',
    '﻿Empresa;Sócio;Telefone;Cidade\r\nPadaria Exemplo Ltda;Maria da Silva;(00) 90000-0001;Curitiba\r\nOficina Modelo ME;João Pereira;(00) 90000-0002;Londrina\r\n',
  );
}

function Chooser({ onDraft }: { onDraft: (d: ImportDraft) => void }) {
  const toast = useToast();
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);

  async function send(file: File | undefined) {
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) {
      toast('Arquivo grande demais (máximo 25 MB). Divida a planilha em partes.', { tone: 'bad' });
      return;
    }
    setBusy(`Lendo ${file.name}…`);
    try {
      const fd = new FormData();
      fd.append('file', file, file.name);
      onDraft(await api<ImportDraft>('/imports/upload', { body: fd }));
    } catch (err) {
      toast(errorMessage(err), { tone: 'bad', ms: 9000 });
    } finally {
      setBusy(null);
    }
  }

  async function paste() {
    if (!text.trim()) return toast('Cole as linhas da planilha na caixa primeiro.');
    setBusy('Lendo as linhas…');
    try {
      onDraft(await api<ImportDraft>('/imports/paste', { body: { text } }));
    } catch (err) {
      toast(errorMessage(err), { tone: 'bad' });
    } finally {
      setBusy(null);
    }
  }

  if (busy) return <p className="sub">{busy}</p>;
  return (
    <>
      <label
        className={`drop${over ? ' over' : ''}`}
        htmlFor="imp-file"
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void send(e.dataTransfer.files?.[0]);
        }}
      >
        <span style={{ color: 'var(--accent)' }}>
          <IconFile />
        </span>
        <strong>Arraste a planilha aqui ou clique para escolher</strong>
        <span className="sub">
          .xlsx, .xls, .csv (até 25 MB). Precisa ter pelo menos uma coluna de telefone.
        </span>
      </label>
      <input
        ref={input}
        className="vh"
        type="file"
        id="imp-file"
        accept={ACCEPT}
        onChange={(e) => {
          void send(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <details className="paste">
        <summary>Ou cole as linhas copiadas da planilha</summary>
        <label className="vh" htmlFor="imp-paste">
          Linhas coladas
        </label>
        <textarea
          id="imp-paste"
          className="input"
          rows={5}
          placeholder={'Maria Silva\t(41) 99876-5432\nJoão Pereira\t11 98765-4321'}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="mt8">
          <button type="button" className="btn btn-line btn-sm" onClick={paste}>
            Usar estas linhas
          </button>
        </div>
      </details>
      <div className="mt12">
        <button type="button" className="link-btn" onClick={modelCsv}>
          Baixar planilha modelo (CSV)
        </button>
      </div>
    </>
  );
}

function Mapping({
  draft,
  onDraft,
  onReset,
  onStarted,
}: {
  draft: ImportDraft;
  onDraft: (d: ImportDraft) => void;
  onReset: () => void;
  onStarted: (s: ImportState) => void;
}) {
  const toast = useToast();
  const team = useTeam(true);
  const [opts, setOpts] = useState<ImportOptions>(draft.suggestion);
  const [committing, setCommitting] = useState(false);
  const debounced = useDebounced(opts, 350);
  const set = (p: Partial<ImportOptions>) => setOpts((o) => ({ ...o, ...p }));

  const preview = useQuery({
    queryKey: ['import-preview', draft.id, debounced],
    queryFn: () => api<ImportPreview>(`/imports/${draft.id}/preview`, { body: { ...debounced } }),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  async function redetect(p: { sheet?: string | null; hasHeader?: boolean }) {
    try {
      const d = await api<ImportDraft>(`/imports/${draft.id}/detect`, {
        body: {
          sheet: p.sheet !== undefined ? p.sheet : opts.sheet,
          hasHeader: p.hasHeader,
          listName: opts.listName,
        },
      });
      onDraft(d);
      setOpts((o) => ({
        ...o,
        sheet: d.sheet,
        hasHeader: d.suggestion.hasHeader,
        companyColumn: d.suggestion.companyColumn,
        nameColumn: d.suggestion.nameColumn,
        phoneColumn: d.suggestion.phoneColumn,
      }));
    } catch (err) {
      toast(errorMessage(err), { tone: 'bad' });
    }
  }

  async function commit() {
    setCommitting(true);
    try {
      onStarted(await api<ImportState>(`/imports/${draft.id}/commit`, { body: { ...opts } }));
    } catch (err) {
      toast(errorMessage(err), { tone: 'bad', ms: 9000 });
    } finally {
      setCommitting(false);
    }
  }

  const columns = preview.data?.columns ?? draft.columns;
  const p = preview.data;
  const dist = opts.distribution;
  const distUsers = dist.mode === 'dividir' ? dist.userIds : [];
  const canCommit =
    !!p &&
    p.counts.valid > 0 &&
    opts.listName.trim().length > 0 &&
    (dist.mode !== 'dividir' || distUsers.length > 0) &&
    !preview.isFetching;
  const dataRows = draft.sample.slice(opts.hasHeader ? 1 : 0, (opts.hasHeader ? 1 : 0) + 5);
  const picked = (i: number) => i === opts.phoneColumn || i === opts.nameColumn || i === opts.companyColumn;

  return (
    <>
      <div className="imp-file">
        <strong>{draft.fileName}</strong>
        <span className="sub">{plural(draft.rowCount - (opts.hasHeader ? 1 : 0), 'linha', 'linhas')}</span>
        <span className="grow" />
        <button type="button" className="btn btn-ghost btn-sm" onClick={onReset}>
          Trocar arquivo
        </button>
      </div>
      {draft.previous && (
        <p className="banner mt12">
          Este mesmo arquivo já foi importado em {fmtDate(draft.previous.date)}
          {draft.previous.listName ? ` (lista "${draft.previous.listName}")` : ''}. Os telefones repetidos
          serão pulados.
        </p>
      )}
      <div className="imp-grid">
        <label className="field">
          Nome da lista
          <input
            className="input"
            maxLength={80}
            value={opts.listName}
            onChange={(e) => set({ listName: e.target.value })}
          />
        </label>
        <label className="field">
          Coluna da empresa
          <select
            className="select input"
            value={opts.companyColumn}
            onChange={(e) => set({ companyColumn: Number(e.target.value) })}
          >
            <option value={-1}>(sem empresa)</option>
            {columns.map((c) => (
              <option key={c.index} value={c.index}>
                {c.letter} · {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Coluna do sócio / proprietário
          <select
            className="select input"
            value={opts.nameColumn}
            onChange={(e) => set({ nameColumn: Number(e.target.value) })}
          >
            <option value={-1}>(sem nome)</option>
            {columns.map((c) => (
              <option key={c.index} value={c.index}>
                {c.letter} · {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Coluna do telefone
          <select
            className="select input"
            value={opts.phoneColumn}
            onChange={(e) => set({ phoneColumn: Number(e.target.value) })}
          >
            {columns.map((c) => (
              <option key={c.index} value={c.index}>
                {c.letter} · {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          DDD padrão <small>só para números sem DDD</small>
          <input
            className="input"
            inputMode="numeric"
            maxLength={2}
            placeholder="ex.: 11"
            value={opts.defaultDdd ?? ''}
            onChange={(e) => set({ defaultDdd: e.target.value.replace(/\D/g, '') || null })}
          />
        </label>
        {draft.sheets.length > 1 && (
          <label className="field">
            Aba da planilha
            <select
              className="select input"
              value={opts.sheet ?? ''}
              onChange={(e) => redetect({ sheet: e.target.value })}
            >
              {draft.sheets.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="prev-wrap mt12">
        <table className="prev">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.index} className={picked(c.index) ? 'pick' : ''}>
                  {c.letter}
                  {c.index === opts.companyColumn ? ' · empresa' : ''}
                  {c.index === opts.phoneColumn
                    ? ' · telefone'
                    : c.index === opts.nameColumn
                      ? ' · nome'
                      : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {opts.hasHeader && (
              <tr className="header-row">
                {columns.map((c) => (
                  <td key={c.index}>{draft.sample[0]?.[c.index] ?? ''}</td>
                ))}
              </tr>
            )}
            {dataRows.map((r, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: amostra fixa
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c.index} className={picked(c.index) ? 'pick' : ''}>
                    {r[c.index] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="imp-opts">
        <label className="check">
          <input
            type="checkbox"
            checked={opts.hasHeader}
            onChange={(e) => redetect({ hasHeader: e.target.checked })}
          />
          A primeira linha é o cabeçalho (títulos das colunas)
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={opts.dedupeInFile}
            onChange={(e) => set({ dedupeInFile: e.target.checked })}
          />
          Pular telefones repetidos dentro do arquivo
        </label>
        <label className="field" style={{ maxWidth: 520 }}>
          Telefones que já estão no sistema
          <select
            className="select input"
            value={opts.dedupeBase}
            onChange={(e) => set({ dedupeBase: e.target.value as ImportOptions['dedupeBase'] })}
          >
            <option value="todos">Pular, inclusive quem já foi chamado (recomendado)</option>
            <option value="pendentes">Pular só quem ainda está esperando contato</option>
            <option value="nenhum">Importar mesmo assim</option>
          </select>
        </label>
        <fieldset className="dist">
          <legend>Como distribuir</legend>
          <label className="check">
            <input
              type="radio"
              name="dist"
              checked={dist.mode === 'fila'}
              onChange={() => set({ distribution: { mode: 'fila' } })}
            />
            <span>
              Fila livre
              <small>
                Cada atendente clica em "Pegar mais leads" quando precisar. Ninguém pega o mesmo lead.
              </small>
            </span>
          </label>
          <label className="check">
            <input
              type="radio"
              name="dist"
              checked={dist.mode === 'dividir'}
              onChange={() =>
                set({
                  distribution: {
                    mode: 'dividir',
                    userIds: (team.data ?? []).filter((u) => u.role === 'atendente').map((u) => u.id),
                  },
                })
              }
            />
            <span>
              Dividir agora entre a equipe
              <small>Os leads são repartidos em partes iguais entre os marcados.</small>
            </span>
          </label>
          {dist.mode === 'dividir' && (
            <div className="dist-to">
              {team.data?.map((u) => (
                <label key={u.id} className="check" style={{ alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    style={{ margin: 0 }}
                    checked={distUsers.includes(u.id)}
                    onChange={(e) =>
                      set({
                        distribution: {
                          mode: 'dividir',
                          userIds: e.target.checked
                            ? [...distUsers, u.id]
                            : distUsers.filter((x) => x !== u.id),
                        },
                      })
                    }
                  />
                  {u.name}
                </label>
              ))}
            </div>
          )}
          <label className="check">
            <input
              type="radio"
              name="dist"
              checked={dist.mode === 'pessoa'}
              disabled={!team.data?.length}
              onChange={() =>
                team.data?.[0] && set({ distribution: { mode: 'pessoa', userId: team.data[0].id } })
              }
            />
            <span>Tudo para uma pessoa</span>
          </label>
          {dist.mode === 'pessoa' && (
            <div className="dist-to">
              <select
                className="select input"
                style={{ maxWidth: 280 }}
                value={dist.userId}
                onChange={(e) => set({ distribution: { mode: 'pessoa', userId: e.target.value } })}
              >
                {team.data?.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </fieldset>
      </div>

      <div className="imp-sum" aria-live="polite">
        {preview.isError ? (
          <p className="error-text">{errorMessage(preview.error)}</p>
        ) : !p ? (
          <p className="sub">Conferindo os telefones…</p>
        ) : (
          <>
            <div className="chips" style={{ opacity: preview.isFetching ? 0.6 : 1 }}>
              <span className="chip good">
                {plural(p.counts.valid, 'pronto para importar', 'prontos para importar')}
              </span>
              <span className="chip good">
                {plural(p.counts.companies, 'empresa', 'empresas')} ·{' '}
                {plural(p.counts.phones, 'telefone', 'telefones')}
              </span>
              {p.counts.duplicatesInFile > 0 && (
                <span className="chip">
                  {plural(p.counts.duplicatesInFile, 'repetido no arquivo', 'repetidos no arquivo')}
                </span>
              )}
              {p.counts.duplicatesInBase > 0 && (
                <span className="chip">
                  {plural(p.counts.duplicatesInBase, 'já está no sistema', 'já estão no sistema')}
                </span>
              )}
              {p.counts.invalid > 0 && (
                <span className="chip warn">
                  {plural(p.counts.invalid, 'sem telefone válido', 'sem telefone válido')}
                </span>
              )}
              {p.counts.blocked > 0 && (
                <span className="chip bad">
                  {plural(p.counts.blocked, 'na lista de não contatar', 'na lista de não contatar')}
                </span>
              )}
              {p.perAttendant.length > 0 && (
                <span className="chip">
                  {p.perAttendant.map((x) => `${x.user.name}: ${fmtN(x.count)}`).join(' · ')}
                </span>
              )}
            </div>
            {p.validSample.length > 0 && (
              <div className="prev-wrap">
                <table className="prev">
                  <thead>
                    <tr>
                      <th>Empresa</th>
                      <th>Sócio</th>
                      <th>WhatsApp</th>
                      {p.extraColumns.slice(0, 3).map((k) => (
                        <th key={k}>{k}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {p.validSample.slice(0, 6).map((v) => (
                      <tr key={v.rowNumber}>
                        <td>{v.company || '—'}</td>
                        <td>{v.name || '—'}</td>
                        <td className="phone">
                          {v.phoneDisplay}
                          {v.phoneType === 'fixo' ? ' (fixo)' : ''}
                        </td>
                        {p.extraColumns.slice(0, 3).map((k) => (
                          <td key={k}>{v.extra[k] ?? ''}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {p.rejectedSample.length > 0 && (
              <details>
                <summary className="link-btn" style={{ display: 'inline' }}>
                  Ver exemplos de linhas que não vão entrar
                </summary>
                <div className="prev-wrap mt8">
                  <table className="prev">
                    <thead>
                      <tr>
                        <th>Linha</th>
                        <th>Motivo</th>
                        <th>Telefone na planilha</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.rejectedSample.map((r) => (
                        <tr key={r.rowNumber}>
                          <td>{r.rowNumber}</td>
                          <td>{r.reason}</td>
                          <td>{r.values[opts.phoneColumn] ?? ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="sub mt8">
                  Depois de importar, dá para baixar a lista completa das linhas recusadas, com o motivo.
                </p>
              </details>
            )}
            {p.counts.invalid > 0 && !opts.defaultDdd && (
              <p className="sub">
                Telefones precisam ter DDD (ex.: 41 99876-5432). Se a lista vem sem DDD, preencha o DDD
                padrão.
              </p>
            )}
            <div>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!canCommit || committing}
                onClick={commit}
              >
                {committing ? 'Enviando…' : `Importar ${plural(p.counts.valid, 'lead', 'leads')}`}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function Progress({ state, onDone }: { state: ImportState; onDone: (s: ImportState) => void }) {
  const q = useQuery({
    queryKey: ['import-state', state.id],
    queryFn: () => api<ImportState>(`/imports/${state.id}`),
    refetchInterval: (query) => (query.state.data && query.state.data.status !== 'processando' ? false : 700),
    initialData: state,
  });
  const s = q.data;
  useEffect(() => {
    if (s && s.status !== 'processando') onDone(s);
  }, [s, onDone]);
  const pr = s?.progress;
  const pct = pr?.total ? (pr.done / pr.total) * 100 : 5;
  return (
    <div className="stack" style={{ gap: 10 }}>
      <p style={{ fontWeight: 600 }}>
        {pr?.phase ?? 'Importando'}… {pr?.total ? `${fmtN(pr.done)} de ${fmtN(pr.total)}` : ''}
      </p>
      <div className="progress">
        <i style={{ width: `${pct.toFixed(1)}%` }} />
      </div>
      <p className="sub">Pode continuar usando o sistema. A lista só aparece quando tudo estiver gravado.</p>
    </div>
  );
}

export function ImportWizard() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<ImportDraft | null>(null);
  const [running, setRunning] = useState<ImportState | null>(null);
  const [finished, setFinished] = useState<ImportState | null>(null);

  const reset = () => {
    if (draft && !running && !finished)
      void api(`/imports/${draft.id}`, { method: 'DELETE' }).catch(() => {});
    setDraft(null);
    setRunning(null);
    setFinished(null);
  };

  if (finished) {
    const ok = finished.status === 'concluida';
    return (
      <div className="stack" style={{ gap: 12 }}>
        {ok ? (
          <p className="banner info">
            <b>Lista "{finished.list?.name}" importada:</b>{' '}
            {plural(finished.counts?.companies ?? finished.counts?.valid ?? 0, 'empresa', 'empresas')},{' '}
            {plural(finished.counts?.phones ?? finished.counts?.valid ?? 0, 'telefone', 'telefones')} (
            {plural(finished.counts?.valid ?? 0, 'lead', 'leads')}).
            {finished.rejectedCount > 0 &&
              ` ${plural(finished.rejectedCount, 'linha ficou', 'linhas ficaram')} de fora.`}
          </p>
        ) : (
          <p className="banner bad">
            <b>A importação falhou:</b> {finished.error} Nenhum lead foi gravado.
          </p>
        )}
        <div className="row">
          {ok && finished.rejectedCount > 0 && (
            <a className="btn btn-line" href={`/api/imports/${finished.id}/rejeitados.csv`} download>
              Baixar linhas recusadas (CSV, com o motivo)
            </a>
          )}
          {!ok && draft && (
            <button type="button" className="btn btn-primary" onClick={() => setFinished(null)}>
              Voltar e tentar de novo
            </button>
          )}
          <button type="button" className="btn btn-ghost" onClick={reset}>
            Importar outra lista
          </button>
        </div>
      </div>
    );
  }
  if (running) {
    return (
      <Progress
        state={running}
        onDone={(s) => {
          setRunning(null);
          setFinished(s);
          qc.invalidateQueries();
        }}
      />
    );
  }
  if (draft)
    return <Mapping key={draft.id} draft={draft} onDraft={setDraft} onReset={reset} onStarted={setRunning} />;
  return <Chooser onDraft={setDraft} />;
}
