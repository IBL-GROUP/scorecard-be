import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { testConnection } from "./config/database.js";
import { testSecondaryConnection } from "./config/database.secondary.js";
import { config } from "./config/config.js";
import apiRoutes, { listApiEndpoints } from "./routes/api.js";
import { authenticate } from "./middleware/auth.js";

dotenv.config();

const app = express();
const PORT = config.server.port;

// Middleware
// Single FE origin behind host nginx; Bearer auth — no credentials.
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "https://dev.onethunder.iblgrp.com",
    credentials: false,
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Root route - API info
app.get("/", (req, res) => {
  res.json({
    name: "SupplyChain Pulse (Scorecard) Backend API",
    version: "1.0.0",
    status: "running",
    timestamp: new Date().toISOString(),
    environment: config.server.env,
    endpoints: {
      health: "/health",
      api: listApiEndpoints("/api"),
    },
  });
});

// Health check route
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    environment: config.server.env,
  });
});

// API routes
// Every /api route requires a valid authenticator session. "/" and "/health"
// stay open so uptime checks and the compose healthcheck keep working.
app.use("/api", authenticate, apiRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: "Route not found",
    path: req.path,
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Error:", err);
  res.status(err.status || 500).json({
    error: err.message || "Internal server error",
    ...(config.server.env === "development" && { stack: err.stack }),
  });
});

// Start server
const startServer = async () => {
  try {
    // Test database connection
    const dbConnected = await testConnection();
    if (!dbConnected) {
      console.error(
        "❌ Failed to connect to database. Please check your configuration."
      );
      console.log("\n📝 Steps to set up:");
      console.log("1. Copy .env.example to .env");
      console.log("2. Update database credentials in .env");
      console.log(
        "3. Run: npm run generate-models (to generate models from your database)"
      );
      console.log("4. Run: npm start\n");
      process.exit(1);
    }

    // Secondary database (RD stock). Optional — a failure here is logged but
    // does not stop the server; only the RD Status endpoints depend on it.
    await testSecondaryConnection();

    app.listen(PORT, () => {
      console.log("\n🚀 Server is running!");
      console.log(`📍 URL: http://localhost:${PORT}`);
      console.log(`🏥 Health: http://localhost:${PORT}/health`);
      console.log(`📊 API: http://localhost:${PORT}/api`);
      console.log(`🌍 Environment: ${config.server.env}\n`);
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
};

startServer();
