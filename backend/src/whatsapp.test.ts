import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contactJids, isNewerStatus, normalizeJid, parseContent, previewOf } from './whatsapp.ts';

test('contactJids: telefone, @lid, os dois juntos e o que deve ser ignorado', () => {
  const key = { id: 'A', fromMe: false };
  assert.deepEqual(contactJids({ ...key, remoteJid: '5511999999999@s.whatsapp.net' }), {
    phoneJid: '5511999999999@s.whatsapp.net',
    lidJid: null,
  });
  assert.deepEqual(contactJids({ ...key, remoteJid: '123456789012345@lid' }), {
    phoneJid: null,
    lidJid: '123456789012345@lid',
  });
  // Evolution já trocou o @lid pelo telefone; o @lid fica no remoteJidAlt (ou o contrário).
  const both = { phoneJid: '5511999999999@s.whatsapp.net', lidJid: '123456789012345@lid' };
  assert.deepEqual(contactJids({ ...key, remoteJid: '5511999999999@s.whatsapp.net', remoteJidAlt: '123456789012345@lid' }), both);
  assert.deepEqual(contactJids({ ...key, remoteJid: '123456789012345@lid', remoteJidAlt: '5511999999999@s.whatsapp.net' }), both);
  // Grupos, status (stories) e canais: ignorados.
  for (const remoteJid of ['120363000000000000@g.us', 'status@broadcast', '120363000000000000@newsletter']) {
    assert.deepEqual(contactJids({ ...key, remoteJid }), { phoneJid: null, lidJid: null });
  }
});

test('normalizeJid remove o sufixo de aparelho', () => {
  assert.equal(normalizeJid('5511999999999:12@s.whatsapp.net'), '5511999999999@s.whatsapp.net');
  assert.equal(normalizeJid('5511999999999@s.whatsapp.net'), '5511999999999@s.whatsapp.net');
});

test('parseContent: tipos comuns', () => {
  assert.deepEqual(parseContent({ messageType: 'conversation', message: { conversation: 'Oi' } }), {
    type: 'text',
    text: 'Oi',
    fileName: null,
  });
  assert.equal(parseContent({ messageType: 'extendedTextMessage', message: { extendedTextMessage: { text: 'link' } } })?.text, 'link');
  assert.deepEqual(parseContent({ messageType: 'audioMessage', message: { audioMessage: { ptt: true } } }), {
    type: 'audio',
    text: null,
    fileName: null,
  });
  assert.deepEqual(parseContent({ messageType: 'imageMessage', message: { imageMessage: { caption: 'foto' } } }), {
    type: 'image',
    text: 'foto',
    fileName: null,
  });
  assert.deepEqual(
    parseContent({ messageType: 'documentMessage', message: { documentMessage: { fileName: 'proposta.pdf' } } }),
    { type: 'document', text: null, fileName: 'proposta.pdf' },
  );
  assert.equal(parseContent({ messageType: 'locationMessage', message: { locationMessage: {} } })?.text, '[Localização]');
});

test('parseContent: desembrulha mensagens temporárias e de visualização única', () => {
  const ephemeral = { ephemeralMessage: { message: { conversation: 'some em 24h' } } };
  assert.equal(parseContent({ messageType: 'ephemeralMessage', message: ephemeral })?.text, 'some em 24h');
  const viewOnce = { viewOnceMessageV2: { message: { imageMessage: {} } } };
  assert.equal(parseContent({ messageType: 'viewOnceMessageV2', message: viewOnce })?.type, 'image');
});

test('parseContent: ignora edições, exclusões, reação removida e mensagens vazias', () => {
  assert.equal(parseContent({ messageType: 'protocolMessage', message: { protocolMessage: {} } }), null);
  assert.equal(parseContent({ messageType: 'reactionMessage', message: { reactionMessage: { text: '' } } }), null);
  assert.equal(parseContent({ messageType: 'reactionMessage', message: { reactionMessage: { text: '👍' } } })?.type, 'reaction');
  assert.equal(parseContent({ message: {} }), null);
  assert.equal(parseContent({ message: null }), null);
});

test('previewOf', () => {
  assert.equal(previewOf({ type: 'audio', text: null, fileName: null }), '🎤 Áudio');
  assert.equal(previewOf({ type: 'image', text: null, fileName: null }), '📷 Imagem');
  assert.equal(previewOf({ type: 'image', text: 'olha', fileName: null }), '📷 olha');
  assert.equal(previewOf({ type: 'document', text: null, fileName: 'a.pdf' }), '📄 a.pdf');
  assert.equal(previewOf({ type: 'text', text: 'x'.repeat(200), fileName: null }).length, 120);
});

test('isNewerStatus: status nunca volta', () => {
  assert.equal(isNewerStatus(null, 'SERVER_ACK'), true);
  assert.equal(isNewerStatus('SERVER_ACK', 'DELIVERY_ACK'), true);
  assert.equal(isNewerStatus('READ', 'DELIVERY_ACK'), false);
  assert.equal(isNewerStatus('READ', 'READ'), false);
  assert.equal(isNewerStatus('READ', 'PLAYED'), true);
  assert.equal(isNewerStatus('READ', 'QUALQUER'), false);
});
