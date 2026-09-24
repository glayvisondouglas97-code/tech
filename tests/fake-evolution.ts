/** Evolution API de mentira para os testes (responde no mesmo formato da v2.3.7 nas rotas usadas). */
import { createServer, type Server } from 'node:http';

export interface FakeEvolution {
  url: string;
  calls: { method: string; url: string; apikey: string | undefined; body: unknown }[];
  close: () => Promise<void>;
}

export async function startFakeEvolution(): Promise<FakeEvolution> {
  const calls: FakeEvolution['calls'] = [];
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
    if (url.startsWith('/instance/connectionState/')) return json(200, { instance: { state: 'open' } });
    if (url === '/instance/create') return json(201, { instance: { instanceName: body.instanceName } });
    if (url.startsWith('/instance/connect/'))
      return json(200, { base64: 'data:image/png;base64,AAAA', count: 1 });
    if (url.startsWith('/webhook/set/') || url.startsWith('/settings/set/')) return json(201, {});
    if (url.startsWith('/chat/markMessageAsRead/')) return json(201, { message: 'Read messages' });
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
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
