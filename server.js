const express = require("express");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const Database = require("better-sqlite3");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
const { z } = require("zod");
const nodemailer = require("nodemailer");
const multer = require("multer");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const { google } = require("googleapis");
const { Readable } = require("stream");
const migrate = require("./lib/migrate");
const { seedDemoAuction, DEMO_ROUND_TITLE } = require("./lib/seed-demo-auction");

dayjs.extend(utc);
dayjs.extend(timezone);

const app = express();
const PORT = Number(process.env.PORT || 3000);
const IS_VERCEL = Boolean(process.env.VERCEL);
const DB_PATH =
  process.env.DB_PATH || (IS_VERCEL ? "/tmp/auction.db" : path.join(__dirname, "data", "auction.db"));
const EXEC_EMAILS = (process.env.EXEC_EMAILS || "exec1@example.com,exec2@example.com,exec3@example.com")
  .split(",")
  .map((x) => x.trim().toLowerCase())
  .filter(Boolean);

/** Only these emails may sign in at /admin/login (defaults to EXEC_EMAILS if unset). Bidders never use this table. */
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || process.env.EXEC_EMAILS || "exec1@example.com,exec2@example.com,exec3@example.com")
  .split(",")
  .map((x) => x.trim().toLowerCase())
  .filter(Boolean);

/** Anyone in EXEC_EMAILS or ADMIN_EMAILS may record an executive approval (union). */
const APPROVER_EMAILS = [...new Set([...EXEC_EMAILS, ...ADMIN_EMAILS])];

if (!IS_VERCEL) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
const upload = multer({ storage: multer.memoryStorage() });
const APP_TIMEZONE = process.env.APP_TIMEZONE || "Africa/Lagos";
const DRIVE_FOLDER_ID = process.env.GDRIVE_FOLDER_ID || "";
const DRIVE_CLIENT_EMAIL = process.env.GDRIVE_CLIENT_EMAIL || "";
const DRIVE_PRIVATE_KEY = (process.env.GDRIVE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

function seedAdministrators() {
  const defaultPassword = process.env.EXEC_DEFAULT_PASSWORD || "ChangeMe123!";
  const hash = bcrypt.hashSync(defaultPassword, 10);
  const existingCount = db.prepare("SELECT COUNT(*) AS count FROM executives").get().count;
  if (existingCount > 0) return;

  const insert = db.prepare("INSERT INTO executives (email, password_hash, created_at) VALUES (?, ?, ?)");
  const tx = db.transaction(() => {
    for (const email of ADMIN_EMAILS) insert.run(email, hash, nowIso());
  });
  tx();
}

function makeTransporter() {
  if (!process.env.SMTP_HOST) {
    return null;
  }
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" }
      : undefined,
  });
}

const mailer = makeTransporter();
async function sendEmail(to, subject, text) {
  if (!mailer) {
    console.log(`[MAILER OFF] To: ${to} | Subject: ${subject}\n${text}`);
    return;
  }
  await mailer.sendMail({
    from: process.env.MAIL_FROM || "auction-portal@example.com",
    to,
    subject,
    text,
  });
}

const bidSchema = z.object({
  assetId: z.coerce.number().int().positive(),
  name: z.string().min(2).max(100),
  email: z.string().email(),
  phone: z.string().regex(/^[0-9+\-() ]{7,20}$/, "Invalid phone number format"),
  bidValue: z.coerce.number().positive(),
});

function nowIso() {
  return new Date().toISOString();
}

function getActiveAssets() {
  return db
    .prepare(
      `
      SELECT
        a.id, a.round_id, a.auction_code, a.name, a.description, a.location, a.minimum_bid, a.image_url,
        r.title AS round_title, r.start_at, r.end_at, r.status
      FROM assets a
      JOIN auction_rounds r ON r.id = a.round_id
      WHERE r.status = 'OPEN'
      ORDER BY r.end_at ASC, a.auction_code ASC
      `
    )
    .all();
}

