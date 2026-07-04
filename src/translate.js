import axios from 'axios';
import { getUntranslated, saveTranslation, updateFromClub, getTransferById,
         getMissingPlayerCountry, updatePlayerCountry } from './db.js';
import { askClaude } from './claudeCli.js';
import { broadcast } from './api.js';

const SYSTEM = `You are a football data assistant.
Given transfer data, return ONLY a valid JSON object with these fields:
- player_ar: Arabic transliteration of the player name
- from_club_ar: Arabic name of the selling club (use names common in Arabic sports media)
- to_club_ar: Arabic name of the buying club
- tweet_preview_ar: Full Arabic translation of the tweet text, keep emojis
- from_club_country: Country of the selling club in English lowercase (e.g. "england", "germany", "spain"). Use null if unknown.
- to_club_country: Country of the buying club in English lowercase. Use null if unknown.
- player_country: Nationality of the player in English lowercase (e.g. "france", "brazil"). Use null if unknown.

Return ONLY valid JSON, no markdown, no explanation.`;

async function fetchWikipediaPhoto(playerName) {
  try {
    const { data } = await axios.get('https://en.wikipedia.org/w/api.php', {
      params: {
        action: 'query',
        titles: playerName,
        prop: 'pageimages',
        format: 'json',
        pithumbsize: 400,
      },
      headers: {
        'User-Agent': 'TransferTracker/1.0 (football-transfer-app; contact@example.com)',
        'Accept': 'application/json',
      },
      timeout: 8000,
    });
    const pages = data.query?.pages ?? {};
    const page  = Object.values(pages)[0];
    return page?.thumbnail?.source ?? null;
  } catch {
    return null;
  }
}

async function fetchWikiSummary(playerName) {
  try {
    const { data: sr } = await axios.get('https://en.wikipedia.org/w/api.php', {
      params: { action:'query', list:'search', srsearch:`${playerName} footballer`, format:'json', srlimit:1 },
      headers: { 'User-Agent': 'TransferTracker/1.0 (football-transfer-app)' },
      timeout: 6000,
    });
    const title = sr.query?.search?.[0]?.title;
    if (!title) return null;

    const { data: pg } = await axios.get(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
      { headers: { 'User-Agent': 'TransferTracker/1.0 (football-transfer-app)' }, timeout: 6000 }
    );
    return pg.extract?.slice(0, 600) ?? null;
  } catch {
    return null;
  }
}

async function resolveFromClub(playerName, toClub) {
  const summary = await fetchWikiSummary(playerName);

  const toNote = toClub
    ? `IMPORTANT: This player is being transferred TO "${toClub}", so do NOT return "${toClub}" as the answer. Find the club they played for BEFORE this transfer.`
    : '';

  const context = summary
    ? `Wikipedia text: ${summary}\n\n`
    : `No Wikipedia page found. Use your football knowledge.\n\n`;

  const userPrompt = `${context}${toNote}\n\nWhat club did ${playerName} play for BEFORE their current/upcoming transfer?\nReturn ONLY valid JSON: { "club_en": "Club Name", "club_ar": "اسم النادي بالعربية", "country": "country in english lowercase" }\nIf truly unknown return {"club_en":null,"club_ar":null,"country":null}`;

  try {
    const raw = await askClaude('You are a football data assistant. Return ONLY valid JSON, no markdown, no explanation.', userPrompt);
    const jsonText = raw.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

async function translateOne(tr) {
  const rawTweets  = JSON.parse(tr.raw_tweets || '[]');
  const tweetText  = rawTweets[0] || '';

  // Run Claude translation and Wikipedia photo fetch in parallel
  const [raw, photo_url] = await Promise.all([
    askClaude(SYSTEM, JSON.stringify({
      player:        tr.player,
      from_club:     tr.from_club,
      to_club:       tr.to_club,
      tweet_preview: tweetText.slice(0, 300),
    })),
    fetchWikipediaPhoto(tr.player),
  ]);

  const jsonText = raw.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'').trim();
  const result   = JSON.parse(jsonText);

  return { ...result, photo_url };
}

async function fetchPlayerCountry(playerName) {
  try {
    const raw = await askClaude(
      'You are a football data assistant. Return ONLY valid JSON, no markdown, no explanation.',
      `What is the nationality of footballer "${playerName}"? Return ONLY valid JSON: {"country":"england"} in English lowercase, or {"country":null} if unknown.`
    );
    const jsonText = raw.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'').trim();
    return JSON.parse(jsonText).country ?? null;
  } catch {
    return null;
  }
}

let backfillInProgress = false;

export async function backfillPlayerCountries() {
  if (backfillInProgress) return 0;
  backfillInProgress = true;
  try {
    const rows = getMissingPlayerCountry();
    if (!rows.length) return 0;

    console.log(`[translate] Backfilling nationality for ${rows.length} player(s)...`);
    let count = 0;
    for (const row of rows) {
      const country = await fetchPlayerCountry(row.player);
      if (country) {
        updatePlayerCountry(row.id, country);
        broadcast('transfer', getTransferById(row.id));
        console.log(`[translate] 🌍 ${row.player} → ${country}`);
        count++;
      } else {
        // Mark as checked so we don't keep retrying an unknown nationality forever
        updatePlayerCountry(row.id, '');
        console.log(`[translate] ⚪ ${row.player} → unknown, not retrying`);
      }
    }
    return count;
  } finally {
    backfillInProgress = false;
  }
}

let translateInProgress = false;

export async function translatePending() {
  if (translateInProgress) return 0;
  translateInProgress = true;
  try {
    return await translatePendingInner();
  } finally {
    translateInProgress = false;
  }
}

async function translatePendingInner() {
  const pending = getUntranslated();
  if (!pending.length) return 0;

  console.log(`[translate] ${pending.length} transfer(s) to process`);

  let translatedCount = 0;

  for (const tr of pending) {
    try {
      // If from_club is unknown, search Wikipedia for current club
      if (!tr.from_club) {
        console.log(`[translate] 🔍 searching current club for ${tr.player}...`);
        const club = await resolveFromClub(tr.player, tr.to_club);
        if (club?.club_en) {
          updateFromClub(tr.id, club.club_en, club.club_ar, club.country);
          tr.from_club    = club.club_en;
          tr.from_club_ar = club.club_ar;
          console.log(`[translate] 🏟  ${tr.player} current club: ${club.club_en} (${club.club_ar})`);
        }
      }

      const result = await translateOne(tr);
      saveTranslation(tr.id, result);
      broadcast('transfer', getTransferById(tr.id));
      translatedCount++;
      const photo = result.photo_url ? '📷' : '—';
      console.log(`[translate] ✓ ${tr.player} → ${result.player_ar} | ${result.from_club_country} → ${result.to_club_country} ${photo}`);
    } catch (err) {
      console.error(`[translate] ✗ ${tr.player}: ${err.message}`);
    }
  }

  console.log('[translate] Done.');
  return translatedCount;
}
