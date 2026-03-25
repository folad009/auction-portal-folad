/**
 * @param {import("better-sqlite3").Database} db
 */
function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auction_rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'Africa/Lagos',
      start_date_local TEXT,
      close_date_local TEXT,
      status TEXT NOT NULL DEFAULT 'OPEN',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id INTEGER NOT NULL,
      auction_code TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      location TEXT NOT NULL,
      minimum_bid REAL NOT NULL,
      image_url TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (round_id) REFERENCES auction_rounds(id),
      UNIQUE(round_id, auction_code)
    );

    CREATE TABLE IF NOT EXISTS bidders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT NOT NULL,
      email_verified INTEGER NOT NULL DEFAULT 0,
      phone_verified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS email_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bidder_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (bidder_id) REFERENCES bidders(id)
    );

    CREATE TABLE IF NOT EXISTS bids (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL,
      bidder_id INTEGER NOT NULL,
      bid_value REAL NOT NULL,
      submitted_at TEXT NOT NULL,
      FOREIGN KEY (asset_id) REFERENCES assets(id),
      FOREIGN KEY (bidder_id) REFERENCES bidders(id),
      UNIQUE(asset_id, bidder_id)
    );

    CREATE TABLE IF NOT EXISTS executive_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id INTEGER NOT NULL,
      asset_id INTEGER NOT NULL,
      executive_email TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      FOREIGN KEY (round_id) REFERENCES auction_rounds(id),
      FOREIGN KEY (asset_id) REFERENCES assets(id),
      UNIQUE(round_id, asset_id, executive_email)
    );

    CREATE TABLE IF NOT EXISTS executives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  const columns = db.prepare("PRAGMA table_info(auction_rounds)").all();
  const hasTimezone = columns.some((c) => c.name === "timezone");
  const hasStartLocal = columns.some((c) => c.name === "start_date_local");
  const hasCloseLocal = columns.some((c) => c.name === "close_date_local");
  if (!hasTimezone) db.prepare("ALTER TABLE auction_rounds ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Africa/Lagos'").run();
  if (!hasStartLocal) db.prepare("ALTER TABLE auction_rounds ADD COLUMN start_date_local TEXT").run();
  if (!hasCloseLocal) db.prepare("ALTER TABLE auction_rounds ADD COLUMN close_date_local TEXT").run();

  const assetColumns = db.prepare("PRAGMA table_info(assets)").all();
  const hasImageUrl = assetColumns.some((c) => c.name === "image_url");
  if (!hasImageUrl) db.prepare("ALTER TABLE assets ADD COLUMN image_url TEXT").run();
}

module.exports = migrate;
