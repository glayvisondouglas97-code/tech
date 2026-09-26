import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
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
 * Tipos de áudio pela extensão do arquivo. Alguns sistemas (o Windows com .opus, .ogg e .m4a, por exemplo) entregam o
 * arquivo sem tipo; sem isso o áudio era recusado como "não é áudio" mesmo sendo um áudio válido.
 */
const AUDIO_TYPES: Record<string, string> = {
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  aac: 'audio/aac',
  webm: 'audio/webm',
};
const ACCEPT = ['audio/*', ...Object.keys(AUDIO_TYPES).map((ext) => `.${ext}`)].join(',');

/** O arquivo como áudio (com o tipo certo), ou null se não for áudio. */
function asAudio(file: File): Blob | null {
  if (file.type.startsWith('audio/')) return file;
  const ext = file.name.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? '';
  const type = AUDIO_TYPES[ext];
  if (!type || (file.type && file.type !== 'application/octet-stream' && !file.type.startsWith('video/'))) {
    return null;
  }
  return new Blob([file], { type });
}

/**
 * Biblioteca de áudios. O dono e o administrador salvam várias versões da mesma mensagem; o sistema sorteia uma
 * versão ativa no botão Chamar e na campanha automática. Ter versões diferentes evita mandar sempre o mesmo áudio.
 */
export function AudiosPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const audios = useQuery({ queryKey: AUDIOS_KEY, queryFn: wa.audios, staleTime: 30_000 });
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<AudioItem | null>(null);

  // Ordem fixa (mais novos primeiro): ligar ou desligar um áudio não faz a linha pular de lugar.
  const list = useMemo(() => [...(audios.data ?? [])].sort((a, b) => b.id - a.id), [audios.data]);
  const activeCount = list.filter((a) => a.active).length;

  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) => wa.setAudioActive(id, active),
    onSuccess: (updated) => {
      qc.setQueryData<AudioItem[]>(AUDIOS_KEY, (old) => old?.map((a) => (a.id === updated.id ? updated : a)));
      void qc.invalidateQueries({ queryKey: AUDIOS_KEY });
    },
    onError: (e) => toast(errorMessage(e), { tone: 'bad' }),
  });
  const remove = useMutation({
    mutationFn: (id: number) => wa.deleteAudio(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: AUDIOS_KEY });
      toast('Áudio excluído.');
      setRemoving(null);
    },
    onError: (e) => toast(errorMessage(e), { tone: 'bad' }),
  });
  const pendingId = toggle.isPending ? toggle.variables?.id : undefined;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Áudios</h1>
          <p className="sub">
            Os áudios que o sistema sorteia no botão Chamar e na campanha automática. Salve várias versões da
            mesma mensagem, assim não vai sempre o mesmo áudio.
          </p>
        </div>
      </div>

      {audios.isLoading ? (
        <div className="num-loading">
          <span className="spinner" />
        </div>
      ) : audios.isError ? (
        <div className="banner bad wa-lib-error" role="alert">
          <span>{errorMessage(audios.error)}</span>
          <button type="button" className="btn btn-line btn-sm" onClick={() => void audios.refetch()}>
            Tentar de novo
          </button>
        </div>
      ) : list.length === 0 ? (
        <Empty title="Nenhum áudio salvo" icon={<IconMic />}>
          <p>
            Grave a mensagem que vai para o lead. Salve algumas versões, de durações diferentes, dizendo a
            mesma coisa.
          </p>
          <button type="button" className="btn btn-primary wa-lib-first" onClick={() => setAdding(true)}>
            <IconPlus /> Salvar o primeiro áudio
          </button>
        </Empty>
      ) : (
        <>
          <div className="wa-lib-bar">
            <p className="sub" aria-live="polite">
              {plural(list.length, 'áudio salvo', 'áudios salvos')} · <b>{activeCount}</b> no sorteio
            </p>
            <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
              <IconPlus /> Salvar áudio
            </button>
          </div>

          {activeCount === 0 && (
            <p className="banner warn" role="status">
              Nenhum áudio está no sorteio: o Chamar abre a conversa sem áudio e a campanha automática não
              envia nada. Ligue pelo menos um.
            </p>
          )}

          <ul className="wa-lib">
            {list.map((audio) => (
              <li key={audio.id} className={`wa-lib-item${audio.active ? '' : ' off'}`}>
                <div className="wa-lib-main">
                  <b title={audio.label}>{audio.label}</b>
                  <small>
                    {audio.seconds ? formatDuration(audio.seconds) : 'Duração não informada'} ·{' '}
                    {formatSize(audio.bytes)}
                    {audio.createdBy ? ` · ${audio.createdBy.name}` : ''}
                  </small>
                </div>
                {/* biome-ignore lint/a11y/useMediaCaption: áudio gravado pela equipe, sem legenda */}
                <audio className="wa-lib-audio" controls preload="metadata" src={audioMediaUrl(audio.id)} />
                <label className="switch wa-lib-switch" title="Entra no sorteio do Chamar e da campanha">
                  <input
                    type="checkbox"
                    checked={audio.active}
                    disabled={pendingId === audio.id}
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
        </>
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
        {removing?.active && activeCount === 1 && (
          <p className="banner warn">
            É o único áudio no sorteio: sem ele, o Chamar abre a conversa sem áudio e a campanha automática
            para de enviar.
          </p>
        )}
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
      void qc.invalidateQueries({ queryKey: AUDIOS_KEY });
      toast('Áudio salvo.');
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  async function startRecording() {
    setError(null);
    await recorder.start();
  }

  async function stopRecording() {
    const seconds = recorder.seconds;
    const blob = await recorder.stop();
    if (blob) setAudio({ blob, seconds: seconds > 0 ? seconds : null });
    else setError('A gravação ficou vazia. Tente de novo.');
  }

  function chooseFile(input: HTMLInputElement) {
    setError(null);
    const file = input.files?.[0];
    // Limpa a escolha: escolher o mesmo arquivo de novo (depois de "Trocar") volta a funcionar.
    input.value = '';
    if (!file) return;
    const blob = asAudio(file);
    if (!blob) {
      setError('Escolha um arquivo de áudio (MP3, OGG, OPUS, M4A, WAV, AAC ou WEBM).');
      return;
    }
    setAudio({ blob, seconds: null });
    if (!label.trim()) setLabel(file.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 80));
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
          <button type="button" className="btn btn-primary" onClick={() => void stopRecording()}>
            Parar
          </button>
          <button type="button" className="btn btn-line" onClick={recorder.cancel}>
            Cancelar
          </button>
        </div>
      ) : (
        <div className="wa-lib-ways">
          <button type="button" className="btn btn-line" onClick={() => void startRecording()}>
            <IconMic /> Gravar pelo microfone
          </button>
          <label className="btn btn-line">
            <IconUpload /> Escolher arquivo
            <input type="file" accept={ACCEPT} hidden onChange={(e) => chooseFile(e.currentTarget)} />
          </label>
        </div>
      )}

      {error && (
        <p className="banner bad" role="alert">
          {error}
        </p>
      )}

      <div className="row end wa-lib-actions">
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
