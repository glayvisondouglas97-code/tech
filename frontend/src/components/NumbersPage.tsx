import { useState } from 'react';
import { api, type InstanceInfo } from '../api.ts';
import { formatPhone, instanceColor, instanceLabel, statusInfo } from '../format.ts';
import { QrModal } from './QrModal.tsx';

type Props = {
  instances: InstanceInfo[];
  onInstanceSaved: (instance: InstanceInfo) => void;
  onBack: () => void;
};

export function NumbersPage({ instances, onInstanceSaved, onBack }: Props) {
  const [connectingId, setConnectingId] = useState<number | null>(null);
  const [newNickname, setNewNickname] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (!newNickname.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const instance = await api.createInstance(newNickname.trim());
      onInstanceSaved(instance);
      setNewNickname('');
      setConnectingId(instance.id); // já abre o QR Code do número novo
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const connecting = instances.find((i) => i.id === connectingId);

  return (
    <main className="numbers-page">
      <header className="numbers-header">
        <button className="link-button" onClick={onBack}>
          ← Conversas
        </button>
        <h1>Números</h1>
      </header>

      <form
        className="add-number"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <input
          value={newNickname}
          maxLength={60}
          placeholder='Apelido do número novo, ex.: "WhatsApp 3 - João"'
          onChange={(e) => setNewNickname(e.target.value)}
        />
        <button type="submit" disabled={!newNickname.trim() || creating}>
          {creating ? 'Criando…' : '+ Adicionar número'}
        </button>
      </form>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <ul className="number-list">
        {instances.map((instance) => (
          <NumberRow key={instance.id} instance={instance} onSaved={onInstanceSaved} onConnect={() => setConnectingId(instance.id)} />
        ))}
        {instances.length === 0 && <li className="list-info">Nenhum número ainda. Adicione o primeiro acima.</li>}
      </ul>

      {connecting && <QrModal instance={connecting} onClose={() => setConnectingId(null)} />}
    </main>
  );
}

function NumberRow({
  instance,
  onSaved,
  onConnect,
}: {
  instance: InstanceInfo;
  onSaved: (instance: InstanceInfo) => void;
  onConnect: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [nickname, setNickname] = useState(instance.nickname ?? '');
  const [error, setError] = useState<string | null>(null);
  const status = statusInfo(instance.status);

  const save = async () => {
    setError(null);
    try {
      onSaved(await api.renameInstance(instance.id, nickname));
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <li className="number-row">
      <span className="number-dot" style={{ background: instanceColor(instance.id) }} aria-hidden />
      <div className="number-info">
        {editing ? (
          <form
            className="rename"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <input value={nickname} maxLength={60} autoFocus onChange={(e) => setNickname(e.target.value)} />
            <button type="submit">Salvar</button>
            <button type="button" className="link-button" onClick={() => setEditing(false)}>
              Cancelar
            </button>
          </form>
        ) : (
          <div className="number-title">
            <strong>{instanceLabel(instance)}</strong>
            <button
              className="link-button"
              onClick={() => {
                setNickname(instance.nickname ?? '');
                setEditing(true);
              }}
            >
              Editar apelido
            </button>
          </div>
        )}
        <span className="number-meta">
          {instance.phone ? formatPhone(instance.phone) : 'Número ainda não conectado'} · {instance.name}
        </span>
        {error && <span className="form-error">{error}</span>}
      </div>
      <span className={`status-pill ${status.tone}`}>{status.label}</span>
      {instance.status !== 'open' && (
        <button className="primary-button" onClick={onConnect}>
          {instance.phone ? 'Reconectar' : 'Conectar'}
        </button>
      )}
    </li>
  );
}
