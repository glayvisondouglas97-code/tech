import type { ReactNode } from 'react';
import type { LeadItem } from '../../shared/api';
import { useLeadActions, useWhatsappLink } from '../lib/leads';

/**
 * Link click-to-chat (wa.me). No celular o sistema entrega o link ao aplicativo do WhatsApp;
 * no computador abre o WhatsApp Desktop ou o Web. O referenciador não é enviado.
 */
export function WhatsAppLink({
  lead,
  templateId,
  className,
  children,
  title,
  onOpen,
}: {
  lead: LeadItem;
  templateId: string | 'none' | null;
  className: string;
  children: ReactNode;
  title?: string;
  onOpen?: () => void;
}) {
  const link = useWhatsappLink();
  const actions = useLeadActions();
  return (
    <a
      className={className}
      href={link(lead, templateId)}
      target="_blank"
      rel="noopener noreferrer"
      referrerPolicy="no-referrer"
      title={title}
      aria-label={title}
      onClick={() => {
        actions.whatsappOpened(lead);
        onOpen?.();
      }}
    >
      {children}
    </a>
  );
}
