# Reusable Online Auction Portal

This project is a full-stack auction portal for electronic bidding of listed assets within a defined bid window.

## Features

- Displays asset details: auction code, name, description, location, and minimum bid.
- Bidder flow:
  - Select an asset.
  - Submit one bid value with name, email, and phone number.
  - Duplicate bids are blocked per asset per email.
  - Same email can bid on different assets.
- Automatic timestamping for each bid.
- Verification:
  - Email verification link is sent after bid submission.
  - Phone number format validation is enforced.
- Bid ranking:
  - Per-asset ranking from highest to lowest.
  - Bid log is retained.
  - Submissions are locked after closing time.
- Automatic closure handling:
  - At closure, rounds are automatically marked closed.
  - Summary report is generated and sent to the designated executives.
- Post-approval workflow:
  - Executives approve per asset.
  - When all three have approved, the highest bidder receives winner notification with payment and collection details.
- Reusability:
  - Admin can create new auction rounds.
  - Admin can upload new assets for each round.
- Executive login/auth for protected admin and results routes.
- CSV asset upload via file input (instead of textarea).
- Timezone-safe closure policy at exactly 11:59 PM local close date.
- Report export to PDF and Excel.
- Admin asset image upload to Google Drive and display on portal cards.
- **Bidding demo:** sample round, lots, and pre-seeded bids for walkthroughs (`/demo` or `npm run demo:seed`).

## Tech Stack

- Node.js + Express
- SQLite (`better-sqlite3`)
- EJS templates for frontend
- Nodemailer for emails

## Setup

1. Install dependencies:
   - `npm install`
2. Copy environment variables:
   - `cp .env.example .env`
3. Start the app:
   - `npm run dev`
4. Open the URL printed in the terminal (default port **3000**, or set `PORT` in `.env`):
   - Home: `http://localhost:3000/`
   - Demo: `http://localhost:3000/demo`
   - Executive login: `http://localhost:3000/admin/login`
5. Sanity check: open `http://localhost:3000/__auction/ping` — you should see JSON like `{"ok":true,"app":"auction-portal",...}`. If you get **Cannot GET** here, port 3000 is **not** running this app (stop other servers, then `npm run dev` again and use the printed port).

### “Cannot GET /demo” or “Cannot GET /admin/login”

That response means the **Express app from this repo is not handling the request**. Typical causes:

- The dev server is not running, or you are using the **wrong port** (another tool may be on 3000). Use the port from the terminal line `Auction portal — http://localhost:…`.
- You started a **different** project or a static file server instead of `npm run dev` / `npm start` from the **auction-app** folder (the one that contains `server.js`).
- After `git pull` or copying files, restart Node so it loads the latest `server.js`.

## Bidding demo

1. **CLI (always available):** from the project root run `npm run demo:seed`. This creates the **Demo Bidding Sandbox** round with two lots and example bids (if it does not already exist).
2. **Web:** open [http://localhost:3000/demo](http://localhost:3000/demo). To enable the **Load demo data** button, set `DEMO_MODE=true` in `.env` and restart the server.
3. Open a demo asset from that page, inspect the bid ranking, then place a bid using a **new** email (sample demo emails are already used on those items).

## Admin Usage

- Go to `/admin/login` or `/login` (redirects to the same page) — **only** emails listed in `ADMIN_EMAILS` (defaults to `EXEC_EMAILS`) with a matching row in the `executives` table can sign in. Public **bidder** accounts cannot access admin routes.
- **Approvals:** any signed-in administrator whose email appears in **either** `EXEC_EMAILS` or `ADMIN_EMAILS` can record an approval (union of both lists).
- Default administrator password is from `EXEC_DEFAULT_PASSWORD` for seeded admin emails.
- Create a round using local `start date`, `close date`, and `timezone`.
- Upload assets via CSV file with this column order:
  - `auction_code,name,description,location,minimum_bid`
- Upload image per asset in the "Asset Images (Google Drive)" section.
- After closure, open `/results/:roundId` for bid evaluation summary.
- Record executive approvals for each asset.
- Use export links on results page to download PDF/Excel.

## Notes

- If SMTP settings are not configured, emails are logged to server console.
- Closure checks run every 30 seconds and auto-close expired rounds.
- Round close is computed as local `23:59:00` in each round's timezone.
- On Vercel, SQLite runs from `/tmp/auction.db` (ephemeral per instance). Data can reset between deployments/cold starts; use a persistent DB for production.

## Google Drive Setup (Asset Images)

1. Create a Google Cloud service account and enable Google Drive API.
2. Share your target Google Drive folder with the service account email.
3. Set these env vars:
   - `GDRIVE_FOLDER_ID`
   - `GDRIVE_CLIENT_EMAIL`
   - `GDRIVE_PRIVATE_KEY` (replace newlines with `\n` if using `.env`)
