"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ControlsPanel } from "../../components/ControlsPanel";
import { EquityChart } from "../../components/EquityChart";
import { StatsTable } from "../../components/StatsTable";
import { simulateLocal } from "../../lib/simulate";
import type { SimulateParams } from "../../lib/types";

const DEFAULT_PARAMS: SimulateParams = {
  drift: 0.1,
  vol: 0.2,
  shockFrequency: 0.02,
  shockAmplitude: 0.04,
};

export default function SimulatorPage() {
  const [params, setParams] = useState<SimulateParams>(DEFAULT_PARAMS);
  const data = useMemo(() => simulateLocal(params), [params]);

  return (
    <main className="container">
      <h1>Interactive Local Simulator</h1>
      <p>Optional local playground. Static pre-rendered scenario pages remain the default deployment UX.</p>
      <p><Link href="/">Back to overview</Link></p>

      <ControlsPanel params={params} onChange={setParams} />
      <EquityChart labels={data.sp500.dates} baseline={data.sp500.levels} strategy={data.snp1.levels} />
      <StatsTable baseline={data.sp500.stats} strategy={data.snp1.stats} />
    </main>
  );
}
