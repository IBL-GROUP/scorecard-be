# Searle Scorecard — Backend

Read-only analytics API behind **Supply Chain Pulse 1.0** (the Scorecard
dashboard, `scorecard-fe`). It serves supply-chain KPIs for the OneThunder
portal: sales by classification, inventory cover days, forecast and budget
accuracy, service measure, dispatch vs order, WIP, raw/packing material stock,
and regional-distributor (RD) stock upload status.

The service has **no login of its own**. Every `/api` call carries a JWT issued
by `authenticator-be`, verified locally with the shared `JWT_ACCESS_SECRET`.

## Tech Stack

- **Node.js 20** (ES modules) with **Express 4**
- **PostgreSQL** via **Sequelize** — raw, parameterised SQL only (no ORM models)
- **jsonwebtoken** — verifies authenticator tokens

## Getting Started

```bash
npm install
npm run dev      # nodemon, http://localhost:3005
npm start        # production
```

Startup tests the primary database and **exits if it fails**. `GET /health`
answers once the server is up, and `GET /` lists every mounted endpoint.

There is no test suite, no linter and no `.env.example`. `npm run
generate-models` (sequelize-auto) exists, but nothing uses the generated models.

### Environment

Read from `.env` locally, or `.env.sandbox` in Docker.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3005` | Listen port. Must match the published port in `docker-compose.yml` |
| `NODE_ENV` | `development` | `development` logs SQL and includes stacks in errors |
| `DB_HOST` `DB_PORT` `DB_NAME` `DB_USER` `DB_PASSWORD` | `localhost` / `5432` / — | Primary DB (`primary_secondary_sales_db`) |
| `DB_SCHEMA` | `primary_secondary_sales_schm,public` | `search_path`, set on every connection |
| `DB_POOL_MAX` / `DB_POOL_MIN` | `10` / `0` | Pool size |
| `DB_POOL_ACQUIRE` / `DB_POOL_IDLE` | `60000` / `10000` | Pool timeouts (ms) |
| `DB_QUERY_CONCURRENCY` | `min(pool max, 8)` | Queries allowed to run at once. Extras queue in-process |
| `DB_SLOW_QUERY_MS` | `5000` | Log `[db] slow query` above this execution time. `0` disables |
| `DB_STATEMENT_TIMEOUT_MS` / `DB_IDLE_TRANSACTION_TIMEOUT_MS` | `120000` | Postgres timeouts |
| `DB2_*` | host/port from `DB_*`; schema `franchise,public` | A second connection (`franchise_db`). **Configured and tested at startup, but no route uses it** — see [Known issues](#known-issues) |
| `JWT_ACCESS_SECRET` | — | **Required.** Must equal authenticator-be's value exactly |
| `CORS_ORIGIN` | `https://dev.onethunder.iblgrp.com` | Comma-separated allowed origins (no credentials — Bearer auth) |

`API_PREFIX`, `DB_DIALECT` (other than `postgres`), `JWT_REFRESH_*`,
`JWT_ACCESS_EXPIRY`, `CORS_CREDENTIALS`, `RATE_LIMIT_*` and `LOG_LEVEL` appear
in the env files but are **not read** by the code.

## Deployment

The image is `iblgroup/searle-scorecard-be:<tag>`. It runs as a non-root user
with a `/health` `HEALTHCHECK`, and binds to `127.0.0.1:3005` behind the host
nginx. `.dockerignore` excludes every `.env*` file, so configuration comes only
from `.env.sandbox` on the server via Compose's `env_file`.

```bash
# 1. Copy config to the server (first time, or when it changes)
scp docker-compose.yml root@<server>:/root/searle-scorecard/be/
scp .env.sandbox        root@<server>:/root/searle-scorecard/be/.env.sandbox

# 2. Build and push
docker build -t iblgroup/searle-scorecard-be:1.0.0 -f Dockerfile .
docker push iblgroup/searle-scorecard-be:1.0.0

# 3. On the server, from /root/searle-scorecard/be
docker compose pull && docker compose up -d --force-recreate   # recreate so an edited .env.sandbox is re-read

docker logs -f searle-scorecard-be
```

## Architecture

- **One database in practice.** Every route reads `primary_secondary_sales_db`
  through `config/database.js`.