function getAssetWithRound(assetId) {
  return db
    .prepare(
      `
      SELECT
        a.*,
        r.title AS round_title, r.start_at, r.end_at, r.status
      FROM assets a
      JOIN auction_rounds r ON r.id = a.round_id
      WHERE a.id = ?
      `
    )
    .get(assetId);
}

function closeExpiredRoundsAndNotify() {
  const now = dayjs.utc().toISOString();
  const rounds = db
    .prepare("SELECT * FROM auction_rounds WHERE status = 'OPEN' AND end_at <= ?")
    .all(now);

  for (const round of rounds) {
    db.prepare("UPDATE auction_rounds SET status = 'CLOSED' WHERE id = ?").run(round.id);

    const assets = db.prepare("SELECT * FROM assets WHERE round_id = ? ORDER BY auction_code").all(round.id);
    const reportLines = [
      `Auction round closed: ${round.title}`,
      `Closing time: ${round.end_at}`,
      "",
      "Bid summary per asset:",
    ];

    for (const asset of assets) {
      const bids = db
        .prepare(
          `
          SELECT b.bid_value, b.submitted_at, p.name, p.email, p.phone
          FROM bids b
          JOIN bidders p ON p.id = b.bidder_id
          WHERE b.asset_id = ?
          ORDER BY b.bid_value DESC, b.submitted_at ASC
          `
        )
        .all(asset.id);

      if (bids.length === 0) {
        reportLines.push(`- ${asset.auction_code} (${asset.name}): No bids`);
      } else {
        const top = bids[0];
        reportLines.push(
          `- ${asset.auction_code} (${asset.name}): ${bids.length} bids | Highest = ${top.bid_value} by ${top.name} <${top.email}>`
        );
      }
    }

    const subject = `Auction Closed Report: ${round.title}`;
    const body = reportLines.join("\n");
    for (const execEmail of EXEC_EMAILS) {
      sendEmail(execEmail, subject, body).catch((err) => {
        console.error("Failed to send closure report", execEmail, err.message);
      });
    }
  }
}

