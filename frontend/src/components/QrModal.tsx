import { useEffect, useRef, useState } from 'react';
import { api, type InstanceInfo, type QrCodeEvent } from '../api.ts';
import { instanceLabel } from '../format.ts';
import { useSocketEvent } from '../socket.ts';

type Step = 'starting' | 'qrcode' | 'expired' | 'connected' | 'error';

// Janela de conexão: pede a conexão, mostra o QR Code (que o WhatsApp troca a cada ~20s) e fecha ao conectar.
export function QrModal({ instance, onClose }: { instance: InstanceInfo; onClose: () => void }) {
  const [step, setStep] = useState<Step>('starting');
  const [qrcode, setQrcode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setStep('starting');
    setError(null);
    try {
      const result = await api.connectInstance(instance.id);
      if (result.status === 'open') setStep('connected');
      else if (result.qrcode) {
        setQrcode(result.qrcode);
        setStep('qrcode');
      }
    } catch (e) {
      setError((e as Error).message);
      setStep('error');
    }
  };

  useEffect(() => {
    void start();
    // Só ao abrir a janela.
  }, []);

  useSocketEvent<QrCodeEvent>('instance:qrcode', (event) => {
    if (event.instanceId !== instance.id) return;
    if (event.qrcode) {
      setQrcode(event.qrcode);
      setStep((current) => (current === 'connected' ? current : 'qrcode'));
    } else {
      setStep('expired');
    }
  });

  // O status do número chega em tempo real: ao conectar, mostra a confirmação e fecha.
  // Só reage a mudanças depois que a janela abriu (o status antigo pode ser de uma tentativa anterior).
  const initialStatus = useRef(instance.status);
  useEffect(() => {
    if (instance.status === initialStatus.current) return;
    initialStatus.current = '';
    if (instance.status === 'open') setStep('connected');
    else if (instance.status === 'refused') setStep('expired');
  }, [instance.status]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (step !== 'connected') return;
    const timer = setTimeout(onClose, 2500);
    return () => clearTimeout(timer);
  }, [step, onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Conectar número" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Conectar {instanceLabel(instance)}</h2>
          <button className="link-button" onClick={onClose} aria-label="Fechar">
            ✕
          </button>
        </header>

        {step === 'starting' && <p className="modal-status">Gerando o QR Code… (se o número já estava conectado antes, ele pode voltar sozinho)</p>}

        {step === 'qrcode' && qrcode && (
          <>
            <img className="qrcode" src={qrcode} alt="QR Code para conectar o WhatsApp" />
            <ol className="qr-steps">
              <li>No celular deste número, abra o WhatsApp.</li>
              <li>
                Toque em <strong>⋮</strong> (Android) ou <strong>Configurações</strong> (iPhone) →{' '}
                <strong>Dispositivos conectados</strong> → <strong>Conectar dispositivo</strong>.
              </li>
              <li>Aponte a câmera para este QR Code. Ele muda sozinho a cada poucos segundos.</li>
            </ol>
          </>
        )}

        {step === 'expired' && (
          <div className="modal-status">
            <p>O QR Code expirou.</p>
            <button className="primary-button" onClick={() => void start()}>
              Gerar novo QR Code
            </button>
          </div>
        )}

        {step === 'connected' && <p className="modal-status ok">✅ Conectado! As conversas deste número já aparecem na central.</p>}

        {step === 'error' && (
          <div className="modal-status">
            <p className="form-error">{error}</p>
            <button className="primary-button" onClick={() => void start()}>
              Tentar de novo
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
