import { useEffect, useRef, useState } from 'react';
import type { InstanceInfo, QrCodeEvent } from '../../../shared/conversations';
import { errorMessage } from '../../lib/api';
import { useSocketEvent } from '../../lib/socket';
import { instanceLabel, wa } from '../../lib/whatsapp';
import { IconAlert, IconCheckCircle, IconRefresh } from '../Icons';
import { Dialog } from '../ui';

type Step = 'starting' | 'qrcode' | 'expired' | 'connected' | 'error';

/** Janela de conexão: pede a conexão, mostra o QR Code (o WhatsApp troca a cada ~20s) e fecha ao conectar. */
export function QrDialog({ instance, onClose }: { instance: InstanceInfo; onClose: () => void }) {
  const [step, setStep] = useState<Step>('starting');
  const [qrcode, setQrcode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setStep('starting');
    setError(null);
    try {
      const result = await wa.connectInstance(instance.id);
      if (result.status === 'open') setStep('connected');
      else if (result.qrcode) {
        setQrcode(result.qrcode);
        setStep('qrcode');
      }
    } catch (e) {
      setError(errorMessage(e));
      setStep('error');
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: só ao abrir a janela
  useEffect(() => {
    void start();
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

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (step !== 'connected') return;
    const timer = setTimeout(() => closeRef.current(), 2500);
    return () => clearTimeout(timer);
  }, [step]);

  return (
    <Dialog open onClose={onClose} title={`Conectar ${instanceLabel(instance)}`}>
      <p className="sub">Escaneie o QR Code com o WhatsApp do celular deste número.</p>
      <div className="wa-qr-layout">
        <ol className="wa-qr-steps">
          <li>
            <span>
              No celular deste número, abra o <b>WhatsApp</b>.
            </span>
          </li>
          <li>
            <span>
              Toque em <b>⋮ Mais opções</b> (Android) ou em <b>Configurações</b> (iPhone).
            </span>
          </li>
          <li>
            <span>
              Toque em <b>Dispositivos conectados</b> e depois em <b>Conectar dispositivo</b>.
            </span>
          </li>
          <li>
            <span>Aponte a câmera para o QR Code. Ele muda sozinho a cada poucos segundos.</span>
          </li>
        </ol>
        <div className="wa-qr-panel">
          <div className="wa-qr-box">
            {step === 'qrcode' && qrcode && (
              <img className="wa-qrcode" src={qrcode} alt="QR Code para conectar o WhatsApp" />
            )}
            {step === 'starting' && (
              <div className="wa-qr-state" role="status">
                <span className="spinner" />
                Gerando o QR Code…
                <small>Se o número já estava conectado antes, ele pode voltar sozinho.</small>
              </div>
            )}
            {step === 'expired' && (
              <div className="wa-qr-state">
                O QR Code expirou.
                <button type="button" className="btn btn-primary btn-sm" onClick={() => void start()}>
                  <IconRefresh /> Gerar novo
                </button>
              </div>
            )}
            {step === 'connected' && (
              <div className="wa-qr-state ok" role="status">
                <IconCheckCircle />
                <b>Conectado!</b>
                As conversas deste número já aparecem na central.
              </div>
            )}
            {step === 'error' && (
              <div className="wa-qr-state bad" role="alert">
                <IconAlert />
                {error}
                <button type="button" className="btn btn-primary btn-sm" onClick={() => void start()}>
                  <IconRefresh /> Tentar de novo
                </button>
              </div>
            )}
          </div>
          {step === 'qrcode' && (
            <p className="wa-qr-hint">
              <IconRefresh /> O código se renova sozinho
            </p>
          )}
        </div>
      </div>
    </Dialog>
  );
}
