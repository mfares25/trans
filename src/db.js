import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(join(__dirname, '..', 'transfers.db'));

db.exec('PRAGMA journal_mode = WAL');

// Add Arabic columns if they don't exist yet (safe on existing DBs)
['player_ar','from_club_ar','to_club_ar','tweet_preview_ar',
 'photo_url','from_club_country','to_club_country','news_source','player_country',
 'player_slug','from_club_slug','to_club_slug'].forEach(col => {
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

  CREATE TABLE IF NOT EXISTS clubs (
    slug        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    name_ar     TEXT,
    country     TEXT,
    logo_url    TEXT,
    description TEXT,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS players (
    slug        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    name_ar     TEXT,
    country     TEXT,
    photo_url   TEXT,
    description TEXT,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
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

// ── club/player entity helpers ────────────────────────────────────────────────

function slugify(s) {
  return (s ?? '')
    .toString()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function uniqueSlug(table, base) {
  if (!base) return null;
  let slug = base, i = 2;
  while (db.prepare(`SELECT 1 FROM ${table} WHERE slug = ?`).get(slug)) {
    slug = `${base}-${i++}`;
  }
  return slug;
}

function findClubSlug(name) {
  if (!name) return null;
  const target = normalizeClub(name);
  if (!target) return null;
  const hit = db.prepare('SELECT slug, name FROM clubs').all().find((r) => {
    const n = normalizeClub(r.name);
    return n === target || n.includes(target) || target.includes(n);
  });
  return hit?.slug ?? null;
}

function findPlayerSlug(name) {
  if (!name) return null;
  const target = normalize(name);
  if (!target) return null;
  const hit = db.prepare('SELECT slug, name FROM players').all().find((r) => {
    const n = normalize(r.name);
    return n === target || n.includes(target) || target.includes(n);
  });
  return hit?.slug ?? null;
}

// Creates the club on first sighting, or enriches/merges into the existing
// entity on subsequent sightings. Returns the slug (or null if no name given).
export function upsertClubEntity({ name, name_ar, country, logo_url, description } = {}) {
  if (!name) return null;
  let slug = findClubSlug(name);
  if (!slug) {
    slug = uniqueSlug('clubs', slugify(name));
    if (!slug) return null;
    db.prepare(`
      INSERT INTO clubs (slug, name, name_ar, country, logo_url, description)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(slug, name, name_ar ?? null, country ?? null, logo_url ?? null, description ?? null);
    return slug;
  }
  db.prepare(`
    UPDATE clubs SET
      name        = CASE WHEN length(?) > length(name) THEN ? ELSE name END,
      name_ar     = COALESCE(name_ar, ?),
      country     = COALESCE(country, ?),
      logo_url    = COALESCE(logo_url, ?),
      description = COALESCE(description, ?),
      updated_at  = CURRENT_TIMESTAMP
    WHERE slug = ?
  `).run(name, name, name_ar ?? null, country ?? null, logo_url ?? null, description ?? null, slug);
  return slug;
}

export function upsertPlayerEntity({ name, name_ar, country, photo_url, description } = {}) {
  if (!name) return null;
  let slug = findPlayerSlug(name);
  if (!slug) {
    slug = uniqueSlug('players', slugify(name));
    if (!slug) return null;
    db.prepare(`
      INSERT INTO players (slug, name, name_ar, country, photo_url, description)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(slug, name, name_ar ?? null, country ?? null, photo_url ?? null, description ?? null);
    return slug;
  }
  db.prepare(`
    UPDATE players SET
      name        = CASE WHEN length(?) > length(name) THEN ? ELSE name END,
      name_ar     = COALESCE(name_ar, ?),
      country     = COALESCE(country, ?),
      photo_url   = COALESCE(photo_url, ?),
      description = COALESCE(description, ?),
      updated_at  = CURRENT_TIMESTAMP
    WHERE slug = ?
  `).run(name, name, name_ar ?? null, country ?? null, photo_url ?? null, description ?? null, slug);
  return slug;
}

export function getClubBySlug(slug) {
  return db.prepare('SELECT * FROM clubs WHERE slug = ?').get(slug) ?? null;
}

export function getPlayerBySlug(slug) {
  return db.prepare('SELECT * FROM players WHERE slug = ?').get(slug) ?? null;
}

export function listClubs() {
  return db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM transfers WHERE from_club_slug = c.slug OR to_club_slug = c.slug) AS transfer_count
    FROM clubs c ORDER BY name COLLATE NOCASE
  `).all();
}

export function listPlayers() {
  return db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM transfers WHERE player_slug = p.slug) AS transfer_count
    FROM players p ORDER BY name COLLATE NOCASE
  `).all();
}

const TRANSFER_SELECT = `
  SELECT t.*,
    COALESCE(pr.yes_count,0) AS yes_count,
    COALESCE(pr.no_count,0) AS no_count,
    COALESCE(cm.comment_count,0) AS comment_count
  FROM transfers t
  LEFT JOIN predictions pr ON t.id = pr.transfer_id
  LEFT JOIN (SELECT transfer_id, COUNT(*) AS comment_count FROM comments GROUP BY transfer_id) cm ON t.id = cm.transfer_id
`;

export function getClubTransfers(slug) {
  return db.prepare(`${TRANSFER_SELECT} WHERE t.from_club_slug = ? OR t.to_club_slug = ? ORDER BY t.updated_at DESC`)
    .all(slug, slug);
}

export function getPlayerTransfers(slug) {
  return db.prepare(`${TRANSFER_SELECT} WHERE t.player_slug = ? ORDER BY t.updated_at DESC`)
    .all(slug);
}

export function getPlayersMissingDescription(limit = 12) {
  return db.prepare('SELECT slug, name FROM players WHERE description IS NULL LIMIT ?').all(limit);
}

export function getClubsMissingDescription(limit = 12) {
  return db.prepare('SELECT slug, name FROM clubs WHERE description IS NULL LIMIT ?').all(limit);
}

// One-time (idempotent) backfill: populates clubs/players tables and the
// transfers.*_slug columns for rows that predate the entities feature.
export function backfillEntitySlugs() {
  const rows = db.prepare(`
    SELECT * FROM transfers
    WHERE player_slug IS NULL
       OR (from_club IS NOT NULL AND from_club_slug IS NULL)
       OR (to_club   IS NOT NULL AND to_club_slug   IS NULL)
  `).all();

  for (const r of rows) {
    const playerSlug = upsertPlayerEntity({ name: r.player, name_ar: r.player_ar, country: r.player_country, photo_url: r.photo_url });
    const fromSlug   = r.from_club ? upsertClubEntity({ name: r.from_club, name_ar: r.from_club_ar, country: r.from_club_country }) : null;
    const toSlug     = r.to_club   ? upsertClubEntity({ name: r.to_club,   name_ar: r.to_club_ar,   country: r.to_club_country })   : null;

    db.prepare(`
      UPDATE transfers
         SET player_slug = COALESCE(?, player_slug),
             from_club_slug = COALESCE(?, from_club_slug),
             to_club_slug = COALESCE(?, to_club_slug)
       WHERE id = ?
    `).run(playerSlug, fromSlug, toSlug, r.id);
  }
  return rows.length;
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

    const playerSlug = upsertPlayerEntity({ name: bestPlayer });
    const fromSlug    = from_club ? upsertClubEntity({ name: from_club }) : existing.from_club_slug;
    const toSlug      = to_club   ? upsertClubEntity({ name: to_club })   : existing.to_club_slug;

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
             updated_at  = COALESCE(?, CURRENT_TIMESTAMP),
             player_slug = ?,
             from_club_slug = COALESCE(?, from_club_slug),
             to_club_slug = COALESCE(?, to_club_slug)
       WHERE id = ?
    `).run(bestPlayer, from_club, to_club, fee, status, confidence,
           JSON.stringify(tweetIds), JSON.stringify(rawTweets), source, ts,
           playerSlug, fromSlug, toSlug, existing.id);

    return { ...getTransferById(existing.id), _action: 'updated' };
  }

  const playerSlug = upsertPlayerEntity({ name: player });
  const fromSlug    = from_club ? upsertClubEntity({ name: from_club }) : null;
  const toSlug      = to_club   ? upsertClubEntity({ name: to_club })   : null;

  const result = db.prepare(`
    INSERT INTO transfers (player, from_club, to_club, fee, status, confidence, tweet_ids, raw_tweets, news_source, created_at, updated_at, player_slug, from_club_slug, to_club_slug)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?,CURRENT_TIMESTAMP), COALESCE(?,CURRENT_TIMESTAMP), ?, ?, ?)
  `).run(player, from_club, to_club, fee, status, confidence,
         JSON.stringify([tweetId]), JSON.stringify([tweetText]), source, ts, ts,
         playerSlug, fromSlug, toSlug);

  return { ...getTransferById(Number(result.lastInsertRowid)), _action: 'created' };
}

export function isTweetLogged(tweetId) {
  return !!db.prepare('SELECT 1 FROM tweet_log WHERE tweet_id = ?').get(tweetId);
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
  const slug = from_club ? upsertClubEntity({ name: from_club, name_ar: from_club_ar, country: from_club_country }) : null;
  db.prepare(`
    UPDATE transfers
       SET from_club = COALESCE(?, from_club),
           from_club_ar = COALESCE(?, from_club_ar),
           from_club_country = COALESCE(?, from_club_country),
           from_club_slug = COALESCE(?, from_club_slug)
     WHERE id = ?
  `).run(from_club, from_club_ar, from_club_country, slug, id);
}

export function getUntranslated() {
  return db.prepare(
    'SELECT * FROM transfers WHERE player_ar IS NULL OR from_club_country IS NULL'
  ).all();
}

export function saveTranslation(id, data) {
  const { player_ar, from_club_ar, to_club_ar, tweet_preview_ar,
          photo_url, from_club_country, to_club_country, player_country } = data;

  const tr = getTransferById(id);
  if (tr) {
    if (tr.player)    upsertPlayerEntity({ name: tr.player, name_ar: player_ar, country: player_country, photo_url });
    if (tr.from_club) upsertClubEntity({ name: tr.from_club, name_ar: from_club_ar, country: from_club_country });
    if (tr.to_club)   upsertClubEntity({ name: tr.to_club, name_ar: to_club_ar, country: to_club_country });
  }

  db.prepare(`
    UPDATE transfers
       SET player_ar = ?, from_club_ar = ?, to_club_ar = ?,
           tweet_preview_ar = ?, photo_url = ?,
           from_club_country = ?, to_club_country = ?, player_country = ?
     WHERE id = ?
  `).run(player_ar, from_club_ar, to_club_ar, tweet_preview_ar,
         photo_url, from_club_country, to_club_country, player_country, id);
}

export function getMissingPlayerCountry() {
  return db.prepare(
    'SELECT id, player FROM transfers WHERE player_country IS NULL'
  ).all();
}

export function updatePlayerCountry(id, country) {
  db.prepare('UPDATE transfers SET player_country = ? WHERE id = ?').run(country, id);
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
