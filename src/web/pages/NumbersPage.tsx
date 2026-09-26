import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type CSSProperties, useState } from 'react';
import type { TeamMember } from '../../shared/api';
import type { InstanceInfo } from '../../shared/conversations';
import {
  IconDots,
  IconPencil,
  IconPlus,
  IconQr,
  IconSmartphone,
  IconTrash,
  IconX,
} from '../components/Icons';
import { QuotaMeter } from '../components/QuotaMeter';
import { useToast } from '../components/Toasts';
import { Dialog, Empty, Menu } from '../components/ui';
import { QrDialog } from '../components/wa/QrDialog';
import { api, errorMessage } from '../lib/api';
import { plural } from '../lib/format';
import { LIMIT_REACHED_LABEL, usageBreakdown } from '../lib/quota';
import { useSession } from '../lib/session';
import {
  formatPhone,
  instanceColor,
  instanceLabel,
  statusInfo,
  useWaInstances,
  WA_INSTANCES,
  WA_STATS,
  wa,
} from '../lib/whatsapp';

/**
 * Números de WhatsApp: cada pessoa cadastra e conecta os próprios números (e só ela, e a gestão, vê as
 * conversas deles). Dono e administrador cuidam de todos e escolhem o responsável de cada número.
 */
export function NumbersPage() {
  const qc = useQueryClient();
  const { can } = useSession();
  const seeAll = can('seeAllNumbers');
  const instances = useWaInstances();
  const team = useQuery({
    queryKey: ['team'],
    queryFn: () => api<TeamMember[]>('/team'),
    enabled: can('manageNumbers'),
    staleTime: 60_000,
  });
  const list = instances.data ?? [];
  const [connectingId, setConnectingId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const connected = list.filter((i) => i.status === 'open').length;
  const disconnected = list.length - connected;
  const connecting = list.find((i) => i.id === connectingId);

  const save = (updated: InstanceInfo) =>
    qc.setQueryData<InstanceInfo[]>(WA_INSTANCES, (prev = []) =>
      prev.some((i) => i.id === updated.id)
        ? prev.map((i) => (i.id === updated.id ? updated : i))
        : [...prev, updated].sort((a, b) => a.name.localeCompare(b.name)),
    );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Números</h1>
          <p className="sub">
            {seeAll
              ? 'Os WhatsApps da equipe. Cada atendente vê só as conversas dos números de que é responsável.'
              : 'Os seus números de WhatsApp. Só você e a gestão veem as conversas deles.'}
          </p>
        </div>
        {list.length > 0 && (
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
            <IconPlus /> Adicionar número
          </button>
        )}
      </div>

      {list.length > 0 && (
        <div className="row wa-num-stats">
          <span className="tag ok">{plural(connected, 'conectado', 'conectados')}</span>
          {disconnected > 0 && (
            <span className="tag bad">{plural(disconnected, 'desconectado', 'desconectados')}</span>
          )}
        </div>
      )}

      {instances.isLoading ? (
        <div className="wa-num-grid" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="panel skel wa-num-skel" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <section className="panel mt16">
          <Empty
            title={seeAll ? 'Nenhum número ainda' : 'Você ainda não tem número'}
            icon={<IconSmartphone />}
          >
            <p>Adicione o número e escaneie o QR Code com o celular dele.</p>
            <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
              <IconPlus /> Adicionar número
            </button>
          </Empty>
        </section>
      ) : (
        <div className="wa-num-grid">
          {list.map((instance) => (
            <NumberCard
              key={instance.id}
              instance={instance}
              team={team.data}
              onSaved={save}
              onConnect={() => setConnectingId(instance.id)}
            />
          ))}
          <button type="button" className="wa-num-add" onClick={() => setAdding(true)}>
            <IconPlus size={22} />
            Adicionar número
          </button>
        </div>
      )}

      {adding && (
        <AddNumberDialog
          onClose={() => setAdding(false)}
          onCreated={(instance) => {
            save(instance);
            setAdding(false);
            setConnectingId(instance.id); // já abre o QR Code do número novo
          }}
        />
      )}
      {connecting && <QrDialog instance={connecting} onClose={() => setConnectingId(null)} />}
    </>
  );
}

