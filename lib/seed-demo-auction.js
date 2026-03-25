const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");

dayjs.extend(utc);
dayjs.extend(timezone);

const DEMO_ROUND_TITLE = "Demo Bidding Sandbox";

function localDateRangeToUtc(startDate, closeDate, tz) {
  const startUtc = dayjs.tz(`${startDate} 00:00:00`, tz).utc().toISOString();
  const endUtc = dayjs.tz(`${closeDate} 23:59:00`, tz).utc().toISOString();
  return { startUtc, endUtc };
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Idempotent: if demo round already exists, returns { ok, alreadyExists: true, roundId }.
 */
function seedDemoAuction(db, options = {}) {
  const tz = options.APP_TIMEZONE || process.env.APP_TIMEZONE || "Africa/Lagos";
  const startDate = dayjs().format("YYYY-MM-DD");
  const closeDate = dayjs().add(14, "day").format("YYYY-MM-DD");
  const { startUtc, endUtc } = localDateRangeToUtc(startDate, closeDate, tz);

  const existing = db.prepare("SELECT id FROM auction_rounds WHERE title = ?").get(DEMO_ROUND_TITLE);
  if (existing) {
    return { ok: true, alreadyExists: true, roundId: existing.id };
  }

  const placeholderImage =
    "https://images.unsplash.com/photo-1560518883-ce09059eeffa?w=800&q=80";

  const tx = db.transaction(() => {
    const roundId = db
      .prepare(
        "INSERT INTO auction_rounds (title, start_at, end_at, timezone, start_date_local, close_date_local, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?)"
      )
      .run(DEMO_ROUND_TITLE, startUtc, endUtc, tz, startDate, closeDate, nowIso()).lastInsertRowid;

    const insertAsset = db.prepare(
      "INSERT INTO assets (round_id, auction_code, name, description, location, minimum_bid, image_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );

    const r1 = insertAsset.run(
      roundId,
      "DEMO-001",
      "Sample Office Workstation Set",
      "Demo lot for testing bids: desks and chairs in good condition.",
      "Lagos (Demo)",
      5000,
      placeholderImage,
      nowIso()
    );
    const asset1Id = r1.lastInsertRowid;

    const r2 = insertAsset.run(
      roundId,
      "DEMO-002",
      "Sample Generator (Portable)",
      "Demo lot for testing: portable generator, as-is.",
      "Abuja (Demo)",
      12000,
      placeholderImage,
      nowIso()
    );
    const asset2Id = r2.lastInsertRowid;

    let insBidder = db.prepare(
      "INSERT INTO bidders (name, email, phone, email_verified, phone_verified, created_at) VALUES (?, ?, ?, 1, 1, ?)"
    );
    try {
      insBidder.run("Demo Bidder Alpha", "demo.bidder.alpha@example.com", "+234 800 111 1111", nowIso());
    } catch (e) {
      if (!String(e.message || "").includes("UNIQUE")) throw e;
      db.prepare("UPDATE bidders SET name = ?, phone = ?, email_verified = 1, phone_verified = 1 WHERE email = ?").run(
        "Demo Bidder Alpha",
        "+234 800 111 1111",
        "demo.bidder.alpha@example.com"
      );
    }
    try {
      insBidder.run("Demo Bidder Beta", "demo.bidder.beta@example.com", "+234 800 222 2222", nowIso());
    } catch (e) {
      if (!String(e.message || "").includes("UNIQUE")) throw e;
      db.prepare("UPDATE bidders SET name = ?, phone = ?, email_verified = 1, phone_verified = 1 WHERE email = ?").run(
        "Demo Bidder Beta",
        "+234 800 222 2222",
        "demo.bidder.beta@example.com"
      );
    }

    const alpha = db.prepare("SELECT id FROM bidders WHERE email = ?").get("demo.bidder.alpha@example.com");
    const beta = db.prepare("SELECT id FROM bidders WHERE email = ?").get("demo.bidder.beta@example.com");

    const insertBid = db.prepare(
      "INSERT INTO bids (asset_id, bidder_id, bid_value, submitted_at) VALUES (?, ?, ?, ?)"
    );
    insertBid.run(asset1Id, alpha.id, 6200, nowIso());
    insertBid.run(asset1Id, beta.id, 7500, nowIso());
    insertBid.run(asset2Id, alpha.id, 15000, nowIso());

    return { roundId, assetIds: [asset1Id, asset2Id] };
  });

  const result = tx();
  return { ok: true, alreadyExists: false, ...result };
}

module.exports = { seedDemoAuction, DEMO_ROUND_TITLE, localDateRangeToUtc };
