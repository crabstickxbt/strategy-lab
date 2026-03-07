import Link from "next/link";
import { EquityChart } from "./EquityChart";
import { StatsTable } from "./StatsTable";
import type { PrebuiltScenario } from "../lib/types";

type Props = {
  scenarioName: string;
  scenario: PrebuiltScenario;
};

export function ScenarioView({ scenarioName, scenario }: Props) {
  return (
    <main className="container">
      <h1>SP500 vs SNP1 ({scenarioName})</h1>
      <p>
        Universe is S&P 500 constituents only. SNP1 holds the highest market-cap name. When top1 changes at day t,
        rebalance on next trading day t+1 under the selected execution assumption.
      </p>

      <nav className="tabs">
        <Link href="/">Overview</Link>
        <Link href="/optimistic">Optimistic</Link>
        <Link href="/pessimistic">Pessimistic</Link>
        <Link href="/simulator">Interactive simulator</Link>
      </nav>

      <EquityChart
        labels={scenario.series.dates}
        baseline={scenario.series.sp500}
        strategy={scenario.series.snp1}
        baselineLabel="SP500"
        strategyLabel="SNP1"
      />
      <StatsTable baseline={scenario.stats.sp500} strategy={scenario.stats.snp1} />

      <section className="card">
        <h2>Dataset metadata</h2>
        <ul>
          <li>Generated at: {scenario.metadata.generatedAt}</li>
          <li>Formula version: {scenario.metadata.formulaVersion}</li>
          <li>Commit SHA: {scenario.metadata.commitSha}</li>
          <li>Executed swaps: {scenario.executedSwaps.length}</li>
        </ul>
      </section>
    </main>
  );
}
