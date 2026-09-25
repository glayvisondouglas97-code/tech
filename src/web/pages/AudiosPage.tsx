import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { AudioItem } from '../../shared/conversations';
import { IconMic, IconPlus, IconTrash, IconUpload } from '../components/Icons';
import { useToast } from '../components/Toasts';
import { Confirm, Dialog, Empty } from '../components/ui';
import { useAudioRecorder } from '../components/wa/Composer';
import { errorMessage } from '../lib/api';
import { plural } from '../lib/format';
import { audioMediaUrl, formatDuration, formatSize, wa } from '../lib/whatsapp';

const AUDIOS_KEY = ['wa-audios'] as const;

/**
 * Biblioteca de áudios do "Chamar" (Plano A). O dono e o administrador salvam várias versões da mesma
 * mensagem; quando o atendente escolhe o número no botão Chamar, o sistema sorteia uma versão ativa e a
 * envia como mensagem de voz para o lead. Ter versões diferentes evita mandar sempre o mesmo áudio.
 */
export function AudiosPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const audios = useQuery({ queryKey: AUDIOS_KEY, queryFn: wa.audios, staleTime: 30_000 });
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<AudioItem | null>(null);

  const list = audios.data ?? [];
  const activeCount = list.filter((a) => a.active).length;

  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) => wa.setAudioActive(id, active),
    onSuccess: () => qc.invalidateQueries({ queryKey: AUDIOS_KEY }),
    onError: (e) => toast(errorMessage(e), { tone: 'bad' }),
  });
  const remove = useMutation({
    mutationFn: (id: number) => wa.deleteAudio(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: AUDIOS_KEY });
      toast('Áudio excluído.');
      setRemoving(null);
    },
    onError: (e) => toast(errorMessage(e), { tone: 'bad' }),
  });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Áudios do Chamar</h1>
          <p className="sub">
            Grave várias versões da mesma mensagem. Ao chamar um lead e escolher o número, o sistema envia uma
            delas, sorteada — assim não vai sempre o mesmo áudio.
          </p>
        </div>
        {list.length > 0 && (
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
            <IconPlus /> Salvar áudio
          </button>
        )}
      </div>

      {list.length > 0 && (
        <p className="sub wa-lib-count">
          {plural(list.length, 'áudio salvo', 'áudios salvos')} · {activeCount} no sorteio
        </p>
      )}

      {audios.isLoading ? (
        <div className="num-loading">
          <span className="spinner" />
        </div>
      ) : list.length === 0 ? (
        <Empty title="Nenhum áudio salvo" icon={<IconMic />}>
          Grave a mensagem que a equipe manda ao chamar um lead. Salve algumas versões, de durações
          diferentes, dizendo a mesma coisa.
          <div className="row" style={{ marginTop: 14 }}>
            <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
              <IconPlus /> Salvar o primeiro áudio
            </button>
          </div>
        </Empty>
      ) : (
        <ul className="wa-lib">
          {list.map((audio) => (
            <li key={audio.id} className={`wa-lib-item${audio.active ? '' : ' off'}`}>
              <div className="wa-lib-main">
                <b>{audio.label}</b>
                <small>
                  {audio.seconds ? formatDuration(audio.seconds) : '—'} · {formatSize(audio.bytes)}
                  {audio.createdBy ? ` · ${audio.createdBy.name}` : ''}
                </small>
              </div>
              {/* biome-ignore lint/a11y/useMediaCaption: áudio gravado pela equipe, sem legenda */}
              <audio className="wa-lib-audio" controls preload="none" src={audioMediaUrl(audio.id)} />
              <label className="switch" title="Entra no sorteio do Chamar">
                <input
                  type="checkbox"
                  checked={audio.active}
                  disabled={toggle.isPending}
                  onChange={(e) => toggle.mutate({ id: audio.id, active: e.target.checked })}
                />
                <span>{audio.active ? 'No sorteio' : 'Desligado'}</span>
              </label>
              <button
                type="button"
                className="icon-btn danger"
                aria-label={`Excluir ${audio.label}`}
                title="Excluir"
                onClick={() => setRemoving(audio)}
              >
                <IconTrash />
              </button>
            </li>
          ))}
        </ul>
      )}

      {adding && <AddAudioDialog onClose={() => setAdding(false)} />}
      <Confirm
        open={!!removing}
        title="Excluir áudio?"
        confirmLabel="Excluir"
        danger
        busy={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing.id)}
        onClose={() => setRemoving(null)}
      >
        <p>
          O áudio <b>{removing?.label}</b> sai da biblioteca e não é mais sorteado. As mensagens já enviadas
          às conversas continuam lá.
        </p>
      </Confirm>
    </>
  );
}