function approvalThresholdMet(roundId, assetId) {
  const count = db
    .prepare("SELECT COUNT(*) AS total FROM executive_approvals WHERE round_id = ? AND asset_id = ?")
    .get(roundId, assetId).total;
  return count >= 3;
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

function hasGoogleDriveConfig() {
  return Boolean(DRIVE_FOLDER_ID && DRIVE_CLIENT_EMAIL && DRIVE_PRIVATE_KEY);
}

async function uploadImageToGoogleDrive(file) {
  if (!hasGoogleDriveConfig()) {
    throw new Error("Google Drive is not configured. Set GDRIVE_FOLDER_ID, GDRIVE_CLIENT_EMAIL, and GDRIVE_PRIVATE_KEY.");
  }
  const auth = new google.auth.JWT({
    email: DRIVE_CLIENT_EMAIL,
    key: DRIVE_PRIVATE_KEY,
    scopes: ["https://www.googleapis.com/auth/drive.file"],
  });
  const drive = google.drive({ version: "v3", auth });
  const stream = Readable.from(file.buffer);

  const created = await drive.files.create({
    requestBody: {
      name: `${Date.now()}-${file.originalname}`,
      parents: [DRIVE_FOLDER_ID],
      mimeType: file.mimetype,
    },
    media: {
      mimeType: file.mimetype,
      body: stream,
    },
    fields: "id, webViewLink, webContentLink",
  });
  const fileId = created.data.id;
  if (!fileId) {
    throw new Error("Failed to upload image to Google Drive.");
  }
  await drive.permissions.create({
    fileId,
    requestBody: { role: "reader", type: "anyone" },
  });
  return `https://drive.google.com/uc?id=${fileId}`;
}

function localDateRangeToUtc(startDate, closeDate, tz) {
  const startUtc = dayjs.tz(`${startDate} 00:00:00`, tz).utc().toISOString();
  const endUtc = dayjs.tz(`${closeDate} 23:59:00`, tz).utc().toISOString();
  return { startUtc, endUtc };
}

function toLocal(iso, tz) {
  if (!iso) return "";
  const zone = tz || APP_TIMEZONE;
  return `${dayjs.utc(iso).tz(zone).format("YYYY-MM-DD HH:mm:ss")} (${zone})`;
}

function buildRoundSummary(roundId) {
  const round = db.prepare("SELECT * FROM auction_rounds WHERE id = ?").get(roundId);
  if (!round) return null;
  const assets = db.prepare("SELECT * FROM assets WHERE round_id = ? ORDER BY auction_code").all(roundId);
  const summary = assets.map((asset) => {
    const bids = db
      .prepare(
        `
        SELECT b.bid_value, b.submitted_at, p.name, p.email, p.phone
        FROM bids b
        JOIN bidders p ON p.id = b.bidder_id
        WHERE b.asset_id = ?
        ORDER BY b.bid_value DESC, b.submitted_at ASC
        `
      )
      .all(asset.id);
    return { asset, bids, highest: bids[0] || null };
  });
  return { round, summary };
}

function requireAdminAuth(req, res, next) {
  if (!req.session.admin) return res.redirect("/admin/login");
  return next();
}

async function notifyWinnerIfApproved(roundId, assetId) {
  const asset = getAssetWithRound(assetId);
  if (!asset) return;

  const winner = db
    .prepare(
      `
      SELECT b.bid_value, p.name, p.email
      FROM bids b
      JOIN bidders p ON p.id = b.bidder_id
      WHERE b.asset_id = ?
      ORDER BY b.bid_value DESC, b.submitted_at ASC
      LIMIT 1
      `
    )
    .get(assetId);

  if (!winner) return;
  if (!approvalThresholdMet(roundId, assetId)) return;

  const instructions = process.env.PAYMENT_INSTRUCTIONS || "Please complete payment by bank transfer.";
  const paymentDeadline = process.env.PAYMENT_DEADLINE_DAYS || "7";
  const collectionContact = process.env.COLLECTION_CONTACT || "assets@example.com";
  const body = [
    `Dear ${winner.name},`,
    "",
    `Congratulations. Your bid is the winning bid for asset ${asset.auction_code} (${asset.name}).`,
    `Winning amount: ${winner.bid_value}`,
    "",
    "Payment Instructions:",
    instructions,
    "",
    `Payment Deadline: ${paymentDeadline} day(s) from this email.`,
    `Asset Collection Contact: ${collectionContact}`,
    "",
    "Regards,",
    "Auction Portal Team",
  ].join("\n");

  await sendEmail(winner.email, `Winning Bid Confirmation - ${asset.auction_code}`, body);
}

migrate(db);
seedAdministrators();
if (!IS_VERCEL) {
  setInterval(closeExpiredRoundsAndNotify, 30 * 1000);
}
closeExpiredRoundsAndNotify();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "auction-session-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax" },
  })
);
app.use((req, res, next) => {
  res.locals.admin = req.session ? req.session.admin || null : null;
  res.setHeader("X-Auction-Portal", "1");
  next();
});

/** Confirms this Node process is the auction app (use if /admin/login 404s — wrong port or wrong server). */
app.get("/__auction/ping", (_req, res) => {
  res.type("json").send({ ok: true, app: "auction-portal", adminLoginPath: "/admin/login" });
});

/** Register admin login early so no other route can shadow it */
app.get("/admin/login", (_req, res) => {
  res.render("login", { error: null });
});

app.get("/login", (_req, res) => {
  res.redirect(302, "/admin/login");
});

app.get("/admin/login/", (_req, res) => {
  res.redirect(302, "/admin/login");
});

app.get("/", (_req, res) => {
  const assets = getActiveAssets();
  res.render("index", {
    assets,
    now: nowIso(),
    msg: null,
  });
});

