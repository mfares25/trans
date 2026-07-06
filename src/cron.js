import cron from 'node-cron';
import { fetchNewTweets } from './twitter.js';
import { extractTransferData } from './claude.js';
import { getSinceId, setSinceId, upsertTransfer, logTweet, isTweetLogged } from './db.js';
import { broadcast } from './api.js';
import { translatePending, backfillPlayerCountries, backfillEntityDescriptions } from './translate.js';
import { logUpdate } from './updateLog.js';

let userId = null;
let pollInProgress = false;

export function setUserId(id) {
  userId = id;
}

export async function pollOnce() {
  if (!userId) throw new Error('User ID not set — call setUserId() first');

  if (pollInProgress) {
    console.log('[poll] Previous poll still running — skipping this cycle');
    return;
  }
  pollInProgress = true;
  try {
    await pollOnceInner();
  } finally {
    pollInProgress = false;
  }
}

async function pollOnceInner() {
  console.log(`[poll] ${new Date().toISOString()} — fetching tweets for user ${userId}`);

  const sinceId = getSinceId();
  let tweets;

  try {
    tweets = await fetchNewTweets(userId, sinceId);
  } catch (err) {
    if (err.response?.status === 429) {
      console.warn('[poll] Rate limited by Twitter API — skipping this cycle');
    } else {
      console.error('[poll] Twitter error:', err.message);
    }
    return;
  }

  if (!tweets.length) {
    console.log('[poll] No new tweets.');
    return;
  }

  console.log(`[poll] ${tweets.length} new item(s) to process.`);

  // Update since_id only from Twitter snowflake IDs (numeric), not news URLs
  const twitterItems = tweets.filter(t => /^\d+$/.test(t.id));
  if (twitterItems.length) setSinceId(twitterItems.at(-1).id);

  let addedCount = 0;

  for (const tweet of tweets) {
    if (isTweetLogged(tweet.id)) continue;

    const preview = tweet.text.slice(0, 60).replace(/\n/g, ' ');
    console.log(`[poll]   tweet ${tweet.id}: "${preview}…"`);

    let extracted = null;
    try {
      extracted = await extractTransferData(tweet.text);
    } catch (err) {
      console.error(`[poll]   Claude error: ${err.message}`);
    }

    if (!extracted || extracted.status === 'not_transfer' || !extracted.player) {
      logTweet(tweet.id, tweet.text, null, false);
      continue;
    }

    const transfer = upsertTransfer(extracted, tweet.id, tweet.text, tweet.source, tweet.created_at);

    logTweet(tweet.id, tweet.text, transfer.id, true);

    if (transfer._action === 'created') addedCount++;

    const arrow = `${extracted.from_club ?? '?'} → ${extracted.to_club ?? '?'}`;
    console.log(`[poll]   ${transfer._action}: ${extracted.player} | ${arrow} | ${extracted.status} (${extracted.confidence})`);

    broadcast('transfer', transfer);
  }

  // Translate any newly added transfers to Arabic
  const translatedCount = await translatePending();
  await backfillPlayerCountries();
  await backfillEntityDescriptions();
  logUpdate(addedCount, translatedCount);
}

export function startCron() {
  if (process.env.POLL_DISABLED === 'true') {
    console.log('[cron] Polling disabled (POLL_DISABLED=true)');
    return;
  }
  pollOnce().catch(console.error);
  cron.schedule('0 * * * *', () => pollOnce().catch(console.error));
  console.log('[cron] Scheduled: every hour at :00');
}
