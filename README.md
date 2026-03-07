# Strategy Lab (SP500 vs SNP1/SNP10) — Total Return Mode

Static Strategy Lab deployment with precomputed artifacts in `docs/data` and selector-based UI in `docs/index.html`.

## Data source

The pipeline uses **real daily OHLC bars** from Stooq CSV (no-auth):

- Benchmark price proxy: `^SPX`
- Preferred benchmark TR symbols attempted first: `^spxt`, `^spxtr`, `^sp500tr`
- Strategy symbols (fixed long-history proxy universe): `XOM, IBM, GE, KO, PG, JNJ, CVX, MMM, CAT, MRK`
- Symbol feed map is encoded in JSON artifacts under `metadata.dataSource.symbolToStooq`

## Total Return (TR) methodology

Daily total return is computed as:

`TR_daily = price_return_daily + dividend_return_daily`

### Benchmark (SP500)

1. Try Stooq benchmark TR proxies (`^spxt`, `^spxtr`, `^sp500tr`)
2. If unavailable, use `^SPX` price return plus modeled dividend carry

Current implementation records which path was used in:
- `metadata.dataSource.benchmarkTotalReturnAvailableFromSource`
- `metadata.dataSource.benchmarkSymbol`
- `metadata.dividendModel`

### Strategies (SNP1/SNP10)

SNP1 and SNP10 are TR-aware by adding modeled dividend carry for held names each day:

- SNP1: dividend carry of current held symbol added to daily return stream
- SNP10: weighted dividend carry from target weights added to daily basket return

Modeled annual dividend proxy yields used (if no source-provided TR):

- Benchmark (`^SPX` fallback): **1.80%**
- Constituents: XOM 3.40%, IBM 4.30%, GE 0.30%, KO 3.00%, PG 2.40%, JNJ 3.00%, CVX 4.10%, MMM 3.60%, CAT 1.80%, MRK 2.70%
- Daily convention: `annualYield / 252`

## Important realism assumptions (auditable)

1. **Universe approximation:** fixed 10-stock long-history proxy universe (not full historical S&P 500 membership)
2. **Ranking approximation for SNP1/SNP10:** market-cap proxy = `close * static sharesOutstanding`
3. **Shares outstanding:** static modern approximations hardcoded in generator (not historical per-date reconstruction)
4. **Dividend modeling:** where source TR is unavailable, dividend return is modeled via static annual yield proxies
5. **Date alignment:** only dates present in benchmark and all strategy symbols are used (intersection)

All assumptions are emitted in:
- `frontend/public/data/index.json` (`metadata.assumptions` + `metadata.dividendModel`)
- each scenario JSON (`metadata.assumptions` + `metadata.dataSource` + `metadata.dividendModel`)

## Timeframes / selectors

Artifacts are generated for **5Y / 10Y / 25Y / 50Y**; selector mapping is preserved via `docs/data/index.json`.

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
