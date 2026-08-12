import dotenv from 'dotenv';

dotenv.config();

const parseInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const dbPoolMax = parseInteger(process.env.DB_POOL_MAX, 10);
const dbPoolMin = Math.min(parseInteger(process.env.DB_POOL_MIN, 0), dbPoolMax);
const dbQueryConcurrency = Math.max(
  1,
  Math.min(parseInteger(process.env.DB_QUERY_CONCURRENCY, Math.min(dbPoolMax, 8)), dbPoolMax),
);

export const config = {
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInteger(process.env.DB_PORT, 5432),
    database: process.env.DB_NAME,
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    dialect: process.env.DB_DIALECT || 'postgres',
    logging: process.env.NODE_ENV === 'development' ? console.log : false,
    dialectOptions: {
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
      statement_timeout: parseInteger(process.env.DB_STATEMENT_TIMEOUT_MS, 120000),
      idle_in_transaction_session_timeout: parseInteger(
        process.env.DB_IDLE_TRANSACTION_TIMEOUT_MS,
        120000,
      ),
      options: `-c search_path=primary_secondary_sales_schm,public`,
    },
    pool: {
      max: dbPoolMax,
      min: dbPoolMin,
      acquire: parseInteger(process.env.DB_POOL_ACQUIRE, 60000),
      idle: parseInteger(process.env.DB_POOL_IDLE, 10000),
    },
  },
  server: {
    port: parseInteger(process.env.PORT, 3005),
    env: process.env.NODE_ENV || 'development',
  },
  query: {
    concurrency: dbQueryConcurrency,
    slowQueryMs: Math.max(0, parseInteger(process.env.DB_SLOW_QUERY_MS, 5000)),
  },
};
