import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { resolveUserId } from './twitter.js';
import { router as apiRouter } from './api.js';
import { setUserId, startCron } from './cron.js';
import { translatePending } from './translate.js';
import { logUpdate } from './updateLog.js';

// ── env validation ────────────────────────────────────────────────────────────

const missing = ['TWITTER_BEARER_TOKEN'].filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  console.error('Copy .env.example → .env and fill in your keys.');
  process.exit(1);
}

// ── resolve user ID ───────────────────────────────────────────────────────────

async function resolveRomanoId() {
  if (process.env.FABRIZIO_ROMANO_USER_ID) {
    console.log(`[setup] Using FABRIZIO_ROMANO_USER_ID=${process.env.FABRIZIO_ROMANO_USER_ID}`);
    return process.env.FABRIZIO_ROMANO_USER_ID;
  }

  console.log('[setup] Resolving @FabrizioRomano user ID from Twitter…');
  const user = await resolveUserId('FabrizioRomano');
  console.log(`[setup] Resolved: ${user.name} → id=${user.id}`);
  return user.id;
}

// ── HTTP server ───────────────────────────────────────────────────────────────

async function main() {
  const userId = await resolveRomanoId();
  setUserId(userId);

  const app  = express();
  const PORT = process.env.PORT ?? 3000;
  const __dirname = dirname(fileURLToPath(import.meta.url));

  app.use(express.json());
  app.use(express.static(join(__dirname, '..', 'public'), { etag: false, lastModified: false, setHeaders: (res) => res.setHeader('Cache-Control','no-store') }));
  app.use('/api', apiRouter);

  app.get('/health', (_req, res) =>
    res.json({ status: 'ok', time: new Date().toISOString() })
  );

  app.listen(PORT, async () => {
    console.log(`[http] Listening on http://localhost:${PORT}`);
    startCron();
    if (process.env.POLL_DISABLED !== 'true') {
      const translatedCount = await translatePending();
      logUpdate(0, translatedCount);
    }
  });
}

main().catch((err) => {
  console.error('[fatal]', err.message);
  process.exit(1);
});
