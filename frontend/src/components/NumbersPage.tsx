import { Pencil, Plus, QrCode, Smartphone, X } from 'lucide-react';
import { useState, type CSSProperties } from 'react';
import { api, type InstanceInfo } from '../api.ts';
import { formatPhone, instanceColor, instanceLabel, statusInfo } from '../format.ts';
import { QrModal } from './QrModal.tsx';
import { EmptyState, FormError, Modal, Spinner, toast } from './ui.tsx';

type Props = {
  instances: InstanceInfo[];
  loaded: boolean;
  onInstanceSaved: (instance: InstanceInfo) => void;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function NumbersPage({ instances, loaded, onInstanceSaved }: Props) {
  const [connectingId, setConnectingId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const connected = instances.filter((i) => i.status === 'open').length;
  const disconnected = instances.length - connected;
  const connecting = instances.find((i) => i.id === connectingId);

  const addButton = (
    <button className="btn btn-primary" onClick={() => setAdding(true)}>
      <Plus aria-hidden /> Adicionar número
    </button>
  );

  return (
    <main className="page">
      <div className="page-inner">
        <header className="page-header">
          <div>
            <h1>Números</h1>
            <p>Os WhatsApps da equipe conectados à central.</p>
          </div>
          {instances.length > 0 && addButton}
        </header>

        {instances.length > 0 && (
          <div className="stats">
            <span className="badge ok">{plural(connected, 'conectado', 'conectados')}</span>
            {disconnected > 0 && <span className="badge off">{plural(disconnected, 'desconectado', 'desconectados')}</span>}
          </div>
        )}

        {!loaded ? (
          <div className="cards" aria-busy>
            {[0, 1, 2].map((i) => (
              <div key={i} className="card skeleton-card" aria-hidden>
                <span className="skeleton-line" style={{ width: '55%' }} />
                <span className="skeleton-line" style={{ width: '40%' }} />
              </div>
            ))}
          </div>
        ) : instances.length === 0 ? (
          <div className="card">
            <EmptyState icon={Smartphone} title="Nenhum número ainda" action={addButton}>
              Adicione o primeiro número e escaneie o QR Code com o celular dele.
            </EmptyState>
          </div>
        ) : (
          <div className="cards">
            {instances.map((instance) => (
              <NumberCard key={instance.id} instance={instance} onSaved={onInstanceSaved} onConnect={() => setConnectingId(instance.id)} />
            ))}
            <button className="card add-card" onClick={() => setAdding(true)}>
              <Plus aria-hidden />
              Adicionar número
            </button>
          </div>
        )}
      </div>

      {adding && (
        <AddNumberModal
          onClose={() => setAdding(false)}
          onCreated={(instance) => {
            onInstanceSaved(instance);
            setAdding(false);
            setConnectingId(instance.id); // já abre o QR Code do número novo
          }}
        />
      )}
      {connecting && <QrModal instance={connecting} onClose={() => setConnectingId(null)} />}
    </main>
  );
}

type CardProps = { instance: InstanceInfo; onSaved: (instance: InstanceInfo) => void; onConnect: () => void };

function NumberCard({ instance, onSaved, onConnect }: CardProps) {
  const [editing, setEditing] = useState(false);
  const [nickname, setNickname] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = statusInfo(instance.status);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      onSaved(await api.renameInstance(instance.id, nickname));
      setEditing(false);
      toast('Apelido salvo');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className="card" style={{ '--instance-color': instanceColor(instance.id) } as CSSProperties}>
      <div className="number-top">
        <span className="number-icon" aria-hidden>
          <Smartphone />
        </span>
        <div className="number-info">
          <div className="number-title">
            <strong>{instanceLabel(instance)}</strong>
            {!editing && (
              <button
                className="icon-btn"
                aria-label="Editar apelido"
                title="Editar apelido"
                onClick={() => {
                  setNickname(instance.nickname ?? '');
                  setError(null);
                  setEditing(true);
                }}
              >
                <Pencil />
              </button>
            )}
          </div>
          <span className="number-meta">{instance.phone ? formatPhone(instance.phone) : 'Número ainda não conectado'}</span>
          <span className="number-sub">Identificação: {instance.name}</span>
        </div>
      </div>

      {editing && (
        <form
          className="rename"
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
            onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
          />
          <button type="submit" className="btn btn-primary" disabled={saving}>
            Salvar
          </button>
          <button type="button" className="icon-btn" onClick={() => setEditing(false)} aria-label="Cancelar">
            <X />
          </button>
        </form>
      )}
      {error && <FormError>{error}</FormError>}

      <div className="card-footer">
        <span className={`badge ${status.tone}`}>{status.label}</span>
        {instance.status !== 'open' ? (
          <button className="btn btn-primary btn-sm" onClick={onConnect}>
            <QrCode aria-hidden /> {instance.phone ? 'Reconectar' : 'Conectar'}
          </button>
        ) : (
          <span className="number-sub">Recebendo mensagens</span>
        )}
      </div>
    </article>
  );
}

function AddNumberModal({ onClose, onCreated }: { onClose: () => void; onCreated: (instance: InstanceInfo) => void }) {
  const [nickname, setNickname] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (!nickname.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      onCreated(await api.createInstance(nickname.trim()));
    } catch (e) {
      setError((e as Error).message);
      setCreating(false);
    }
  };

  return (
    <Modal
      title="Adicionar número"
      description="Dê um apelido para reconhecer o número na central. Em seguida, é só escanear o QR Code."
      onClose={onClose}
    >
      <form
        className="modal-body"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <label className="field">
          <span className="field-label">Apelido</span>
          <input
            className="input"
            value={nickname}
            maxLength={60}
            placeholder="Ex.: WhatsApp 3 - João"
            autoFocus
            onChange={(e) => setNickname(e.target.value)}
          />
        </label>
        {error && <FormError>{error}</FormError>}
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={!nickname.trim() || creating}>
            {creating ? <Spinner /> : <QrCode aria-hidden />} Criar e conectar
          </button>
        </div>
      </form>
    </Modal>
  );
}