- **Connection factory.** `config/create-sequelize.js` builds each connection
  with a concurrency limiter in front of `query`, slow-query logging, and the
  schema pinned on every new connection.
- **Authentication.** `middleware/auth.js` guards all of `/api`:
  - It verifies the Bearer token with `JWT_ACCESS_SECRET`.
  - It rejects tokens flagged `must_change_password`.
  - It sets `req.user = { user_id, user_name, email_id }`.

  `/` and `/health` are public.
- **No permission or scope checks.** Tab access is decided in the front end
  against the authenticator's `/me/permissions`.
- **No response cache.** Every request runs its SQL; the front end caches
  queries for 5 minutes.
- **Plain SQL.** Each route builds its SQL inline. Optional filters are added
  only when supplied (`AND col::text IN (:values)`), and values are always
  bound.

Main tables and views:

| Object | Used for |
|---|---|
| `vw_mv_tscl_data_` | Sales facts (amount, quantity, classification, branch) |
| `mv_tscl_spl_targets` | IBL targets (`target_date`, `loc_code`, `item_code`) |
| `mv_tscl_budget`, `tscl_efp`, `tscl_sap_targets` | TSCL budget, EFP prices, SAP target materials |
| `vw_daily_stock_movement_history` | Closing stock per location and day |
| `cover_days` | Benchmark cover days and inventory-days threshold per classification, **versioned by `effective_date`** |
| `vw_items_class`, `sap_items_detail` | SKU classification (A/B/C/N/Others) and item master |
| `mv_scoreboard_hub_mapping` | Branch / hub mapping |
| `vw_dispatch_vs_orders` | Dispatch vs order quantities |
| `sap_wip_data`, `sap_tpkg_traw_data`, `vw_invoice_productmap` | WIP and raw/packing material stock |
| `primary_secondary_stock`, `active_rds_list` | RD stock uploads |
| `organization.*` | `/me` identity, roles and permissions |

## Common Parameters

Most data routes accept:

| Parameter | Format | Notes |
|---|---|---|
| `startDate`, `endDate` | `YYYY-MM-DD` | Inclusive window. **Not validated** — omitting them yields empty results or a `500`. `/forecast-accuracy-monthly` defaults to `2026-03-01`–`2026-03-31` |
| `classification` | value or repeated | `A`, `B`, `C`, … |
| `sku` | value or repeated | Item codes |
| `branch` | value or repeated | Branch / location codes |

Responses are `{ success: true, count, data }`, or
`{ success: false, message, error }` with `500`.

## API

All routes are under `/api` and require a Bearer token. "Filters" lists which
of `classification` / `sku` / `branch` a route actually applies.

| Method | Route | Tab | Filters | Purpose |
|---|---|---|---|---|
| `GET` | `/sales-summary` | Summary | all | Sales amount and SKU count per classification |
| `GET` | `/cover-days` | Summary | all | Cover days per classification (inventory value ÷ daily target) |
| `GET` | `/cover-days/total` | Summary | all | Overall cover days |
| `GET` | `/cover-days/closing-inv` | Summary | — | Latest `stock_closing_date` (the "As of" label) |
| `GET` | `/cover-days/benchmarks` | Summary / Service Measure | — | Per classification: benchmark `days` and `threshold` in force on `endDate` (default today) |
| `GET` | `/forecast-accuracy-monthly` | Summary | all | Monthly sales vs IBL target |
| `GET` | `/forecast-accuracy-monthly/daysgone` | Summary | all | Target for the days elapsed so far (the front end caps `endDate` at today) |
| `GET` | `/forecast-accuracy-yearly` | Summary | all (sales only) | Despite the name, **one month**: EFP sales (`startDate` to `endDate − 1 day`) vs the `mv_tscl_budget` of `endDate`'s month |
| `GET` | `/forecast-accuracy-category-monthly` | Summary | all | Accuracy per classification, rolling 3 months ending `endDate` |
| `GET` | `/forecast-accuracy-category-yearly` | Summary | all | YTD accuracy per classification against `mv_tscl_budget` |
| `GET` | `/ibl-vs-tscl` | Summary | all | IBL target vs TSCL budget: Total, A, B, C, Others |
| `GET` | `/above-below-threshold` | Service Measure | `sku`, `branch` (not `classification`) | SKUs above/below the `cover_days` threshold per classification |
| `GET` | `/total-sku` | Summary | — | SKU count per classification (`vw_items_class`, includes N) |
| `GET` | `/inventory-days` | Service Measure | all | Cover days per classification × item, one column per branch. ⚠ Stock snapshot hard-coded to April 2026 |
| `GET` | `/service-measure` | Service Measure | all | % of SKUs above their class threshold, per branch (A/B/C/N). ⚠ Stock snapshot hard-coded to April 2026 |
| `GET` | `/tgt-vs-actual` | Service Measure | all | Closing inventory vs target cover days |
| `GET` | `/dispatch-vs-order` | Dispatch & WIP | `classification`, `sku` (no `branch`) | Delivered vs ordered quantity and fulfilment % |
| `GET` | `/wip` | Dispatch & WIP | none (dates only) | Work-in-progress stock by material |
| `GET` | `/rpm` | Dispatch & WIP | none (dates only) | Raw / packing material stock by material |
| `GET` | `/rd-status` | RD Data Status | — | Every active RD's current stock upload vs its last upload (`stock_*`, `last_stock_*`, `day_diff`). `date` is validated but **ignored** — the data is always as of today, returned as `asOf` |
| `GET` | `/filters` | all | — | SKU options: `item_code`, `item_description`, `classification` |
| `GET` | `/filters/branches` | all | — | Branch options (excludes `8210`, `8206`; one row per storage location) |
| `GET` | `/me` | — | — | Caller's identity, organization, roles and permission codes. Not used by the front end |

