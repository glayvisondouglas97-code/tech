import type { CampaignPreview } from '../../../shared/api';
import { errorMessage } from '../../lib/api';
import { fmtN, plural } from '../../lib/format';
import { LIMIT_REACHED_LABEL, usageBreakdown } from '../../lib/quota';
import { CampaignCalendar } from './CampaignCalendar';

/**
 * A prévia da campanha, toda contada pelo servidor: o público (agregado numa consulta só, sem carregar leads), os números
 * com a cota de hoje, a capacidade real, a estimativa aproximada e o calendário. A tela não recalcula nada.
 */
export function CampaignPreviewPanel({
  preview,
  fetching,
  error,
  waiting,
}: {
  preview: CampaignPreview | undefined;
  fetching: boolean;
  error: unknown;
  /** Falta preencher algo para o servidor poder calcular. */
  waiting: string | null;
}) {
  return (
    <section className="auto-preview" aria-live="polite" aria-label="Resumo da campanha" data-testid="previa">
      {waiting ? (
        <p className="sub">{waiting}</p>
      ) : error ? (
        <p className="banner bad" role="alert">
          {errorMessage(error)}
        </p>
      ) : !preview ? (
        <span className="spinner" role="status" aria-label="Calculando" />
      ) : (
        <Body preview={preview} fetching={fetching} />
      )}
    </section>
  );
}

function Body({ preview: p, fetching }: { preview: CampaignPreview; fetching: boolean }) {
  const a = p.audience;
  return (
    <>
      <h3 className="camp-sub">
        Público {fetching && <span className="spinner sm" role="status" aria-label="Atualizando" />}
      </h3>
      <dl className="auto-preview-grid">
        <Stat label="Leads na lista" value={a.total} id="preview-total" />
        <Stat label="Leads que entram" value={a.eligible} id="preview-eligible" strong />
        <Stat label="Bloqueados (não contatar)" value={a.blocked} id="preview-blocked" />
        <Stat label="Sem WhatsApp" value={a.noWhatsapp} id="preview-sem-whatsapp" />
        <Stat label="Já participaram" value={a.participated} id="preview-participated" />
        <Stat label="Em cooldown" value={a.inCooldown} id="preview-cooldown" />
        <Stat label="Fora dos filtros" value={a.filteredOut} id="preview-filtered" />
      </dl>

      <h3 className="camp-sub">Capacidade</h3>
      <dl className="auto-preview-grid">
        <div>
          <dt>Números conectados</dt>
          <dd data-testid="preview-connected">
            {p.connectedNumbers} de {p.numbers.length}
          </dd>
        </div>
        <div>
          <dt>Disponível hoje</dt>
          <dd data-testid="preview-available">
            {plural(p.availableToday, 'contato novo', 'contatos novos')}
          </dd>
        </div>
        <div>
          <dt>Capacidade por dia</dt>
          <dd data-testid="preview-capacity">{plural(p.dailyCapacity, 'lead', 'leads')}</dd>
        </div>
      </dl>
      <ul className="auto-preview-numbers" aria-label="Números selecionados">
        {p.numbers.map((n) => (
          <li key={n.id} data-testid={`preview-numero-${n.id}`}>
            <b>{n.label}</b>
            <span>
              {!n.connected
                ? 'Desconectado · fora do rodízio'
                : n.limitReached
                  ? LIMIT_REACHED_LABEL
                  : `${n.usedToday}/${n.dailyLimit} hoje · disponível ${n.remainingToday}`}
            </span>
            <span className="sub small">
              {usageBreakdown({
                manual: n.manualToday,
                automatic: n.automaticToday,
                uncertain: n.uncertainToday,
              })}
            </span>
          </li>
        ))}
      </ul>

      {p.schedule.reason && (
        <p className="banner" role="status" data-testid="previa-agenda">
          {p.schedule.reason}
        </p>
      )}
      <CampaignCalendar days={p.calendar} estimate={p.estimate} />

      {p.connectedNumbers === 0 && (
        <p className="banner bad" role="status">
          Nenhum dos números escolhidos está conectado agora. Conecte pelo menos um.
        </p>
      )}
      {a.eligible === 0 && (
        <p className="banner bad" role="status">
          Não há leads elegíveis com esta lista e estes filtros ({fmtN(a.total)} na lista).
        </p>
      )}
      {p.activeAudios === 0 && (
        <p className="banner" role="status">
          Não há nenhum áudio ativo na biblioteca. Se alguma etapa sorteia áudio, a campanha não inicia.
        </p>
      )}
    </>
  );
}

function Stat({ label, value, id, strong }: { label: string; value: number; id: string; strong?: boolean }) {
  return (
    <div className={strong ? 'is-strong' : undefined}>
      <dt>{label}</dt>
      <dd data-testid={id}>{fmtN(value)}</dd>
    </div>
  );
}
