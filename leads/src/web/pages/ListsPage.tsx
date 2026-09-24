import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ImportState, ListSummary } from '../../shared/api';
import { IconDots } from '../components/Icons';
import { ImportWizard } from '../components/ImportWizard';
import { useToast } from '../components/Toasts';
import { Confirm, Dialog, Menu } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { fmtDate, fmtN, fmtWhen, plural } from '../lib/format';
import { useSession } from '../lib/session';

const STATUS: Record<ImportState['status'], string> = {
  rascunho: 'Rascunho',
  processando: 'Importando…',
  concluida: 'Concluída',
  falhou: 'Falhou',
  descartada: 'Descartada',
};

function DeleteListDialog({ list, onClose }: { list: ListSummary | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  if (!list) return null;
  return (
    <Dialog open onClose={onClose} title="Excluir lista">
      <p>
        Isso apaga os <b>{fmtN(list.total)} leads</b> da lista <b>"{list.name}"</b> e todo o histórico deles,
        inclusive quem foi chamado e os resultados. Não dá para desfazer. Se quer só tirar da fila, use{' '}
        <b>Arquivar</b>.
      </p>
      <label className="field">
        Para confirmar, digite o nome da lista
        <input
          className="input"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="off"
        />
      </label>
      <div className="row end">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Cancelar
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={busy || confirm.trim().toLowerCase() !== list.name.trim().toLowerCase()}
          onClick={async () => {
            setBusy(true);
            try {
              await api(`/lists/${list.id}/delete`, { body: { confirm } });
              toast(`Lista "${list.name}" excluída.`);
              qc.invalidateQueries();
              onClose();
            } catch (err) {
              toast(errorMessage(err), { tone: 'bad' });
            } finally {
              setBusy(false);
            }
          }}
        >
          Excluir definitivamente
        </button>
      </div>
    </Dialog>
  );
}

export function ListsPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [archived, setArchived] = useState(false);
  const [deleting, setDeleting] = useState<ListSummary | null>(null);
  const [archiving, setArchiving] = useState<ListSummary | null>(null);
  const [renaming, setRenaming] = useState<ListSummary | null>(null);
  const [newName, setNewName] = useState('');
  const lists = useQuery({
    queryKey: ['lists', archived],
    queryFn: () => api<ListSummary[]>(`/lists?archived=${archived ? 1 : 0}`),
  });
  const imports = useQuery({ queryKey: ['imports'], queryFn: () => api<ImportState[]>('/imports') });

  async function setListArchived(l: ListSummary, value: boolean) {
    try {
      await api(`/lists/${l.id}/archive`, { body: { archived: value } });
      toast(
        value
          ? `Lista "${l.name}" arquivada: os leads pendentes saíram da fila livre.`
          : `Lista "${l.name}" voltou a ficar ativa.`,
      );
      qc.invalidateQueries();
    } catch (err) {
      toast(errorMessage(err), { tone: 'bad' });
    }
  }

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Listas</h1>
      </div>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Importar lista de leads</h2>
            <p className="sub">
              Excel ou CSV. O sistema encontra as colunas de empresa, sócio e telefone sozinho e mostra tudo
              antes de gravar.
            </p>
          </div>
        </div>
        <ImportWizard />
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>{archived ? 'Listas arquivadas' : 'Listas ativas'}</h2>
          <label className="check" style={{ alignItems: 'center' }}>
            <input
              type="checkbox"
              style={{ margin: 0 }}
              checked={archived}
              onChange={(e) => setArchived(e.target.checked)}
            />
            Mostrar arquivadas
          </label>
        </div>
        {!lists.data?.length ? (
          <p className="sub">
            {lists.isLoading
              ? 'Carregando…'
              : archived
                ? 'Nenhuma lista arquivada.'
                : 'Nenhuma lista importada ainda.'}
          </p>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Lista</th>
                  <th className="l">Importada</th>
                  <th>Empresas</th>
                  <th>Telefones</th>
                  <th title="Empresas e leads que ainda estão na fila livre">Faltam pegar</th>
                  <th>Chamados</th>
                  <th style={{ width: '18%' }}>Já pegos</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(lists.data ?? [])
                  .filter((l) => l.archived === archived)
                  .map((l) => {
                    const done = l.chamados + l.semWhatsapp;
                    // Andamento: quanto da lista já saiu da fila livre (pego por alguém ou bloqueado).
                    const p = l.total ? ((l.total - l.livres) / l.total) * 100 : 0;
                    return (
                      <tr key={l.id}>
                        <td>
                          <b style={{ fontWeight: 600 }}>{l.name}</b>
                          {l.sourceFile && <div className="sub small">{l.sourceFile}</div>}
                        </td>
                        <td className="l sub">
                          {fmtDate(l.createdAt)}
                          {l.createdBy ? ` · ${l.createdBy.name}` : ''}
                        </td>
                        <td>{fmtN(l.empresas)}</td>
                        <td>{fmtN(l.telefones)}</td>
                        <td>
                          <b>{fmtN(l.empresasLivres)}</b>
                          <div className="sub small">{plural(l.livres, 'lead', 'leads')}</div>
                        </td>
                        <td>{fmtN(done)}</td>
                        <td>
                          <div className="row" style={{ flexWrap: 'nowrap' }}>
                            <div className="progress grow" title={`${Math.round(p)}%`}>
                              <i style={{ width: `${p.toFixed(1)}%` }} />
                            </div>
                            <span className="sub small">{Math.round(p)}%</span>
                          </div>
                        </td>
                        <td>
                          {can('manageLists') && (
                            <Menu label={`Ações da lista ${l.name}`} icon={<IconDots />}>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setRenaming(l);
                                  setNewName(l.name);
                                }}
                              >
                                Renomear
                              </button>
                              {l.archived ? (
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => setListArchived(l, false)}
                                >
                                  Desarquivar
                                </button>
                              ) : (
                                <button type="button" role="menuitem" onClick={() => setArchiving(l)}>
                                  Arquivar (tirar da fila)
                                </button>
                              )}
                              {can('deleteLists') && (
                                <>
                                  <hr />
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className="danger"
                                    onClick={() => setDeleting(l)}
                                  >
                                    Excluir lista e leads (só o dono)
                                  </button>
                                </>
                              )}
                            </Menu>
                          )}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Importações recentes</h2>
        {!imports.data?.length ? (
          <p className="sub mt8">Nenhuma importação ainda.</p>
        ) : (
          <div className="tbl-wrap mt8">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Arquivo</th>
                  <th className="l">Quando</th>
                  <th className="l">Situação</th>
                  <th>Entraram</th>
                  <th>Recusadas</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {imports.data.map((i) => (
                  <tr key={i.id}>
                    <td>
                      {i.fileName}
                      {i.list && <div className="sub small">Lista: {i.list.name}</div>}
                    </td>
                    <td className="l sub">
                      {fmtWhen(i.createdAt)}
                      {i.createdBy ? ` · ${i.createdBy.name}` : ''}
                    </td>
                    <td className="l">
                      <span
                        className={`tag${i.status === 'falhou' ? ' bad' : i.status === 'concluida' ? '' : ' info'}`}
                      >
                        {STATUS[i.status]}
                      </span>
                      {i.status === 'falhou' && i.error && <div className="sub small">{i.error}</div>}
                    </td>
                    <td>{i.counts ? fmtN(i.counts.valid) : '—'}</td>
                    <td>{i.counts ? fmtN(i.rejectedCount) : '—'}</td>
                    <td>
                      {i.status === 'concluida' && i.rejectedCount > 0 && (
                        <a
                          className="btn btn-ghost btn-sm"
                          href={`/api/imports/${i.id}/rejeitados.csv`}
                          download
                        >
                          Baixar recusadas
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <DeleteListDialog list={deleting} onClose={() => setDeleting(null)} />
      <Confirm
        open={!!archiving}
        title="Arquivar lista?"
        confirmLabel="Arquivar"
        onClose={() => setArchiving(null)}
        onConfirm={() => {
          if (archiving) void setListArchived(archiving, true);
          setArchiving(null);
        }}
      >
        <p>
          Os leads ainda livres da lista "{archiving?.name}" deixam de ser entregues quando alguém clicar em
          "Pegar mais leads". Nada é apagado e dá para desarquivar depois.{' '}
          {archiving &&
            archiving.comAtendentes > 0 &&
            `${plural(archiving.comAtendentes, 'lead que já está', 'leads que já estão')} com atendentes continua lá.`}
        </p>
      </Confirm>
      <Dialog open={!!renaming} onClose={() => setRenaming(null)} title="Renomear lista">
        <form
          className="stack"
          style={{ gap: 12 }}
          onSubmit={async (e) => {
            e.preventDefault();
            if (!renaming) return;
            try {
              await api(`/lists/${renaming.id}`, { method: 'PATCH', body: { name: newName } });
              qc.invalidateQueries();
              setRenaming(null);
            } catch (err) {
              toast(errorMessage(err), { tone: 'bad' });
            }
          }}
        >
          <label className="field">
            Nome
            <input
              className="input"
              maxLength={80}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
          </label>
          <div className="row end">
            <button type="submit" className="btn btn-primary" disabled={!newName.trim()}>
              Salvar
            </button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
