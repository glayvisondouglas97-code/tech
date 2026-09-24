import { useQueryClient } from '@tanstack/react-query';
import { type CSSProperties, useState } from 'react';
import type { InstanceInfo } from '../../shared/conversations';
import { IconPencil, IconPlus, IconQr, IconSmartphone, IconX } from '../components/Icons';
import { useToast } from '../components/Toasts';
import { Dialog, Empty } from '../components/ui';
import { QrDialog } from '../components/wa/QrDialog';
import { errorMessage } from '../lib/api';
import { plural } from '../lib/format';
import {
  formatPhone,
  instanceColor,
  instanceLabel,
  statusInfo,
  useWaInstances,
  WA_INSTANCES,
  wa,
} from '../lib/whatsapp';

/** Números de WhatsApp da equipe: adicionar, conectar pelo QR Code, reconectar e trocar o apelido. */
export function NumbersPage() {
  const qc = useQueryClient();
  const instances = useWaInstances();
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
          <p className="sub">Os WhatsApps da equipe conectados ao sistema.</p>
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
          <Empty title="Nenhum número ainda" icon={<IconSmartphone />}>
            <p>Adicione o primeiro número e escaneie o QR Code com o celular dele.</p>
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
  onSaved,
  onConnect,
}: {
  instance: InstanceInfo;
  onSaved: (instance: InstanceInfo) => void;
  onConnect: () => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [nickname, setNickname] = useState('');
  const [saving, setSaving] = useState(false);
  const status = statusInfo(instance.status);

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
            {!editing && (
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
      </div>

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

      <div className="wa-num-foot">
        <span className={`tag ${status.tone}`}>{status.label}</span>
        {instance.status !== 'open' ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={onConnect}>
            <IconQr size={16} /> {instance.phone ? 'Reconectar' : 'Conectar'}
          </button>
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