app.get("/demo", (req, res) => {
  const round = db.prepare("SELECT id FROM auction_rounds WHERE title = ?").get(DEMO_ROUND_TITLE);
  const assets = round
    ? db
        .prepare("SELECT id, auction_code, name FROM assets WHERE round_id = ? ORDER BY auction_code")
        .all(round.id)
    : [];
  const msg = String(req.query.msg || "");
  res.render("demo", {
    demoMode: process.env.DEMO_MODE === "true",
    hasDemo: Boolean(round),
    assets,
    demoRoundTitle: DEMO_ROUND_TITLE,
    flash:
      msg === "ok"
        ? "Demo data loaded. Open an asset below and try placing a bid."
        : msg === "already"
          ? "Demo auction already exists. Use the links below to explore."
          : null,
  });
});

app.post("/demo/seed", (req, res) => {
  if (process.env.DEMO_MODE !== "true") {
    return res.status(403).send("Demo seeding is disabled. Set DEMO_MODE=true in your environment.");
  }
  try {
    const result = seedDemoAuction(db, { APP_TIMEZONE });
    if (result.alreadyExists) {
      return res.redirect("/demo?msg=already");
    }
    return res.redirect("/demo?msg=ok");
  } catch (err) {
    console.error(err);
    return res.status(500).send(`Demo seed failed: ${err.message}`);
  }
});

app.get("/asset/:id", (req, res) => {
  const asset = getAssetWithRound(Number(req.params.id));
  if (!asset) return res.status(404).send("Asset not found");

  const bids = db
    .prepare(
      `
      SELECT b.bid_value, b.submitted_at, p.name, p.email, p.phone
      FROM bids b
      JOIN bidders p ON p.id = b.bidder_id
      WHERE b.asset_id = ?
      ORDER BY b.bid_value DESC, b.submitted_at ASC
      `
    )
    .all(asset.id);
  const closed = asset.status !== "OPEN" || asset.end_at <= dayjs.utc().toISOString();
  asset.start_at_local = toLocal(asset.start_at, asset.timezone);
  asset.end_at_local = toLocal(asset.end_at, asset.timezone);

  res.render("asset", { asset, bids, closed, msg: null, error: null });
});

app.post("/bid", async (req, res) => {
  const parsed = bidSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).send(parsed.error.issues[0].message);
  }
  const data = parsed.data;
  const asset = getAssetWithRound(data.assetId);
  if (!asset) return res.status(404).send("Asset not found.");

  if (asset.status !== "OPEN" || asset.end_at <= dayjs.utc().toISOString()) {
    return res.status(400).send("Bidding window is closed for this asset.");
  }
  if (data.bidValue < asset.minimum_bid) {
    return res.status(400).send(`Bid must be >= minimum bid (${asset.minimum_bid}).`);
  }

  const insertBidTx = db.transaction(() => {
    let bidder = db.prepare("SELECT * FROM bidders WHERE email = ?").get(data.email);
    if (!bidder) {
      const id = db
        .prepare(
          "INSERT INTO bidders (name, email, phone, email_verified, phone_verified, created_at) VALUES (?, ?, ?, 0, 1, ?)"
        )
        .run(data.name, data.email, data.phone, nowIso()).lastInsertRowid;
      bidder = db.prepare("SELECT * FROM bidders WHERE id = ?").get(id);
    } else {
      db.prepare("UPDATE bidders SET name = ?, phone = ?, phone_verified = 1 WHERE id = ?").run(
        data.name,
        data.phone,
        bidder.id
      );
    }

    db.prepare("INSERT INTO bids (asset_id, bidder_id, bid_value, submitted_at) VALUES (?, ?, ?, ?)").run(
      asset.id,
      bidder.id,
      data.bidValue,
      nowIso()
    );

    const token = crypto.randomBytes(24).toString("hex");
    const expiresAt = dayjs().add(24, "hour").toISOString();
    db.prepare(
      "INSERT INTO email_verifications (bidder_id, token, expires_at, created_at) VALUES (?, ?, ?, ?)"
    ).run(bidder.id, token, expiresAt, nowIso());
    return { bidder, token };
  });

  try {
    const result = insertBidTx();
    const verifyUrl = `${req.protocol}://${req.get("host")}/verify-email?token=${result.token}`;
    await sendEmail(
      result.bidder.email,
      "Verify your auction bid email",
      `Click this link to verify your email address:\n${verifyUrl}\n\nThis link expires in 24 hours.`
    );
    return res.redirect(`/asset/${asset.id}?msg=Bid%20submitted.%20Please%20verify%20email.`);
  } catch (err) {
    if (String(err.message || "").includes("UNIQUE constraint failed: bids.asset_id, bids.bidder_id")) {
      return res.status(400).send("Duplicate bid rejected: one bid per email per item.");
    }
    console.error(err);
    return res.status(500).send("Failed to submit bid.");
  }
});