/** Janela para salvar um áudio: gravar pelo microfone ou escolher um arquivo já pronto. */
function AddAudioDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [audio, setAudio] = useState<{ blob: Blob; seconds: number | null } | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const recorder = useAudioRecorder(setError);

  // Prévia do áudio: cria e libera o endereço temporário do blob.
  useEffect(() => {
    if (!audio) {
      setUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(audio.blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [audio]);

  const create = useMutation({
    mutationFn: () => wa.createAudio(label.trim(), audio?.seconds ?? null, audio?.blob as Blob),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: AUDIOS_KEY });
      toast('Áudio salvo.');
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  async function stopRecording() {
    const blob = await recorder.stop();
    if (blob) setAudio({ blob, seconds: recorder.seconds });
    else setError('A gravação ficou vazia. Tente de novo.');
  }

  function chooseFile(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (!file.type.startsWith('audio/')) {
      setError('Escolha um arquivo de áudio.');
      return;
    }
    setAudio({ blob: file, seconds: null });
    if (!label.trim()) setLabel(file.name.replace(/\.[a-z0-9]+$/i, ''));
  }

  const canSave = !!label.trim() && !!audio && !recorder.recording && !create.isPending;

  return (
    <Dialog open onClose={onClose} title="Salvar áudio">
      <label className="field">
        <span>Nome do áudio</span>
        <input
          type="text"
          value={label}
          maxLength={80}
          placeholder="Ex.: Apresentação — 20s"
          onChange={(e) => setLabel(e.target.value)}
        />
      </label>

      {audio && url ? (
        <div className="wa-lib-preview">
          {/* biome-ignore lint/a11y/useMediaCaption: áudio gravado pela equipe, sem legenda */}
          <audio
            controls
            src={url}
            onLoadedMetadata={(e) => {
              // Para arquivos, pega a duração pelo próprio player (a gravação já traz os segundos).
              const secs = e.currentTarget.duration;
              if (audio.seconds == null && Number.isFinite(secs) && secs > 0) {
                setAudio((a) => (a ? { ...a, seconds: Math.round(secs) } : a));
              }
            }}
          />
          <button
            type="button"
            className="btn btn-line"
            onClick={() => setAudio(null)}
            disabled={create.isPending}
          >
            Trocar
          </button>
        </div>
      ) : recorder.recording ? (
        <div className="wa-lib-rec">
          <span className="rec-dot" aria-hidden="true" />
          <span className="rec-time">Gravando… {formatDuration(recorder.seconds)}</span>
          <button type="button" className="btn btn-primary" onClick={stopRecording}>
            Parar
          </button>
          <button type="button" className="btn btn-line" onClick={recorder.cancel}>
            Cancelar
          </button>
        </div>
      ) : (
        <div className="wa-lib-ways">
          <button type="button" className="btn btn-line" onClick={() => void recorder.start()}>
            <IconMic /> Gravar pelo microfone
          </button>
          <label className="btn btn-line">
            <IconUpload /> Escolher arquivo
            <input type="file" accept="audio/*" hidden onChange={(e) => chooseFile(e.target.files?.[0])} />
          </label>
        </div>
      )}

      {error && (
        <p className="banner bad" role="alert">
          {error}
        </p>
      )}

      <div className="row end" style={{ marginTop: 14 }}>
        <button type="button" className="btn btn-line" onClick={onClose}>
          Cancelar
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canSave}
          aria-busy={create.isPending}
          onClick={() => create.mutate()}
        >
          Salvar áudio
        </button>
      </div>
    </Dialog>
  );
}
