import { IconUser } from '../Icons';
import { Avatar } from '../ui';

/** Avatar do contato: iniciais do nome do WhatsApp ou, sem nome, o ícone de pessoa. */
export function ContactAvatar({ name }: { name: string | null }) {
  if (name?.trim()) return <Avatar name={name} large />;
  return (
    <span className="avatar lg wa-noname" aria-hidden="true">
      <IconUser size={20} />
    </span>
  );
}