app.get("/verify-email", (req, res) => {
  const token = String(req.query.token || "");
  const row = db.prepare("SELECT * FROM email_verifications WHERE token = ?").get(token);
  if (!row) return res.status(400).render("verify-email", { title: "Email verification", status: "invalid" });
  if (row.used_at) return res.render("verify-email", { title: "Email verification", status: "already" });
  if (row.expires_at < nowIso()) {
    return res.status(400).render("verify-email", { title: "Email verification", status: "expired" });
  }

  db.prepare("UPDATE email_verifications SET used_at = ? WHERE id = ?").run(nowIso(), row.id);
  db.prepare("UPDATE bidders SET email_verified = 1 WHERE id = ?").run(row.bidder_id);
  return res.render("verify-email", { title: "Email verified", status: "success" });
});

app.post("/admin/login", (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!ADMIN_EMAILS.includes(email)) {
    return res.status(401).render("login", {
      error: "Access denied. This email is not authorized as an administrator.",
    });
  }
  const row = db.prepare("SELECT * FROM executives WHERE email = ?").get(email);
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).render("login", { error: "Invalid email or password." });
  }
  req.session.admin = { email: row.email };
  return res.redirect("/admin");
});

app.post("/admin/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/admin/login");
  });
});

app.get("/admin", requireAdminAuth, (req, res) => {
  const rounds = db.prepare("SELECT * FROM auction_rounds ORDER BY id DESC").all();
  const assets = db
    .prepare(
      `
      SELECT a.*, r.title AS round_title, r.status
      FROM assets a
      JOIN auction_rounds r ON r.id = a.round_id
      ORDER BY a.id DESC
      `
    )
    .all();
  const roundsWithLocal = rounds.map((round) => ({
    ...round,
    start_at_local: toLocal(round.start_at, round.timezone),
    end_at_local: toLocal(round.end_at, round.timezone),
  }));
  res.render("admin", { rounds: roundsWithLocal, assets, execEmails: EXEC_EMAILS, admin: req.session.admin });
});

app.post("/admin/round", requireAdminAuth, (req, res) => {
  const title = String(req.body.title || "").trim();
  const startDate = String(req.body.startDate || "").trim();
  const closeDate = String(req.body.closeDate || "").trim();
  const roundTz = String(req.body.timezone || APP_TIMEZONE).trim();
  if (!title || !startDate || !closeDate || !roundTz) return res.status(400).send("Missing round details.");
  if (closeDate < startDate) return res.status(400).send("Close date must be on/after start date.");
  const { startUtc, endUtc } = localDateRangeToUtc(startDate, closeDate, roundTz);

  db.prepare(
    "INSERT INTO auction_rounds (title, start_at, end_at, timezone, start_date_local, close_date_local, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?)"
  ).run(
    title,
    startUtc,
    endUtc,
    roundTz,
    startDate,
    closeDate,
    nowIso()
  );
  res.redirect("/admin");
});