`GET /` (public) returns the live endpoint list, generated from
`routes/api.js`.

## Project Structure

```
server.js                       # Express app, CORS, /health, /api auth wall, startup DB checks
config/
├── config.js                   # Env → config; builds DB and DB2 blocks from prefixed vars
├── create-sequelize.js         # Sequelize factory: limiter, slow-query log, search_path
├── database.js                 # Primary connection
└── database.secondary.js       # Lazy DB2 connection (unused by routes)
middleware/auth.js              # authenticate — verifies authenticator JWTs
routes/
├── api.js                      # Route-group table: mounts routers, lists endpoints
├── routes.sales.summary.js
├── routes.cover.days.js        # /, /total, /closing-inv, /benchmarks
├── routes.forcast.accuracy.*.js  # monthly (+ /daysgone), yearly, category monthly/yearly
├── routes.ibl.vs.tscl.js
├── routes.above-below-threshold.js
├── routes.inventory.days.js
├── routes.service.measure.js
├── routes.tgt.vs.actual.js
├── routes.dispatch.vs.order.js
├── routes.wip.js
├── routes.rpm.js
├── routes.rd.status.js
├── routes.total.sku.js
├── routes.filters.js
├── routes.me.js
└── shared.js                   # Legacy Sequelize filter helper (unused)
models/index.js                 # Model loader (no models are generated or used)
scripts/generate-models.js
```

Formulas, output columns and business rules for each endpoint are in
[`TECHNICAL_DOCUMENT.md`](../TECHNICAL_DOCUMENT.md).

## Known Issues

- **Hard-coded stock dates.** `/inventory-days` (`2026-04-01`–`2026-04-21`)
  and `/service-measure` (`2026-04-01`–`2026-04-30`) ignore `startDate` and
  `endDate` for the stock snapshot. They always compare April 2026 stock with
  the selected month's targets.
- **Data access is not enforced server-side.** Any signed-in user can call
  every endpoint, whatever tabs their permissions allow.
- **The secondary database (`DB2_*`) is dead configuration.** It is tested at
  startup, but no route calls `getSecondaryDb()`. `/rd-status` reads the
  primary database, so the startup warning "RD Status endpoints will return
  503" is wrong.
- **Filters accepted but not applied.** `/wip`, `/rpm`, `/total-sku` and
  `/filters` have their filter clauses commented out. `/above-below-threshold`
  ignores `classification`, and `/dispatch-vs-order` ignores `branch`. `/filters` and
  `/filters/branches` build replacements they never use.
- **No input validation** on dates. `/forecast-accuracy-monthly` falls back to
  hard-coded March 2026 dates.
- **Compose mounts `./logs`**, but the app writes no log files.
- **Misspelled file names** (`forcast`) — the URLs are spelled correctly.
- **Startup message** refers to a missing `.env.example`.
