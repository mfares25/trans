import { Router } from 'express';
import { getAllTransfers, getTransferById, getRecentTweets, getStats, castVote, getComments, addComment,
         getClubBySlug, getPlayerBySlug, getClubTransfers, getPlayerTransfers, listClubs, listPlayers } from './db.js';

export const router = Router();

// ── SSE broadcast ─────────────────────────────────────────────────────────────

const sseClients = new Set();

export function broadcast(event, payload) {
  if (!sseClients.size) return;
  const line = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) res.write(line);
}

// ── REST endpoints ────────────────────────────────────────────────────────────

router.get('/transfers', (req, res) => {
  const { player, club, status } = req.query;
  const transfers = getAllTransfers({ player, club, status });
  res.json({ count: transfers.length, transfers });
});

router.get('/transfers/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be an integer' });

  const transfer = getTransferById(id);
  if (!transfer) return res.status(404).json({ error: 'Not found' });

  res.json(transfer);
});

router.post('/transfers/:id/vote', (req, res) => {
  const id     = Number(req.params.id);
  const choice = req.body?.choice;
  if (!['yes', 'no'].includes(choice)) return res.status(400).json({ error: 'choice must be yes or no' });
  if (!getTransferById(id)) return res.status(404).json({ error: 'Not found' });
  res.json(castVote(id, choice));
});

router.get('/transfers/:id/comments', (req, res) => {
  const id = Number(req.params.id);
  if (!getTransferById(id)) return res.status(404).json({ error: 'Not found' });
  res.json(getComments(id));
});

router.post('/transfers/:id/comments', (req, res) => {
  const id   = Number(req.params.id);
  const { nickname, body } = req.body || {};
  if (!body?.trim()) return res.status(400).json({ error: 'body required' });
  if (!getTransferById(id)) return res.status(404).json({ error: 'Not found' });
  const comment = addComment(id, nickname, body);
  broadcast('comment', { transfer_id: id, comment });
  res.status(201).json(comment);
});

// ── Club / player entity pages ────────────────────────────────────────────────

router.get('/clubs', (_req, res) => {
  res.json(listClubs());
});

router.get('/clubs/:slug', (req, res) => {
  const club = getClubBySlug(req.params.slug);
  if (!club) return res.status(404).json({ error: 'Not found' });

  const transfers = getClubTransfers(req.params.slug);
  const incoming   = transfers.filter(t => t.to_club_slug === req.params.slug);
  const outgoing   = transfers.filter(t => t.from_club_slug === req.params.slug);

  res.json({
    club,
    transfers,
    stats: { total: transfers.length, incoming: incoming.length, outgoing: outgoing.length },
  });
});

router.get('/players', (_req, res) => {
  res.json(listPlayers());
});

router.get('/players/:slug', (req, res) => {
  const player = getPlayerBySlug(req.params.slug);
  if (!player) return res.status(404).json({ error: 'Not found' });

  const transfers = getPlayerTransfers(req.params.slug);

  res.json({ player, transfers, stats: { total: transfers.length } });
});

router.get('/tweets', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json(getRecentTweets(limit));
});

router.get('/stats', (_req, res) => {
  res.json(getStats());
});

// ── Live SSE feed ─────────────────────────────────────────────────────────────

router.get('/feed', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if applicable
  res.flushHeaders();

  // Send snapshot of all current transfers so the client has a full picture immediately
  const snapshot = getAllTransfers();
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);

  sseClients.add(res);

  // Heartbeat keeps the connection alive through proxies
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});
