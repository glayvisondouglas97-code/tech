// Comandos de administração, rodados pelo terminal dentro do container:
//   docker compose exec app node src/cli.ts criar-admin "Seu Nome" voce@email.com
//   docker compose exec app node src/cli.ts redefinir-senha voce@email.com
//   docker compose exec app node src/cli.ts listar-usuarios
import { destroyUserSessions, hashPassword, normalizeEmail, temporaryPassword } from './auth.ts';
import { prisma } from './db.ts';

const [command, ...args] = process.argv.slice(2);

async function main(): Promise<string> {
  switch (command) {
    case 'criar-admin': {
      const [name, rawEmail] = args;
      const email = normalizeEmail(rawEmail);
      if (!name?.trim() || !email.includes('@')) return 'Uso: node src/cli.ts criar-admin "Seu Nome" voce@email.com';
      if (await prisma.user.findUnique({ where: { email } })) return `Já existe um usuário com o e-mail ${email}.`;
      const password = temporaryPassword();
      await prisma.user.create({ data: { name: name.trim(), email, isAdmin: true, passwordHash: await hashPassword(password) } });
      return `Administrador criado.\n  E-mail: ${email}\n  Senha provisória: ${password}\nEntre no sistema e troque a senha em "Minha senha".`;
    }
    case 'redefinir-senha': {
      const email = normalizeEmail(args[0]);
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) return `Nenhum usuário com o e-mail ${email}.`;
      const password = temporaryPassword();
      await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(password), active: true } });
      await destroyUserSessions(user.id);
      return `Senha redefinida (e acesso reativado).\n  E-mail: ${email}\n  Senha provisória: ${password}`;
    }
    case 'listar-usuarios': {
      const users = await prisma.user.findMany({ orderBy: { name: 'asc' } });
      if (!users.length) return 'Nenhum usuário ainda. Crie o primeiro com: node src/cli.ts criar-admin "Seu Nome" voce@email.com';
      return users.map((u) => `${u.email}  ${u.name}${u.isAdmin ? '  [admin]' : ''}${u.active ? '' : '  [desativado]'}`).join('\n');
    }
    default:
      return 'Comandos: criar-admin "Nome" email | redefinir-senha email | listar-usuarios';
  }
}

main()
  .then((output) => console.log(output))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
