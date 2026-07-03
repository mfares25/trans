import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(join(__dirname, '..', 'transfers.db'));

db.exec('PRAGMA journal_mode = WAL');

// Add Arabic columns if they don't exist yet (safe on existing DBs)
['player_ar','from_club_ar','to_club_ar','tweet_preview_ar',
 'photo_url','from_club_country','to_club_country','news_source'].forEach(col => {
  try { db.exec(`ALTER TABLE transfers ADD COLUMN ${col} TEXT`); } catch {}
});

db.exec(`
  CREATE TABLE IF NOT EXISTS comments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    transfer_id INTEGER NOT NULL,
    nickname    TEXT,
    body        TEXT NOT NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_comments_transfer ON comments(transfer_id);

  CREATE TABLE IF NOT EXISTS predictions (
    transfer_id INTEGER PRIMARY KEY,
    yes_count   INTEGER NOT NULL DEFAULT 0,
    no_count    INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS transfers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    player      TEXT NOT NULL,
    from_club   TEXT,
    to_club     TEXT,
    fee         TEXT,
    status      TEXT,
    confidence  REAL,
    tweet_ids   TEXT NOT NULL DEFAULT '[]',
    raw_tweets  TEXT NOT NULL DEFAULT '[]',
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_transfers_player ON transfers(player COLLATE NOCASE);

  CREATE TABLE IF NOT EXISTS metadata (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tweet_log (
    tweet_id      TEXT PRIMARY KEY,
    tweet_text    TEXT NOT NULL,
    processed_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    transfer_id   INTEGER,
    extracted     INTEGER NOT NULL DEFAULT 0
  );
`);

// ── metadata ──────────────────────────────────────────────────────────────────

export function getSinceId() {
  return db.prepare('SELECT value FROM metadata WHERE key = ?').get('since_id')?.value ?? null;
}

export function setSinceId(id) {
  db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run('since_id', id);
}

// ── transfer helpers ──────────────────────────────────────────────────────────

function normalize(s) {
  return (s ?? '').toLowerCase().trim();
}

// Remove common club prefixes/suffixes so "FC Bayern" matches "Bayern Munich"
function normalizeClub(s) {
  return normalize(s)
    .replace(/^(fc|ac|as|sc|ss|cf|rc|afc|fk|sk|rb)\s+/, '')
    .replace(/\s+(fc|cf|afc|sc|united|city|town|rovers)$/, '')
    .trim();
}