app.post("/admin/assets/upload", requireAdminAuth, upload.single("assetsFile"), (req, res) => {
  const roundId = Number(req.body.roundId);
  const csvText = req.file ? req.file.buffer.toString("utf8") : "";
  const lines = csvText
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (!roundId || lines.length === 0) return res.status(400).send("Round and assets are required.");

  const insert = db.prepare(
    "INSERT INTO assets (round_id, auction_code, name, description, location, minimum_bid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  const tx = db.transaction(() => {
    const maybeHeader = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
    const hasHeader =
      maybeHeader.includes("auction_code") || maybeHeader.includes("code") || maybeHeader.includes("item_name");
    const dataLines = hasHeader ? lines.slice(1) : lines;
    for (const line of dataLines) {
      const parts = parseCsvLine(line);
      if (parts.length !== 5) {
        throw new Error("Each row must have 5 columns: auction_code,name,description,location,minimum_bid");
      }
      insert.run(roundId, parts[0], parts[1], parts[2], parts[3], Number(parts[4]), nowIso());
    }
  });

  try {
    tx();
    res.redirect("/admin");
  } catch (err) {
    res.status(400).send(`Asset upload failed: ${err.message}`);
  }
});

app.post("/admin/assets/:assetId/image", requireAdminAuth, upload.single("assetImage"), async (req, res) => {
  const assetId = Number(req.params.assetId);
  const asset = db.prepare("SELECT * FROM assets WHERE id = ?").get(assetId);
  if (!asset) return res.status(404).send("Asset not found.");
  if (!req.file) return res.status(400).send("No image file provided.");
  if (!String(req.file.mimetype || "").startsWith("image/")) {
    return res.status(400).send("Only image files are allowed.");
  }
  try {
    const imageUrl = await uploadImageToGoogleDrive(req.file);
    db.prepare("UPDATE assets SET image_url = ? WHERE id = ?").run(imageUrl, assetId);
    return res.redirect("/admin");
  } catch (err) {
    return res.status(400).send(`Image upload failed: ${err.message}`);
  }
});

app.post("/admin/approve", requireAdminAuth, async (req, res) => {
  const roundId = Number(req.body.roundId);
  const assetId = Number(req.body.assetId);
  const executiveEmail = String(req.session.admin.email || "").trim().toLowerCase();
  if (!APPROVER_EMAILS.includes(executiveEmail)) {
    return res.status(400).send("Your account is not authorized to record approvals for this workflow.");
  }
  try {
    db.prepare(
      "INSERT INTO executive_approvals (round_id, asset_id, executive_email, approved_at) VALUES (?, ?, ?, ?)"
    ).run(roundId, assetId, executiveEmail, nowIso());
    await notifyWinnerIfApproved(roundId, assetId);
    return res.redirect("/admin");
  } catch (err) {
    if (String(err.message || "").includes("UNIQUE constraint failed")) {
      return res.status(400).send("This executive has already approved this asset.");
    }
    return res.status(500).send("Approval failed.");
  }
});

app.get("/results/:roundId", requireAdminAuth, (req, res) => {
  const roundId = Number(req.params.roundId);
  const built = buildRoundSummary(roundId);
  if (!built) return res.status(404).send("Round not found");
  const { round, summary } = built;
  round.start_at_local = toLocal(round.start_at, round.timezone);
  round.end_at_local = toLocal(round.end_at, round.timezone);
  res.render("results", { round, summary, admin: req.session.admin });
});

