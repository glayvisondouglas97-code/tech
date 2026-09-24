/** LGPD: conversas de WhatsApp de uma pessoa (pelo telefone), para exportar ou apagar. */
import type { Kysely } from 'kysely';
import type { Database } from '../../db/schema';

const jidOf = (phone: string) => `${phone.replace(/\D/g, '')}@s.whatsapp.net`;

/** Conversas e mensagens da pessoa, em todos os números (para o relatório do titular). */
export async function whatsappDataOf(db: Kysely<Database>, phone: string) {
  const rows = await db
    .selectFrom('wa_messages as m')
    .innerJoin('wa_conversations as c', 'c.id', 'm.conversation_id')
    .innerJoin('wa_contacts as ct', 'ct.id', 'c.contact_id')
    .innerJoin('wa_instances as i', 'i.id', 'c.instance_id')
    .select([
      'i.name as numero',
      'i.nickname as apelido',
      'ct.name as nome_no_whatsapp',
      'm.from_me',
      'm.type',
      'm.text',
      'm.file_name',
      'm.sent_at',
    ])
    .where('ct.phone_jid', '=', jidOf(phone))
    .orderBy('m.sent_at')
    .execute();
  return rows.map((r) => ({
    numero: r.apelido ?? r.numero,
    nome_no_whatsapp: r.nome_no_whatsapp,
    enviada_pela_empresa: r.from_me,
    tipo: r.type,
    texto: r.text,
    arquivo: r.file_name,
    data: r.sent_at,
  }));
}

/** Apaga contato, conversas e mensagens da pessoa. Devolve os arquivos de mídia para apagar depois do commit. */
export async function deleteWhatsappData(db: Kysely<Database>, phone: string): Promise<string[]> {
  const contact = await db
    .selectFrom('wa_contacts')
    .select('id')
    .where('phone_jid', '=', jidOf(phone))
    .executeTakeFirst();
  if (!contact) return [];
  const conversations = await db
    .selectFrom('wa_conversations')
    .select('id')
    .where('contact_id', '=', contact.id)
    .execute();
  const ids = conversations.map((c) => c.id);
  let mediaPaths: string[] = [];
  if (ids.length) {
    const media = await db
      .selectFrom('wa_messages')
      .select('media_path')
      .where('conversation_id', 'in', ids)
      .where('media_path', 'is not', null)
      .execute();
    mediaPaths = media.map((m) => m.media_path as string);
    await db.deleteFrom('wa_messages').where('conversation_id', 'in', ids).execute();
    await db.deleteFrom('wa_conversations').where('id', 'in', ids).execute();
  }
  await db.deleteFrom('wa_contacts').where('id', '=', contact.id).execute();
  return mediaPaths;
}
