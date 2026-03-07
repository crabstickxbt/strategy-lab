import type { StrategyStats } from "../lib/types";

type Props = {
  baseline: StrategyStats;
  strategy: StrategyStats;
  baselineLabel?: string;
  strategyLabel?: string;
};

function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

export function StatsTable({ baseline, strategy, baselineLabel = "SP500", strategyLabel = "SNP1" }: Props) {
  return (
    <section className="card">
      <h2>Risk / Return Stats</h2>
      <table>
        <thead>
          <tr><th>Metric</th><th>{baselineLabel}</th><th>{strategyLabel}</th></tr>
        </thead>
        <tbody>
          <tr><td>CAGR</td><td>{pct(baseline.cagr)}</td><td>{pct(strategy.cagr)}</td></tr>
          <tr><td>Annual Volatility</td><td>{pct(baseline.annVol)}</td><td>{pct(strategy.annVol)}</td></tr>
          <tr><td>Max Drawdown</td><td>{pct(baseline.maxDrawdown)}</td><td>{pct(strategy.maxDrawdown)}</td></tr>
          <tr><td>Sharpe (rf=0)</td><td>{baseline.sharpe.toFixed(2)}</td><td>{strategy.sharpe.toFixed(2)}</td></tr>
        </tbody>
      </table>
    </section>
  );
}
