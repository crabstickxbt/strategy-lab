# Strategy Lab (SP500 vs SNP1)

This project now supports **fully static GitHub Pages deployment** with pre-rendered scenario pages and precomputed datasets.

## Strategy definition (authoritative)

- **Universe:** S&P 500 constituents only
- **SNP1 rule:** on each trading day, hold the stock with the highest market cap in the S&P 500 universe
- **When top1 changes at day `t`:** execute swap on the next available trading day `t+1`
  - **Pessimistic:** sell old holding at `LOW(t+1)`, buy new holding at `HIGH(t+1)`
  - **Optimistic:** both legs at `avg(OPEN(t+1), CLOSE(t+1))`
- Compare each SNP1 variant against an SP500 benchmark

## Static data generation

A deterministic offline generator produces artifacts under `frontend/public/data`:

- `index.json` (manifest)
- `sp500_vs_snp1_optimistic.json`
- `sp500_vs_snp1_optimistic.csv`
- `sp500_vs_snp1_pessimistic.json`
- `sp500_vs_snp1_pessimistic.csv`

Each JSON payload includes metadata:
- `generatedAt`
- `formulaVersion`
- `commitSha`
- `assumptions`

The current implementation uses deterministic synthetic/mock market data through a provider interface (`MarketDataProvider`) so a real data source can be plugged in later.

Generate data:

```bash
cd frontend
npm install
npm run generate:data
```

## Frontend

Default UX showcases pre-rendered artifacts:
- `/optimistic`
- `/pessimistic`

The prior interactive simulator is still available at:
- `/simulator`

Build and local preview:

```bash
cd frontend
npm install
npm run generate:data
npm run build
npx serve out
```

## Checks

```bash
cd frontend
npm install
npm run typecheck
npm run lint
npm run build
```

`next.config.mjs` uses `output: "export"`, so build output is written to `frontend/out`.

## GitHub Pages workflow

Workflow file: `.github/workflows/deploy-pages.yml`

Pipeline steps:
1. Install frontend dependencies (`npm ci`)
2. Generate static data (`npm run generate:data`)
3. Typecheck + lint
4. Build/export Next.js static site
5. Upload `frontend/out` via `actions/upload-pages-artifact`
6. Deploy via `actions/deploy-pages`

### GitHub Pages setup notes

In your repository settings:
1. Enable **GitHub Pages** and set source to **GitHub Actions**
2. Ensure default branch is `main` (or adjust workflow trigger)
3. Push to `main` or trigger workflow manually from Actions tab
