# TransferWatch — CLAUDE.md

## Project Overview

A bilingual (Arabic/English) football transfer tracking system that collects transfer news from multiple RSS sources, processes it with Claude AI, and displays it in a modern real-time web interface.

---

## Tech Stack

- **Runtime:** Node.js v24+ with `node:sqlite` (built-in, no ORM)
- **Backend:** Express.js
- **Frontend:** Vanilla JS + CSS (single HTML file at `public/index.html`)
- **Database:** SQLite (`transfers.db`)
- **AI:** Claude API (`claude-haiku-4-5-20251001`) — extraction + translation
- **Scheduler:** `node-cron` — hourly polls
- **RSS:** `rss-parser`

---

## Data Sources

| Source | Type | Items/poll |
|---|---|---|
| Fabrizio Romano | Nitter RSS (nitter.net) | ~18 |
| Sky Sports | RSS | ~20 |
| BBC Sport | RSS | ~87 |
| 90min | RSS | ~90 |

Total: ~215 items per poll cycle. News items use their URL as ID; dedup via `INSERT OR IGNORE` in `tweet_log`.

---

## Key Files

```
src/
  index.js      — Express server, startup
  cron.js       — Hourly poll logic, calls translatePending() after each poll
  twitter.js    — Nitter + RSS fetching
  claude.js     — extractTransferData() via Claude API
  translate.js  — translatePending(), resolveFromClub(), Wikipedia photo fetch
  db.js         — All DB operations
  api.js        — REST endpoints + SSE feed

public/
  index.html    — Entire frontend (CSS + HTML + JS in one file)

transfers.db    — SQLite database
.env            — API keys and config
```

---

## Database Schema

### `transfers`
| Column | Notes |
|---|---|
| `id` | Primary key |
| `player` | English name |
| `player_ar` | Arabic name (Claude) |
| `player_country` | Lowercase English (e.g. `italy`, `england`) |
| `from_club` / `to_club` | English |
| `from_club_ar` / `to_club_ar` | Arabic (Claude) |
| `from_club_country` / `to_club_country` | Lowercase English |
| `fee`, `status`, `confidence` | Transfer details |
| `tweet_ids` / `raw_tweets` | JSON arrays |
| `tweet_preview_ar` | Arabic summary (manually reviewed for naturalness) |
| `photo_url` | Wikipedia player photo |
| `news_source` | e.g. "Sky Sports", "BBC Sport", "Fabrizio Romano" |
| `created_at` / `updated_at` | From RSS pubDate (not processing time) |

### `predictions`
Yes/No votes per transfer.

### `comments`
User comments per transfer: `nickname`, `body`, `created_at`.

### `tweet_log`
Dedup log. Tweet snowflake IDs and news article URLs both stored here.

### `metadata`
`since_id` — last Twitter snowflake ID seen (for Nitter pagination).

---

## Environment Variables (`.env`)

```
TWITTER_BEARER_TOKEN=...
ANTHROPIC_API_KEY=...
FABRIZIO_ROMANO_USER_ID=   # leave empty, resolved at runtime
PORT=3000
POLL_DISABLED=true|false   # set true to stop API usage
```

**`POLL_DISABLED=true`** stops both hourly cron AND startup `translatePending()` — zero Anthropic API calls.

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/transfers` | All transfers with vote + comment counts |
| GET | `/api/transfers/:id` | Single transfer |
| POST | `/api/transfers/:id/vote` | `{ choice: "yes"/"no" }` |
| GET | `/api/transfers/:id/comments` | All comments for transfer |
| POST | `/api/transfers/:id/comments` | `{ nickname?, body }` |
| GET | `/api/stats` | Total, confirmed, source counts |
| GET | `/api/feed` | SSE stream — events: `snapshot`, `transfer`, `comment` |

---

## Frontend Features

### Cards
- Player photo (Wikipedia) with nationality flag badge (bottom-right of photo)
- Arabic/English name and club names
- Country flags for both clubs (emoji from `COUNTRY_FLAG` map)
- Status badge (confirmed, agreement, talks, interest, etc.)
- Type badge (permanent, loan, free, rumour)
- Confidence bar
- Publication timestamp from RSS (not processing time)
- Source tag (news outlet name)

### Card Flip
Click card → fade transition → back face shows all source links with timestamps.
- Twitter snowflake IDs → `x.com/FabrizioRomano/status/:id`
- News URLs → original article link

### Prediction (هل سيحدث؟)
Yes/No vote buttons with live percentage bar. Hidden for confirmed/agreement transfers.

### Comments
Bottom sheet modal with:
- Colored avatar (initials, deterministic color from name)
- Anonymous = "مشجع" / "Fan"
- Enter to submit, Shift+Enter for newline, Escape to close

### Share (🔗)
Pure Canvas drawing (no html2canvas) — supports Arabic RTL correctly.
Layout: brand logo → player photo + name + nationality flag → transfer box (from ← to).
Mobile: Web Share API with image file. Desktop: auto-download PNG.

### Filters & Search
- Tabs: All / Confirmed / Rumours / Loans
- Status filter dropdown
- Sort: Latest / Confidence / Most Voted
- Text search (player or club)

### i18n
Full Arabic/English with RTL/LTR switching. All dynamic content uses `t()` / `tf()` helpers. Cards re-render on language switch. Time displays use `ar-SA` locale in Arabic mode.

### Theme
Dark/light toggle, saved to `localStorage`.

---

## Translation Pipeline

When `POLL_DISABLED=false`, after each poll:
1. `getUntranslated()` — finds transfers missing `player_ar` or `from_club_country`
2. If `from_club` is null → `resolveFromClub()` via Wikipedia + Claude (passes `to_club` to avoid wrong answer)
3. `fetchWikipediaPhoto()` — Wikipedia pageimages API with proper User-Agent
4. Claude call: translates player name, clubs, summary to Arabic; extracts country names
5. `saveTranslation()` — stores all fields

Arabic summaries have been manually rewritten for natural Arabic style (not literal translations).

---

## Known Behaviours

- **Nitter**: Only `nitter.net` reliably works. No pagination (cursor= returns 404). `since_id` only updated from numeric snowflake IDs.
- **Timestamp**: Uses RSS `pubDate` for `created_at`/`updated_at`. Invalid dates fall back to `CURRENT_TIMESTAMP`.
- **Club matching**: Fuzzy — strips FC/AC prefixes, uses substring matching. `from_club=null` matches anything (avoids false duplicates).
- **Wikipedia 403**: Fixed by setting `User-Agent: TransferWatch/1.0`.
- **No-cache**: Static files served with `Cache-Control: no-store`.
