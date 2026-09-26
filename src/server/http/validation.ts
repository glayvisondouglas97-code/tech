import { setErrorMap, type ZodError, ZodIssueCode, type ZodTypeAny, type z } from 'zod';
import { badRequest } from '../lib/errors';

// Mensagens de validação em português.
setErrorMap((issue, ctx) => {
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      return { message: issue.received === 'undefined' ? 'campo obrigatório' : 'valor inválido' };
    case ZodIssueCode.too_small:
      return {
        message:
          issue.type === 'string'
            ? `precisa ter pelo menos ${issue.minimum} caracteres`
            : 'valor pequeno demais',
      };
    case ZodIssueCode.too_big:
      return {
        message:
          issue.type === 'string' ? `pode ter no máximo ${issue.maximum} caracteres` : 'valor grande demais',
      };
    case ZodIssueCode.invalid_string:
      return { message: issue.validation === 'email' ? 'e-mail inválido' : 'formato inválido' };
    case ZodIssueCode.invalid_enum_value:
      return { message: 'opção inválida' };
    default:
      return { message: ctx.defaultError };
  }
});

const FIELD_NAMES: Record<string, string> = {
  email: 'E-mail',
  password: 'Senha',
  newPassword: 'Nova senha',
  name: 'Nome',
  role: 'Papel',
  body: 'Mensagem',
  note: 'Observação',
  listName: 'Nome da lista',
  phone: 'Telefone',
  // automações
  description: 'Descrição',
  trigger: 'Gatilho',
  actionType: 'Ação',
  delaySeconds: 'Tempo de espera',
  messageText: 'Mensagem',
  audioId: 'Áudio',
  position: 'Posição',
  conditions: 'Condições',
  field: 'Campo da condição',
  operator: 'Operador da condição',
  value: 'Valor da condição',
  stepIds: 'Etapas',
};

export function zodMessage(err: ZodError): string {
  const issue = err.issues[0];
  if (!issue) return 'Dados inválidos.';
  const field = issue.path.map(String).filter(Boolean).at(-1);
  const label = field ? (FIELD_NAMES[field] ?? field) : '';
  return label ? `${label}: ${issue.message}.` : `Dados inválidos: ${issue.message}.`;
}

/** Valida a entrada e lança erro 400 com mensagem legível. */
export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw badRequest(zodMessage(r.error));
  return r.data;
}
