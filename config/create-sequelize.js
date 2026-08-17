import { Sequelize } from "sequelize";

const normalizeSql = (sql) => String(sql).replace(/\s+/g, " ").trim();

const createLimiter = (maxConcurrency) => {
  let activeCount = 0;
  const queue = [];

  const runNext = () => {
    if (activeCount >= maxConcurrency || queue.length === 0) {
      return;
    }

    const { task, resolve, reject } = queue.shift();
    activeCount += 1;

    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        activeCount -= 1;
        runNext();
      });
  };

  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      runNext();
    });
};

/**
 * Builds a Sequelize instance with this project's conventions applied: a
 * concurrency limiter in front of `query`, slow-query logging, and the schema
 * pinned on every new connection.
 *
 * Every connection in the app goes through here, so the two databases behave
 * identically apart from their credentials and schema.
 *
 * @param {string} label      Short name used in log lines, e.g. "db" or "db2".
 * @param {object} dbConfig   A `config.databases.*` entry.
 * @returns {{ sequelize: import('sequelize').Sequelize, testConnection: () => Promise<boolean> }}
 */
export const createSequelize = (label, dbConfig) => {
  const sequelize = new Sequelize(
    dbConfig.database,
    dbConfig.username,
    dbConfig.password,
    {
      host: dbConfig.host,
      port: dbConfig.port,
      dialect: dbConfig.dialect,
      logging: dbConfig.logging,
      dialectOptions: dbConfig.dialectOptions,
      pool: dbConfig.pool,
    }
  );

  const limitQuery = createLimiter(dbConfig.query.concurrency);
  const originalQuery = sequelize.query.bind(sequelize);

  sequelize.query = async (sql, options = {}) => {
    const queuedAt = Date.now();

    return limitQuery(async () => {
      const startedAt = Date.now();

      try {
        return await originalQuery(sql, options);
      } finally {
        const executionMs = Date.now() - startedAt;
        const queuedMs = startedAt - queuedAt;

        if (
          dbConfig.query.slowQueryMs > 0 &&
          executionMs >= dbConfig.query.slowQueryMs
        ) {
          console.warn(
            `[${label}] slow query execution=${executionMs}ms queued=${queuedMs}ms sql="${normalizeSql(sql).slice(0, 240)}"`
          );
        }
      }
    });
  };

  console.log(
    `[${label}] pool max=${dbConfig.pool.max}, min=${dbConfig.pool.min}, query concurrency=${dbConfig.query.concurrency}`
  );

  sequelize.afterConnect(async (connection) => {
    await connection.query(`SET search_path TO ${dbConfig.searchPath}`);
  });

  const testConnection = async () => {
    try {
      await sequelize.authenticate();
      console.log(
        `✓ [${label}] connection established (${dbConfig.host}:${dbConfig.port}/${dbConfig.database})`
      );
      return true;
    } catch (error) {
      console.error(`✗ [${label}] unable to connect:`, error.message);
      return false;
    }
  };

  return { sequelize, testConnection };
};
