#!/usr/bin/env node
/**
 * Seeds the "Demo Bidding Sandbox" round with sample assets and bids.
 * Usage: npm run demo:seed
 */
const path = require("path");
const Database = require("better-sqlite3");
const migrate = require("../lib/migrate");
const { seedDemoAuction } = require("../lib/seed-demo-auction");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "auction.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
migrate(db);

const result = seedDemoAuction(db, { APP_TIMEZONE: process.env.APP_TIMEZONE });
if (result.alreadyExists) {
  console.log("Demo auction already exists (round id %s). No changes.", result.roundId);
} else {
  console.log("Demo seeded: round id %s, assets %s", result.roundId, result.assetIds.join(", "));
}
db.close();