function NumberCard({
  instance,
  team,
  onSaved,
  onConnect,
}: {
  instance: InstanceInfo;
  /** Equipe ativa, para o dono e o administrador escolherem o responsável. */
  team: TeamMember[] | undefined;
  onSaved: (instance: InstanceInfo) => void;
  onConnect: () => void;
}) {
  const toast = useToast();
  const { me, can } = useSession();
  const [editing, setEditing] = useState(false);
  const [nickname, setNickname] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const status = statusInfo(instance.status);
  const manageAll = can('manageNumbers');
  const canManage = manageAll || instance.owner?.id === me?.id;
  // Responsável desativado não aparece na equipe: continua na lista para não sumir da seleção.
  const people =
    instance.owner && team && !team.some((p) => p.id === instance.owner?.id)
      ? [...team, { id: instance.owner.id, name: instance.owner.name, role: 'atendente' as const }]
      : (team ?? []);

  const changeOwner = async (ownerId: string | null) => {
    try {
      const updated = await wa.setInstanceOwner(instance.id, ownerId);
      onSaved(updated);
      toast(
        updated.owner
          ? `Agora ${updated.owner.name} é responsável por ${instanceLabel(updated)}.`
          : `${instanceLabel(updated)} ficou sem responsável.`,
      );
    } catch (e) {
      toast(errorMessage(e), { tone: 'bad' });
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      onSaved(await wa.renameInstance(instance.id, nickname));
      setEditing(false);
      toast('Apelido salvo.');
    } catch (e) {
      toast(errorMessage(e), { tone: 'bad' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className="panel wa-num" style={{ '--wa-color': instanceColor(instance.id) } as CSSProperties}>
      <div className="wa-num-top">
        <span className="wa-num-ic" aria-hidden="true">
          <IconSmartphone size={22} />
        </span>
        <div className="wa-num-info">
          <div className="wa-num-title">
            <b>{instanceLabel(instance)}</b>
            {!editing && canManage && (
              <button
                type="button"
                className="icon-btn"
                aria-label="Editar apelido"
                title="Editar apelido"
                onClick={() => {
                  setNickname(instance.nickname ?? '');
                  setEditing(true);
                }}
              >
                <IconPencil />
              </button>
            )}
          </div>
          <span className="wa-num-phone">
            {instance.phone ? formatPhone(instance.phone) : 'Número ainda não conectado'}
          </span>
          <span className="sub small">Identificação: {instance.name}</span>
        </div>
        {canManage && (
          <Menu label={`Mais opções do número ${instanceLabel(instance)}`} icon={<IconDots />}>
            <button type="button" role="menuitem" className="danger" onClick={() => setDeleting(true)}>
              <IconTrash /> Excluir número
            </button>
          </Menu>
        )}
      </div>
      {deleting && <DeleteNumberDialog instance={instance} onClose={() => setDeleting(false)} />}

      {manageAll ? (
        <label className="wa-num-owner">
          <span>Responsável</span>
          <select
            className="select"
            value={instance.owner?.id ?? ''}
            onChange={(e) => void changeOwner(e.target.value || null)}
          >
            <option value="">Sem responsável (só a gestão vê)</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="wa-num-owner">
          <span>Responsável</span>
          <b>{instance.owner?.id === me?.id ? 'Você' : (instance.owner?.name ?? 'Sem responsável')}</b>
        </p>
      )}

      {editing && (
        <form
          className="wa-rename"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            className="input"
            value={nickname}
            maxLength={60}
            autoFocus
            aria-label="Apelido do número"
            placeholder="Apelido"
            onChange={(e) => setNickname(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditing(false);
            }}
          />
          <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
            Salvar
          </button>
          <button type="button" className="icon-btn" onClick={() => setEditing(false)} aria-label="Cancelar">
            <IconX />
          </button>
        </form>
      )}

      <div className="wa-num-usage" data-testid={`numero-uso-${instance.id}`}>
        <div className="wa-num-usage-top">
          <b data-testid={`numero-uso-total-${instance.id}`}>
            {instance.usage.total}/{instance.usage.limit} contatos hoje
          </b>
          {instance.usage.limitReached && <span className="tag bad">{LIMIT_REACHED_LABEL}</span>}
        </div>
        <QuotaMeter
          total={instance.usage.total}
          limit={instance.usage.limit}
          label={`Contatos de hoje: ${instanceLabel(instance)}`}
        />
        <span className="sub small">
          {usageBreakdown(instance.usage)}
          {instance.usage.limitReached ? ' · sem novos contatos até amanhã' : ''}
        </span>
      </div>

      <div className="wa-num-foot">
        <span className={`tag ${status.tone}`}>{status.label}</span>
        {instance.status !== 'open' ? (
          canManage ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={onConnect}>
              <IconQr size={16} /> {instance.phone ? 'Reconectar' : 'Conectar'}
            </button>
          ) : (
            <span className="sub small">Só o responsável ou um administrador reconecta</span>
          )
        ) : (
          <span className="sub small">Recebendo mensagens</span>
        )}
      </div>
    </article>
  );
}

function AddNumberDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (instance: InstanceInfo) => void;
}) {
  const [nickname, setNickname] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (!nickname.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      onCreated(await wa.createInstance(nickname.trim()));
    } catch (e) {
      setError(errorMessage(e));
      setCreating(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title="Adicionar número">
      <form
        className="stack"
        style={{ gap: 16 }}
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <p className="sub">
          Dê um apelido para reconhecer o número no sistema. Em seguida, é só escanear o QR Code.
        </p>
        <label className="field">
          Apelido
          <input
            className="input"
            value={nickname}
            maxLength={60}
            placeholder="Ex.: WhatsApp 3 - João"
            autoFocus
            onChange={(e) => setNickname(e.target.value)}
          />
        </label>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="row end">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={!nickname.trim() || creating}>
            <IconQr size={16} /> {creating ? 'Criando…' : 'Criar e conectar'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Excluir o número: desconecta do celular (sai de "Dispositivos conectados"), tira da Evolution e apaga do
 * sistema as conversas e mensagens dele. Para confirmar, a pessoa digita EXCLUIR.
 */
function DeleteNumberDialog({ instance, onClose }: { instance: InstanceInfo; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const label = instanceLabel(instance);
  return (
    <Dialog open onClose={onClose} title="Excluir número">
      <p>
        O número <b>{label}</b>
        {instance.phone ? ` (${formatPhone(instance.phone)})` : ''} sai do sistema: é desconectado (some de
        "Dispositivos conectados" no celular) e{' '}
        <b>todas as conversas e mensagens dele são apagadas do sistema</b>, com os áudios, fotos e documentos.
        O WhatsApp do celular continua funcionando normalmente. Não dá para desfazer.
      </p>
      <label className="field">
        Para confirmar, digite EXCLUIR
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
          disabled={busy || confirm.trim().toLowerCase() !== 'excluir'}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await wa.deleteInstance(instance.id, confirm);
              qc.setQueryData<InstanceInfo[]>(WA_INSTANCES, (prev) =>
                prev?.filter((i) => i.id !== instance.id),
              );
              void qc.invalidateQueries({ queryKey: WA_STATS });
              toast(
                `${label} excluído (${plural(r.conversations, 'conversa apagada', 'conversas apagadas')}).`,
              );
              onClose();
            } catch (err) {
              toast(errorMessage(err), { tone: 'bad' });
              setBusy(false);
            }
          }}
        >
          Excluir número
        </button>
      </div>
    </Dialog>
  );
}
