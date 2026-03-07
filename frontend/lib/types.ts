export type SimulateParams = {
  drift: number;
  vol: number;
  shockFrequency: number;
  shockAmplitude: number;
};

export type StrategyStats = {
  cagr: number;
  annVol: number;
  maxDrawdown: number;
  sharpe: number;
};

export type StrategyResult = {
  dates: string[];
  returns: number[];
  levels: number[];
  stats: StrategyStats;
};

export type SimulationResponse = {
  meta: {
    periodYears: number;
    tradingDays: number;
    seed: string;
  };
  sp500: StrategyResult;
  snp1: StrategyResult;
};

export type PrebuiltScenario = {
  metadata: {
    generatedAt: string;
    formulaVersion: string;
    commitSha: string;
    assumptions: string[];
    scenario: "optimistic" | "pessimistic";
    tradingDaysPerYear: number;
  };
  series: {
    dates: string[];
    sp500: number[];
    snp1: number[];
    sp500Returns: number[];
    snp1Returns: number[];
  };
  top1ByDate: string[];
  holdingByDate: string[];
  executedSwaps: Array<{ date: string; from: string; to: string }>;
  stats: {
    sp500: StrategyStats;
    snp1: StrategyStats;
  };
};
