import { config } from "./config.js";
import { createSequelize } from "./create-sequelize.js";

const dbConfig = config.databaseSecondary;

// Built lazily: an unconfigured secondary must not open a pool or log a banner
// at import time. Routes call `getSecondaryDb()` and get a clear error if the
// DB2_* env vars were never filled in.
let instance = null;

const build = () => {
  if (!instance) {
    instance = createSequelize("db2", dbConfig);
  }
  return instance;
};

export const isSecondaryConfigured = dbConfig.isConfigured;

export const getSecondaryDb = () => {
  if (!dbConfig.isConfigured) {
    throw Object.assign(
      new Error(
        "Secondary database is not configured — set DB2_NAME / DB2_USER / DB2_PASSWORD in .env"
      ),
      { status: 503 }
    );
  }
  return build().sequelize;
};

export const testSecondaryConnection = async () => {
  if (!dbConfig.isConfigured) {
    console.warn(
      "⚠ [db2] secondary database not configured — RD Status endpoints will return 503"
    );
    return false;
  }
  return build().testConnection();
};