// True if one name contains the other as a substring — handles
// "Saibari" ↔ "Ismael Saibari", "Vušković" ↔ "Luka Vušković"
function nameMatches(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

// Null/undefined = unknown club → allow match; otherwise substring compare
function clubMatches(a, b) {
  if (!a || !b) return true;
  const na = normalizeClub(a);
  const nb = normalizeClub(b);
  return na === nb || na.includes(nb) || nb.includes(na);
}

function findMatchingTransfer(player, fromClub, toClub) {
  // Full scan is fine — transfer counts stay in the hundreds
  const rows = db.prepare('SELECT * FROM transfers ORDER BY updated_at DESC').all();

  return rows.find((r) => {
    if (!nameMatches(r.player, player)) return false;
    return clubMatches(r.from_club, fromClub) || clubMatches(r.to_club, toClub);
  }) ?? null;
}

export function upsertTransfer(data, tweetId, tweetText, source = null, pubDate = null) {
  const { player, from_club, to_club, fee, status, confidence } = data;
  let ts = null;
  if (pubDate) { try { const d = new Date(pubDate); if (!isNaN(d)) ts = d.toISOString().replace('T',' ').slice(0,19); } catch {} }
  const existing = findMatchingTransfer(player, from_club, to_club);

  if (existing) {
    const tweetIds  = JSON.parse(existing.tweet_ids);
    const rawTweets = JSON.parse(existing.raw_tweets);

    if (!tweetIds.includes(tweetId)) {
      tweetIds.push(tweetId);
      rawTweets.push(tweetText);
    }

    // Keep whichever player name is more complete (longer)
    const bestPlayer = normalize(player).length > normalize(existing.player).length
      ? player : existing.player;

    db.prepare(`
      UPDATE transfers
         SET player      = ?,
             from_club   = COALESCE(?, from_club),
             to_club     = COALESCE(?, to_club),
             fee         = COALESCE(?, fee),
             status      = ?,
             confidence  = ?,
             tweet_ids   = ?,
             raw_tweets  = ?,
             news_source = COALESCE(news_source, ?),
             updated_at  = COALESCE(?, CURRENT_TIMESTAMP)
       WHERE id = ?
    `).run(bestPlayer, from_club, to_club, fee, status, confidence,
           JSON.stringify(tweetIds), JSON.stringify(rawTweets), source, ts, existing.id);

    return { ...getTransferById(existing.id), _action: 'updated' };
  }

  const result = db.prepare(`
    INSERT INTO transfers (player, from_club, to_club, fee, status, confidence, tweet_ids, raw_tweets, news_source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?,CURRENT_TIMESTAMP), COALESCE(?,CURRENT_TIMESTAMP))
  `).run(player, from_club, to_club, fee, status, confidence,
         JSON.stringify([tweetId]), JSON.stringify([tweetText]), source, ts, ts);

  return { ...getTransferById(Number(result.lastInsertRowid)), _action: 'created' };
}

export function logTweet(tweetId, tweetText, transferId, extracted) {
  db.prepare(`
    INSERT OR IGNORE INTO tweet_log (tweet_id, tweet_text, transfer_id, extracted)
    VALUES (?, ?, ?, ?)
  `).run(tweetId, tweetText, transferId, extracted ? 1 : 0);
}

export function getAllTransfers({ player, club, status } = {}) {
  const conditions = [];
  const params     = [];

  if (player) {
    conditions.push('LOWER(t.player) LIKE ?');
    params.push(`%${player.toLowerCase()}%`);
  }
  if (club) {
    conditions.push('(LOWER(t.from_club) LIKE ? OR LOWER(t.to_club) LIKE ?)');
    params.push(`%${club.toLowerCase()}%`, `%${club.toLowerCase()}%`);
  }
  if (status) {
    conditions.push('t.status = ?');
    params.push(status);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return db.prepare(`
    SELECT t.*,
      COALESCE(p.yes_count,0) AS yes_count,
      COALESCE(p.no_count,0) AS no_count,
      COALESCE(c.comment_count,0) AS comment_count
    FROM transfers t
    LEFT JOIN predictions p ON t.id = p.transfer_id
    LEFT JOIN (SELECT transfer_id, COUNT(*) AS comment_count FROM comments GROUP BY transfer_id) c ON t.id = c.transfer_id
    ${where} ORDER BY t.updated_at DESC
  `).all(...params);
}

export function getTransferById(id) {
  return db.prepare(`
    SELECT t.*,
      COALESCE(p.yes_count,0) AS yes_count,
      COALESCE(p.no_count,0) AS no_count,
      COALESCE(c.comment_count,0) AS comment_count
    FROM transfers t
    LEFT JOIN predictions p ON t.id = p.transfer_id
    LEFT JOIN (SELECT transfer_id, COUNT(*) AS comment_count FROM comments GROUP BY transfer_id) c ON t.id = c.transfer_id
    WHERE t.id = ?
  `).get(id) ?? null;
}

export function updateFromClub(id, from_club, from_club_ar, from_club_country) {
  db.prepare(`
    UPDATE transfers
       SET from_club = COALESCE(?, from_club),
           from_club_ar = COALESCE(?, from_club_ar),
           from_club_country = COALESCE(?, from_club_country)
     WHERE id = ?
  `).run(from_club, from_club_ar, from_club_country, id);
}

export function getUntranslated() {
  return db.prepare(
    'SELECT * FROM transfers WHERE player_ar IS NULL OR from_club_country IS NULL'
  ).all();
}

export function saveTranslation(id, data) {
  const { player_ar, from_club_ar, to_club_ar, tweet_preview_ar,
          photo_url, from_club_country, to_club_country } = data;
  db.prepare(`
    UPDATE transfers
       SET player_ar = ?, from_club_ar = ?, to_club_ar = ?,
           tweet_preview_ar = ?, photo_url = ?,
           from_club_country = ?, to_club_country = ?
     WHERE id = ?
  `).run(player_ar, from_club_ar, to_club_ar, tweet_preview_ar,
         photo_url, from_club_country, to_club_country, id);
}

export function getComments(transferId) {
  return db.prepare(
    'SELECT * FROM comments WHERE transfer_id = ? ORDER BY created_at ASC'
  ).all(transferId);
}

export function addComment(transferId, nickname, body) {
  const nick = (nickname || '').trim().slice(0, 30) || null;
  const text = body.trim().slice(0, 280);
  const r = db.prepare(
    'INSERT INTO comments (transfer_id, nickname, body) VALUES (?, ?, ?)'
  ).run(transferId, nick, text);
  return db.prepare('SELECT * FROM comments WHERE id = ?').get(r.lastInsertRowid);
}

export function getCommentCount(transferId) {
  return db.prepare('SELECT COUNT(*) AS n FROM comments WHERE transfer_id = ?').get(transferId).n;
}

export function castVote(transferId, choice) {
  const existing = db.prepare('SELECT * FROM predictions WHERE transfer_id = ?').get(transferId);
  if (existing) {
    const col = choice === 'yes' ? 'yes_count' : 'no_count';
    db.prepare(`UPDATE predictions SET ${col} = ${col} + 1 WHERE transfer_id = ?`).run(transferId);
  } else {
    db.prepare('INSERT INTO predictions (transfer_id, yes_count, no_count) VALUES (?, ?, ?)').run(
      transferId, choice === 'yes' ? 1 : 0, choice === 'no' ? 1 : 0
    );
  }
  return db.prepare('SELECT * FROM predictions WHERE transfer_id = ?').get(transferId);
}

export function getRecentTweets(limit = 50) {
  return db.prepare(
    'SELECT * FROM tweet_log ORDER BY processed_at DESC LIMIT ?'
  ).all(limit);
}

export function getStats() {
  return {
    total:     db.prepare('SELECT COUNT(*) AS n FROM transfers').get().n,
    confirmed: db.prepare("SELECT COUNT(*) AS n FROM transfers WHERE status = 'confirmed'").get().n,
    tweets:    db.prepare('SELECT COUNT(*) AS n FROM tweet_log').get().n,
    extracted: db.prepare('SELECT COUNT(*) AS n FROM tweet_log WHERE extracted = 1').get().n,
    since_id:  getSinceId(),
  };
}

export default db;
