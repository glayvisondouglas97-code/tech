import { expect, test } from 'vitest';
import {
  contactJids,
  isNewerStatus,
  normalizeJid,
  parseContent,
  previewOf,
} from '../../src/server/modules/whatsapp/parse';

test('contactJids: telefone, @lid, os dois juntos e o que deve ser ignorado', () => {
  const key = { id: 'A', fromMe: false };
  expect(contactJids({ ...key, remoteJid: '5511999999999@s.whatsapp.net' })).toEqual({
    phoneJid: '5511999999999@s.whatsapp.net',
    lidJid: null,
  });
  expect(contactJids({ ...key, remoteJid: '123456789012345@lid' })).toEqual({
    phoneJid: null,
    lidJid: '123456789012345@lid',
  });
  // Evolution já trocou o @lid pelo telefone; o @lid fica no remoteJidAlt (ou o contrário).
  const both = { phoneJid: '5511999999999@s.whatsapp.net', lidJid: '123456789012345@lid' };
  expect(
    contactJids({ ...key, remoteJid: '5511999999999@s.whatsapp.net', remoteJidAlt: '123456789012345@lid' }),
  ).toEqual(both);
  expect(
    contactJids({ ...key, remoteJid: '123456789012345@lid', remoteJidAlt: '5511999999999@s.whatsapp.net' }),
  ).toEqual(both);
  // Grupos, status (stories) e canais: ignorados.
  for (const remoteJid of ['120363000000000000@g.us', 'status@broadcast', '120363000000000000@newsletter']) {
    expect(contactJids({ ...key, remoteJid })).toEqual({ phoneJid: null, lidJid: null });
  }
});

test('normalizeJid remove o sufixo de aparelho', () => {
  expect(normalizeJid('5511999999999:12@s.whatsapp.net')).toBe('5511999999999@s.whatsapp.net');
  expect(normalizeJid('5511999999999@s.whatsapp.net')).toBe('5511999999999@s.whatsapp.net');
});

test('parseContent: tipos comuns', () => {
  expect(parseContent({ messageType: 'conversation', message: { conversation: 'Oi' } })).toEqual({
    type: 'text',
    text: 'Oi',
    fileName: null,
    mimetype: null,
  });
  expect(
    parseContent({ messageType: 'extendedTextMessage', message: { extendedTextMessage: { text: 'link' } } })
      ?.text,
  ).toBe('link');
  expect(
    parseContent({
      messageType: 'audioMessage',
      message: { audioMessage: { ptt: true, mimetype: 'audio/ogg; codecs=opus' } },
    }),
  ).toEqual({
    type: 'audio',
    text: null,
    fileName: null,
    mimetype: 'audio/ogg; codecs=opus',
  });
  expect(
    parseContent({
      messageType: 'imageMessage',
      message: { imageMessage: { caption: 'foto', mimetype: 'image/jpeg' } },
    }),
  ).toEqual({
    type: 'image',
    text: 'foto',
    fileName: null,
    mimetype: 'image/jpeg',
  });
  expect(
    parseContent({
      messageType: 'documentMessage',
      message: { documentMessage: { fileName: 'proposta.pdf' } },
    }),
  ).toEqual({ type: 'document', text: null, fileName: 'proposta.pdf', mimetype: null });
  expect(parseContent({ messageType: 'locationMessage', message: { locationMessage: {} } })?.text).toBe(
    '[Localização]',
  );
});

test('parseContent: desembrulha mensagens temporárias e de visualização única', () => {
  const ephemeral = { ephemeralMessage: { message: { conversation: 'some em 24h' } } };
  expect(parseContent({ messageType: 'ephemeralMessage', message: ephemeral })?.text).toBe('some em 24h');
  const viewOnce = { viewOnceMessageV2: { message: { imageMessage: {} } } };
  expect(parseContent({ messageType: 'viewOnceMessageV2', message: viewOnce })?.type).toBe('image');
});

test('parseContent: ignora edições, exclusões, reação removida e mensagens vazias', () => {
  expect(parseContent({ messageType: 'protocolMessage', message: { protocolMessage: {} } })).toBe(null);
  expect(parseContent({ messageType: 'reactionMessage', message: { reactionMessage: { text: '' } } })).toBe(
    null,
  );
  expect(
    parseContent({ messageType: 'reactionMessage', message: { reactionMessage: { text: '👍' } } })?.type,
  ).toBe('reaction');
  expect(parseContent({ message: {} })).toBe(null);
  expect(parseContent({ message: null })).toBe(null);
});

test('previewOf', () => {
  expect(previewOf({ type: 'audio', text: null, fileName: null, mimetype: null })).toBe('🎤 Áudio');
  expect(previewOf({ type: 'image', text: null, fileName: null, mimetype: null })).toBe('📷 Imagem');
  expect(previewOf({ type: 'image', text: 'olha', fileName: null, mimetype: null })).toBe('📷 olha');
  expect(previewOf({ type: 'document', text: null, fileName: 'a.pdf', mimetype: null })).toBe('📄 a.pdf');
  expect(previewOf({ type: 'text', text: 'x'.repeat(200), fileName: null, mimetype: null }).length).toBe(120);
});

test('isNewerStatus: status nunca volta', () => {
  expect(isNewerStatus(null, 'SERVER_ACK')).toBe(true);
  expect(isNewerStatus('SERVER_ACK', 'DELIVERY_ACK')).toBe(true);
  expect(isNewerStatus('READ', 'DELIVERY_ACK')).toBe(false);
  expect(isNewerStatus('READ', 'READ')).toBe(false);
  expect(isNewerStatus('READ', 'PLAYED')).toBe(true);
  expect(isNewerStatus('READ', 'QUALQUER')).toBe(false);
});
