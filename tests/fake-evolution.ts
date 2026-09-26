/** Evolution API de mentira para os testes (responde no mesmo formato da v2.3.7 nas rotas usadas). */
import { createServer, type Server } from 'node:http';

export interface FakeEvolution {
  url: string;
  calls: { method: string; url: string; apikey: string | undefined; body: unknown }[];
  /** Números (instâncias) que respondem como desconectados. */
  closed: Set<string>;
  /** Números que a Evolution já não tem (excluir responde 404). */
  missing: Set<string>;
  /** Números que a Evolution se recusa a excluir (responde 500). */
  undeletable: Set<string>;
  /** Faz TODO envio (texto e áudio) responder com este erro (null = envio normal). */
  failSends: { status: number; message: string } | null;
  close: () => Promise<void>;
}

/**
 * Conferência de número (/chat/whatsappNumbers): final 9999 = sem WhatsApp; final 8888 = conta antiga,
 * registrada sem o 9º dígito (a Evolution devolve o jid certo, sem o 9).
 */
function checkNumber(number: string) {
  if (number.endsWith('9999')) return { jid: `${number}@s.whatsapp.net`, exists: false, number };
  const jid = number.endsWith('8888') ? `${number.slice(0, 4)}${number.slice(5)}` : number;
  return { jid: `${jid}@s.whatsapp.net`, exists: true, number };
}

export async function startFakeEvolution(): Promise<FakeEvolution> {
  const calls: FakeEvolution['calls'] = [];
  const closed = new Set<string>();
  const missing = new Set<string>();
  const undeletable = new Set<string>();
  const control: { failSends: FakeEvolution['failSends'] } = { failSends: null };
  let n = 0;
  const sent = (number: string, message: Record<string, unknown>, messageType: string) => ({
    key: {
      remoteJid: number.includes('@') ? number : `${number}@s.whatsapp.net`,
      fromMe: true,
      id: `SENT-${++n}`,
    },
    pushName: '',
    status: 'PENDING',
    message,
    messageType,
    messageTimestamp: Math.floor(Date.now() / 1000),
  });
  const server: Server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const url = req.url ?? '';
    calls.push({ method: req.method ?? '', url, apikey: req.headers.apikey as string | undefined, body });
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (url === '/instance/fetchInstances') return json(200, []);
    if (url.startsWith('/instance/connectionState/')) {
      const name = decodeURIComponent(url.split('/').pop() ?? '');
      return json(200, { instance: { state: closed.has(name) ? 'close' : 'open' } });
    }
    if (url.startsWith('/chat/deleteMessageForEveryone/'))
      return json(201, { key: body, message: { protocolMessage: { key: { id: body.id }, type: 'REVOKE' } } });
    if (url.startsWith('/instance/delete/')) {
      const name = decodeURIComponent(url.split('/').pop() ?? '');
      if (undeletable.has(name))
        return json(500, { status: 500, error: 'Internal Server Error', response: { message: ['falhou'] } });
      if (missing.has(name))
        return json(404, {
          status: 404,
          error: 'Not Found',
          response: { message: [`The "${name}" instance does not exist`] },
        });
      return json(200, { status: 'SUCCESS', error: false, response: { message: 'Instance deleted' } });
    }
    if (url.startsWith('/chat/whatsappNumbers/'))
      return json(
        200,
        (body.numbers as string[]).map((number) => checkNumber(String(number))),
      );
    if (url === '/instance/create') return json(201, { instance: { instanceName: body.instanceName } });
    if (url.startsWith('/instance/connect/'))
      return json(200, { base64: 'data:image/png;base64,AAAA', count: 1 });
    if (url.startsWith('/webhook/set/') || url.startsWith('/settings/set/')) return json(201, {});
    if (url.startsWith('/chat/markMessageAsRead/')) return json(201, { message: 'Read messages' });
    if (control.failSends && url.startsWith('/message/send')) {
      const { status, message } = control.failSends;
      return json(status, { status, error: 'Simulated', response: { message: [message] } });
    }
    if (url.startsWith('/message/sendText/')) {
      if (String(body.number).startsWith('5511999990000'))
        return json(400, { status: 400, error: 'Bad Request', response: { message: [{ exists: false }] } });
      return json(201, sent(body.number, { conversation: body.text }, 'conversation'));
    }
    if (url.startsWith('/message/sendWhatsAppAudio/'))
      return json(
        201,
        sent(
          body.number,
          { audioMessage: { ptt: true, mimetype: 'audio/ogg; codecs=opus' } },
          'audioMessage',
        ),
      );
    return json(404, { status: 404, error: 'Not Found', response: { message: ['rota não simulada'] } });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    closed,
    missing,
    undeletable,
    get failSends() {
      return control.failSends;
    },
    set failSends(value) {
      control.failSends = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
