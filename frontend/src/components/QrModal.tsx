import { CircleAlert, CircleCheckBig, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, type InstanceInfo, type QrCodeEvent } from '../api.ts';
import { instanceLabel } from '../format.ts';
import { useSocketEvent } from '../socket.ts';
import { Modal, Spinner } from './ui.tsx';

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
    if (step !== 'connected') return;
    const timer = setTimeout(onClose, 2500);
    return () => clearTimeout(timer);
  }, [step, onClose]);

  return (
    <Modal
      wide
      title={`Conectar ${instanceLabel(instance)}`}
      description="Escaneie o QR Code com o WhatsApp do celular deste número."
      onClose={onClose}
    >
      <div className="qr-layout">
        <ol className="qr-steps">
          <li>
            <span>
              No celular deste número, abra o <strong>WhatsApp</strong>.
            </span>
          </li>
          <li>
            <span>
              Toque em <strong>⋮ Mais opções</strong> (Android) ou em <strong>Configurações</strong> (iPhone).
            </span>
          </li>
          <li>
            <span>
              Toque em <strong>Dispositivos conectados</strong> e depois em <strong>Conectar dispositivo</strong>.
            </span>
          </li>
          <li>
            <span>Aponte a câmera para o QR Code. Ele muda sozinho a cada poucos segundos.</span>
          </li>
        </ol>

        <div className="qr-panel">
          <div className="qr-box">
            {step === 'qrcode' && qrcode && <img className="qrcode" src={qrcode} alt="QR Code para conectar o WhatsApp" />}
            {step === 'starting' && (
              <div className="qr-waiting" role="status">
                <Spinner />
                Gerando o QR Code…
                <small>Se o número já estava conectado antes, ele pode voltar sozinho.</small>
              </div>
            )}
            {step === 'expired' && (
              <div className="qr-waiting">
                O QR Code expirou.
                <button className="btn btn-primary btn-sm" onClick={() => void start()}>
                  <RefreshCw aria-hidden /> Gerar novo
                </button>
              </div>
            )}
            {step === 'connected' && (
              <div className="qr-waiting qr-success" role="status">
                <CircleCheckBig aria-hidden />
                <strong>Conectado!</strong>
                As conversas deste número já aparecem na central.
              </div>
            )}
            {step === 'error' && (
              <div className="qr-waiting qr-failed" role="alert">
                <CircleAlert aria-hidden />
                {error}
                <button className="btn btn-primary btn-sm" onClick={() => void start()}>
                  <RefreshCw aria-hidden /> Tentar de novo
                </button>
              </div>
            )}
          </div>
          {step === 'qrcode' && (
            <p className="qr-hint">
              <RefreshCw aria-hidden /> O código se renova sozinho
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}
