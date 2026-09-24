import { hash, verify } from '@node-rs/argon2';

// Argon2id (padrão da biblioteca) com 19 MiB e 2 passagens: mínimo recomendado pela OWASP.
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | null = null;

/** Gasta o mesmo tempo de uma verificação real quando o e-mail não existe (evita descobrir e-mails pelo tempo). */
export async function fakeVerify(password: string): Promise<void> {
  dummyHash ??= hashPassword('senha-que-nao-existe-de-verdade');
  await verifyPassword(await dummyHash, password);
}

const COMMON = new Set([
  '12345678',
  '123456789',
  '1234567890',
  'password',
  'password1',
  'senha123',
  'senha1234',
  'qwerty123',
  '11111111',
  '00000000',
  'abcd1234',
  'mudar123',
  'admin123',
]);

/** Devolve a mensagem de erro, ou null se a senha é aceitável. */
export function passwordProblem(
  password: string,
  ctx: { email?: string; name?: string } = {},
): string | null {
  if (password.length < 8) return 'A senha precisa ter pelo menos 8 caracteres.';
  if (password.length > 200) return 'A senha pode ter no máximo 200 caracteres.';
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return 'Essa senha é fácil demais de adivinhar. Escolha outra.';
  if (ctx.email && lower === ctx.email.toLowerCase()) return 'A senha não pode ser igual ao e-mail.';
  if (/^(.)\1+$/.test(password)) return 'A senha não pode ser um caractere repetido.';
  return null;
}
