type Props = {
  labels: string[];
  baseline: number[];
  strategy: number[];
  baselineLabel?: string;
  strategyLabel?: string;
};

function pathFromSeries(series: number[], width: number, height: number, min: number, max: number): string {
  return series
    .map((v, i) => {
      const x = (i / (series.length - 1)) * width;
      const y = height - ((v - min) / (max - min || 1)) * height;
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

export function EquityChart({ labels, baseline, strategy, baselineLabel = "SP500", strategyLabel = "SNP1" }: Props) {
  const width = 900;
  const height = 320;
  const all = [...baseline, ...strategy];
  const min = Math.min(...all);
  const max = Math.max(...all);

  return (
    <section className="card">
      <h2>Cumulative Growth (Base = 100)</h2>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Equity chart">
        <path d={pathFromSeries(baseline, width, height, min, max)} className="line sp500" />
        <path d={pathFromSeries(strategy, width, height, min, max)} className="line snp1" />
      </svg>
      <div className="legend">
        <span><i className="dot sp500" /> {baselineLabel}</span>
        <span><i className="dot snp1" /> {strategyLabel}</span>
        <span className="muted">{labels[0]} → {labels[labels.length - 1]}</span>
      </div>
    </section>
  );
}
