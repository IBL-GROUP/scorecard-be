import { config } from "./config.js";
import { createSequelize } from "./create-sequelize.js";

const { sequelize, testConnection: test } = createSequelize(
  "db",
  config.database
);

// Test database connection
export const testConnection = test;

export default sequelize;
