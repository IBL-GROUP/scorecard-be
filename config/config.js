import dotenv from 'dotenv';

dotenv.config();

const parseInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Builds one database config block from a set of `<PREFIX>_*` env vars, so a
 * second (or third) connection is a one-line addition rather than a copy of
 * the whole block. `fallbacks` lets a secondary connection inherit host/port
 * from the primary when it lives on the same server.
 */
const buildDatabaseConfig = (prefix, { defaultSchema, fallbacks = {} } = {}) => {
  const env = (key) => process.env[`${prefix}_${key}`];

  const poolMax = parseInteger(env('POOL_MAX'), 10);
  const poolMin = Math.min(parseInteger(env('POOL_MIN'), 0), poolMax);
  const queryConcurrency = Math.max(
    1,
    Math.min(parseInteger(env('QUERY_CONCURRENCY'), Math.min(poolMax, 8)), poolMax),
  );
  const searchPath = env('SCHEMA') || defaultSchema;

  return {
    host: env('HOST') || fallbacks.host || 'localhost',
    port: parseInteger(env('PORT'), fallbacks.port ?? 5432),
    database: env('NAME'),
    username: env('USER'),
    password: env('PASSWORD'),
    dialect: env('DIALECT') || fallbacks.dialect || 'postgres',
    logging: process.env.NODE_ENV === 'development' ? console.log : false,
    searchPath,
    dialectOptions: {
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
      statement_timeout: parseInteger(env('STATEMENT_TIMEOUT_MS'), 120000),
      idle_in_transaction_session_timeout: parseInteger(
        env('IDLE_TRANSACTION_TIMEOUT_MS'),
        120000,
      ),
      options: `-c search_path=${searchPath}`,
    },
    pool: {
      max: poolMax,
      min: poolMin,
      acquire: parseInteger(env('POOL_ACQUIRE'), 60000),
      idle: parseInteger(env('POOL_IDLE'), 10000),
    },
    query: {
      concurrency: queryConcurrency,
      slowQueryMs: Math.max(0, parseInteger(env('SLOW_QUERY_MS'), 5000)),
    },
  };
};

const primary = buildDatabaseConfig('DB', {
  defaultSchema: 'primary_secondary_sales_schm,public',
});

// Second database — RD stock (franchise schema). Host/port default to the
// primary's, so only the differing values need to be set in .env.
const secondary = buildDatabaseConfig('DB2', {
  defaultSchema: 'franchise,public',
  fallbacks: { host: primary.host, port: primary.port, dialect: primary.dialect },
});

export const config = {
  database: primary,
  databaseSecondary: {
    ...secondary,
    // The app boots without it; routes that need it fail individually with a
    // clear message instead of taking the whole server down.
    isConfigured: Boolean(secondary.database && secondary.username),
  },
  server: {
    port: parseInteger(process.env.PORT, 3005),
    env: process.env.NODE_ENV || 'development',
  },
  query: primary.query,
};
