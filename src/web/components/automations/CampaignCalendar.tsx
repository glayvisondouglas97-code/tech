import {
  type CalendarDay,
  type CalendarDayState,
  type CampaignEstimate,
  WEEKDAYS,
} from '../../../shared/campaign-plan';
import { estimateText } from '../../lib/campaign-form';
import { fmtYmd } from '../../lib/format';

const STATE_LABELS: Record<CalendarDayState, string> = {
  runs: 'Executa',
  not_allowed: 'Sem execução',
  before_start: 'Antes do início',
  after_end: 'Depois do fim',
  window_closed: 'Horário encerrado',
};

const weekday = (iso: number) => WEEKDAYS.find((d) => d.iso === iso)?.short ?? '';

/**
 * Calendário de capacidade: para cada dia, se a campanha executa e quantos contatos novos cabem (números conectados x
 * limite, já descontado o que foi feito hoje). Tudo calculado pelo servidor; aqui só se mostra. Cartões que quebram linha:
 * sem rolagem horizontal, no computador e no celular.
 */
export function CampaignCalendar({ days, estimate }: { days: CalendarDay[]; estimate?: CampaignEstimate }) {
  if (days.length === 0) return null;
  return (
    <section className="camp-cal" aria-label="Calendário de capacidade" data-testid="calendario">
      {estimate && (
        <p className="camp-estimate" data-testid="estimativa">
          {estimateText(estimate)}
        </p>
      )}
      <ul className="camp-cal-grid">
        {days.map((d) => (
          <li
            key={d.date}
            className={`camp-cal-day is-${d.state}`}
            data-state={d.state}
            data-testid={`cal-${d.date}`}
          >
            <span className="camp-cal-wd">{weekday(d.weekday)}</span>
            <b>{fmtYmd(d.date).slice(0, 5)}</b>
            <span className="camp-cal-cap">
              {d.state === 'runs'
                ? `${d.capacity} ${d.capacity === 1 ? 'contato' : 'contatos'}`
                : STATE_LABELS[d.state]}
            </span>
          </li>
        ))}
      </ul>
      <p className="sub small">
        A capacidade de cada dia é de números conectados x limite por número. Contatos manuais e falhas de
        conexão podem mudar isso; é uma previsão, não uma promessa.
      </p>
    </section>
  );
}
