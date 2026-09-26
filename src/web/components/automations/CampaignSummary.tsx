import type { CampaignInput, CampaignPreview } from '../../../shared/api';
import { formatDays } from '../../../shared/campaign-plan';
import { describeFilters, describePeriod, estimateText } from '../../lib/campaign-form';
import { fmtYmd, plural } from '../../lib/format';

/**
 * O último passo antes de iniciar ou agendar: tudo o que vai valer, em palavras, para a pessoa conferir. Os números
 * (público, capacidade, estimativa) são os da prévia do servidor; o resto é o que ela mesma configurou.
 */
export function CampaignSummary({
  automationName,
  listName,
  numberLabels,
  input,
  preview,
  scheduled,
}: {
  automationName: string;
  listName: string;
  numberLabels: string[];
  input: CampaignInput;
  preview: CampaignPreview;
  scheduled: boolean;
}) {
  const filters = describeFilters(input.filters ?? {});
  const cooldown = input.cooldownHours ?? 0;
  const period = scheduled
    ? describePeriod(input.startDate ?? '', input.endDate ?? null)
    : input.endDate
      ? `começa agora, até ${fmtYmd(input.endDate)}`
      : 'começa agora, sem data final';
  return (
    <div className="camp-summary" data-testid="resumo-final">
      <p className="sub">
        Confira tudo antes de {scheduled ? 'agendar' : 'iniciar'}.{' '}
        {scheduled
          ? 'A campanha fica agendada e nada é enviado antes da data de início.'
          : 'Fora do horário de trabalho, a campanha espera a próxima janela válida.'}
      </p>
      <dl className="camp-summary-list">
        <Row label="Automação" value={automationName} />
        <Row label="Lista" value={listName} />
        <Row
          label="Público"
          value={`${plural(preview.audience.eligible, 'lead entra', 'leads entram')} de ${preview.audience.total} na lista`}
          id="resumo-publico"
        />
        <Row
          label="Filtros"
          value={
            filters.length ? filters.join(' · ') : 'Nenhum filtro (regra padrão: fila livre, com celular)'
          }
        />
        <Row
          label="Números"
          value={`${numberLabels.join(', ')} (${preview.connectedNumbers} conectado${preview.connectedNumbers === 1 ? '' : 's'})`}
        />
        <Row
          label="Áudios"
          value={
            preview.activeAudios > 0
              ? `${plural(preview.activeAudios, 'áudio ativo', 'áudios ativos')} na biblioteca: cada envio sorteia um, sem repetir até usar todos`
              : 'Nenhum áudio ativo na biblioteca'
          }
        />
        <Row label="Horário (São Paulo)" value={`${input.windowStart} às ${input.windowEnd}`} />
        <Row label="Dias" value={formatDays(input.daysOfWeek ?? [])} />
        <Row label="Período" value={period} id="resumo-periodo" />
        <Row
          label="Cota"
          value={`Até ${plural(input.dailyLimitPerNumber, 'contato', 'contatos')} por número por dia, somando manuais e automáticos`}
        />
        <Row
          label="Cooldown"
          value={
            cooldown > 0
              ? `${plural(cooldown, 'hora', 'horas')} depois de um primeiro contato automático (as etapas seguintes da mesma execução não esperam)`
              : 'Sem cooldown'
          }
        />
        <Row
          label="Capacidade"
          value={`${plural(preview.dailyCapacity, 'contato novo', 'contatos novos')} por dia · hoje ainda ${preview.availableToday === 1 ? 'cabe' : 'cabem'} ${plural(preview.availableToday, 'contato', 'contatos')}`}
        />
        <Row label="Estimativa" value={estimateText(preview.estimate)} />
      </dl>
      <p className="banner" role="note">
        <span>
          O limite diário é um controle operacional do sistema. Ele <b>não garante</b> que o WhatsApp não vá
          restringir ou bloquear um número.
        </span>
      </p>
    </div>
  );
}

function Row({ label, value, id }: { label: string; value: string; id?: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd data-testid={id}>{value}</dd>
    </div>
  );
}
