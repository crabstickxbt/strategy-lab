# Strategy Lab (SP500 vs SNP1/SNP10) — PIT-style Historical Pipeline

Static Strategy Lab deployment with precomputed artifacts in `docs/data` and selector-based UI in `docs/index.html`.

## What was upgraded

- Replaced fixed 10-stock proxy universe with **point-in-time-like S&P 500 membership by date**.
- SNP1/SNP10 now rank within daily historical constituent sets (PIT-like), not a static basket.
- Kept existing website selectors/UX and artifact naming intact.
- Added explicit provenance + caveats + confidence metadata in JSON outputs.

## Public no-auth data sources used

1. **Historical S&P 500 membership (daily snapshots, 1996→present)**  
   `https://raw.githubusercontent.com/hanshof/sp500_constituents/main/sp_500_historical_components.csv`
2. **Daily OHLC market data (Stooq CSV endpoint)**  
   `https://stooq.com/q/d/l/?s=<symbol>&i=d`
3. **Latest shares outstanding proxy (Yahoo quoteSummary, no key)**  
   `https://query1.finance.yahoo.com/v10/finance/quoteSummary/<symbol>?modules=defaultKeyStatistics,price,summaryDetail`

## Method summary

- Build PIT universe from historical membership file by date.
- Normalize ticker -> Stooq symbol with dot/dash fallbacks.
- Fetch benchmark and constituent OHLC.
- Rank by cap proxy using `close * latest_shares_outstanding`; if shares unavailable, fallback to close-only weighting/ranking.
- Compute:
  - SNP1 (base/optimistic/pessimistic execution variants)
  - SNP10 (base)
  - benchmark S&P500 TR proxy (prefer Stooq TR symbols, else ^SPX + dividend carry proxy)
- Generate 5/10/25/50 selector artifacts ending on latest available date.

## Important caveats

- Membership source covers **1996-present**, so requested 50Y uses maximum available history (ends latest date).
- True historical shares outstanding is not fully available no-auth; cap ranking uses latest shares where available.
- Delisted/legacy symbols often fallback to price-only weighting, reducing market-cap fidelity.
- Strategy constituent dividends are not fully reconstructed PIT in this free-source pipeline.

## Confidence (historical accuracy)

- **Overall: MEDIUM**
- High confidence: PIT membership + daily OHLC history.
- Medium confidence: cap proxy with partial shares coverage.
- Lower confidence: very long windows and dividend/composition details for old/delisted names.

## Generate + deploy data

```bash
cd frontend
npm install
npm run generate:data

cd ..
mkdir -p docs/data
cp -f frontend/public/data/* docs/data/
```

Then commit to `main`; GitHub Pages serves from `main:/docs`.
