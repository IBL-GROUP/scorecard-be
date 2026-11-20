# Supply Chain Pulse API (scorecard-be)

Read-only Express API for Supply Chain Pulse, answering from BigQuery
(`data-light-house-prod.EDW`). Every `/api` route needs the authenticator's JWT;
`/health` and `/api/health` are open.

## Run

```bash
npm install
npm run dev     # http://localhost:3005/api (nodemon)
npm start       # same, without reload (Docker)
```

## Environment (`.env`)

| Variable | What it is |
|---|---|
| `PORT` | default 3005 |
| `JWT_ACCESS_SECRET` | the authenticator's signing secret |
| `CORS_ORIGIN` | allowed origins, comma-separated |
| `GCP_PROJECT_ID`, `BIGQUERY_LOCATION`, `GCP_SERVICE_ACCOUNT_BASE64` (or `GOOGLE_APPLICATION_CREDENTIALS`) | BigQuery access |
| `BQ_ENV_FILE` | optional: read the BigQuery keys from another `.env` instead |
| `BQ_DATASET` | optional, default `<project>.EDW` |
| `CACHE_TTL_SECONDS`, `BQ_MAX_BYTES_BILLED`, `TIMEZONE` | optional tuning |

## Layout

```
server.js       app, routes, start
routes/         sales, inventory, operations (WIP, RMPM, dispatch, RD status), filters
lib/            BigQuery client (read-only, cached), env, SQL helpers, table map
middleware/     JWT check
```
