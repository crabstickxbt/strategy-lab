# Strategy Lab (SP500 vs SNP1/SNP10)

Static Strategy Lab deployment with precomputed artifacts in `docs/data` and selector-based UI in `docs/index.html`.

## Data source (now real historical OHLC)

The pipeline now uses **real daily OHLC bars** from Stooq CSV (no-auth):

- Benchmark proxy: `^SPX` (S&P 500 index), normalized to 100 at each timeframe start
- Strategy symbols (fixed long-history proxy universe): `XOM, IBM, GE, KO, PG, JNJ, CVX, MMM, CAT, MRK`
- Symbol feed map is encoded in each JSON artifact under `metadata.dataSource.symbolToStooq`

## Important realism assumptions (auditable)

Because perfect historical S&P 500 constituent + point-in-time market cap data is not available from this no-auth source, the generator uses transparent approximations:

1. **Universe approximation:** fixed 10-stock long-history proxy universe (not full historical S&P 500 membership)
2. **Ranking approximation for SNP1/SNP10:** market-cap proxy = `close * static sharesOutstanding`
3. **Shares outstanding:** static modern approximations hardcoded in generator (not historical per-date reconstruction)
4. **Date alignment:** only dates present in benchmark and all strategy symbols are used (intersection)

All assumptions are emitted in:
- `frontend/public/data/index.json` (`metadata.assumptions`)
- each scenario JSON (`metadata.assumptions` + `metadata.dataSource`)

## Strategy behavior

- **SNP1:** hold top-1 by proxy market cap; switch on next day under scenario fill rules
- **SNP10:** hold top-10 by proxy market cap, cap-weighted by proxy market cap
- **Base scenario:** explicit turnover costs + hysteresis controls
- **Optimistic/Pessimistic (SNP1):** execution stress bounds

## Timeframes / UX

Artifacts are generated for **5Y / 10Y / 25Y / 50Y** and selector mapping is preserved via `docs/data/index.json`.

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