app.get("/results/:roundId/export.xlsx", requireAdminAuth, async (req, res) => {
  const roundId = Number(req.params.roundId);
  const built = buildRoundSummary(roundId);
  if (!built) return res.status(404).send("Round not found");

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Bid Evaluation");
  sheet.columns = [
    { header: "Asset Code", key: "code", width: 14 },
    { header: "Asset Name", key: "assetName", width: 24 },
    { header: "Rank", key: "rank", width: 8 },
    { header: "Bidder Name", key: "name", width: 20 },
    { header: "Email", key: "email", width: 26 },
    { header: "Phone", key: "phone", width: 16 },
    { header: "Bid Value", key: "bid", width: 14 },
    { header: "Submitted At", key: "submitted", width: 22 },
  ];

  for (const group of built.summary) {
    if (group.bids.length === 0) {
      sheet.addRow({
        code: group.asset.auction_code,
        assetName: group.asset.name,
        rank: "-",
        name: "No bids",
      });
      continue;
    }
    group.bids.forEach((bid, idx) => {
      sheet.addRow({
        code: group.asset.auction_code,
        assetName: group.asset.name,
        rank: idx + 1,
        name: bid.name,
        email: bid.email,
        phone: bid.phone,
        bid: bid.bid_value,
        submitted: toLocal(bid.submitted_at, built.round.timezone),
      });
    });
  }

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="round-${roundId}-evaluation.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
});

app.get("/results/:roundId/export.pdf", requireAdminAuth, (req, res) => {
  const roundId = Number(req.params.roundId);
  const built = buildRoundSummary(roundId);
  if (!built) return res.status(404).send("Round not found");

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="round-${roundId}-evaluation.pdf"`);
  const doc = new PDFDocument({ margin: 40 });
  doc.pipe(res);

  doc.fontSize(16).text(`Bid Evaluation Report - ${built.round.title}`);
  doc.moveDown(0.5);
  doc.fontSize(10).text(`Timezone: ${built.round.timezone}`);
  doc.text(`Window: ${toLocal(built.round.start_at, built.round.timezone)} to ${toLocal(built.round.end_at, built.round.timezone)}`);
  doc.moveDown();

  for (const group of built.summary) {
    doc.fontSize(12).text(`${group.asset.auction_code} - ${group.asset.name}`, { underline: true });
    doc.fontSize(10).text(`Location: ${group.asset.location} | Minimum bid: ${group.asset.minimum_bid}`);
    if (!group.bids.length) {
      doc.text("No bids.");
      doc.moveDown();
      continue;
    }
    group.bids.forEach((bid, idx) => {
      doc.text(
        `${idx + 1}. ${bid.name} | ${bid.email} | ${bid.phone} | ${bid.bid_value} | ${toLocal(bid.submitted_at, built.round.timezone)}`
      );
    });
    doc.moveDown();
  }
  doc.end();
});

app.get("/health", (_req, res) => {
  res.type("json").send({
    ok: true,
    service: "auction-portal",
    routes: ["/", "/demo", "/login", "/admin/login", "/admin", "/__auction/ping"],
  });
});

// Static files last so they never shadow app routes like /demo or /admin/login
app.use(express.static(path.join(__dirname, "public")));

app.use((req, res) => {
  res.status(404).type("html").send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Not found</title></head>
<body style="font-family:system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;">
<h1>Page not found</h1>
<p>No route for <code>${req.path}</code>.</p>
<p>If you expected the auction app, make sure you:</p>
<ul>
<li>Run <code>npm start</code> or <code>npm run dev</code> from the <strong>auction-app</strong> project folder (same folder as <code>server.js</code>).</li>
<li>Open the URL shown in the terminal (default <a href="http://localhost:${PORT}/">http://localhost:${PORT}/</a>).</li>
<li>Use <a href="/demo">/demo</a>, <a href="/admin/login">/admin/login</a>, or <a href="/login">/login</a> on that same host and port.</li>
</ul>
<p><a href="/">← Home</a> · <a href="/health">/health</a> · <a href="/__auction/ping">/__auction/ping</a></p>
</body></html>`);
});

if (require.main === module) {
  app.listen(PORT, () => {
    const base = `http://localhost:${PORT}`;
    console.log(`Auction portal — ${base}`);
    console.log(`  Home          ${base}/`);
    console.log(`  Bidding demo  ${base}/demo`);
    console.log(`  Admin login     ${base}/admin/login  (alias: ${base}/login)`);
    console.log(`  Health check  ${base}/health`);
    console.log(`  Ping (verify app) ${base}/__auction/ping`);
  });
}

module.exports = app;
