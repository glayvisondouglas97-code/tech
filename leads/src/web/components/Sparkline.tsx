/** Minigráfico de linhas suaves: verde para chamados, vermelho para "sem WhatsApp". */
export function Sparkline({
  series,
  height = 96,
  label,
}: {
  series: { values: number[]; tone: 'ok' | 'bad' }[];
  height?: number;
  label: string;
}) {
  const W = 300;
  const H = height;
  const pad = 3;
  const n = series[0]?.values.length ?? 0;
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const x = (i: number) => (n <= 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v: number) => H - pad - (v / max) * (H - pad * 2);
  const path = (values: number[]) =>
    values.reduce((d, v, i) => {
      if (i === 0) return `M${x(0)},${y(v)}`;
      const px = x(i - 1);
      const mid = (px + x(i)) / 2;
      // Curva com tangente horizontal em cada ponto: picos suaves, sem passar do valor real.
      return `${d} C${mid},${y(values[i - 1] ?? 0)} ${mid},${y(v)} ${x(i)},${y(v)}`;
    }, '');
  return (
    <svg
      className="spark-svg"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      width="100%"
      height={H}
      role="img"
      aria-label={label}
    >
      <line className="spark-base" x1={0} x2={W} y1={H - pad} y2={H - pad} />
      {series.map((s) => (
        <path key={s.tone} className={`spark-line ${s.tone}`} d={path(s.values)} />
      ))}
    </svg>
  );
}
