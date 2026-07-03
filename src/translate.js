import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import { getUntranslated, saveTranslation, updateFromClub } from './db.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM = `You are a football data assistant.
Given transfer data, return ONLY a valid JSON object with these fields:
- player_ar: Arabic transliteration of the player name
- from_club_ar: Arabic name of the selling club (use names common in Arabic sports media)
- to_club_ar: Arabic name of the buying club
- tweet_preview_ar: Full Arabic translation of the tweet text, keep emojis
- from_club_country: Country of the selling club in English lowercase (e.g. "england", "germany", "spain"). Use null if unknown.
- to_club_country: Country of the buying club in English lowercase. Use null if unknown.

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

  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: `${context}${toNote}\n\nWhat club did ${playerName} play for BEFORE their current/upcoming transfer?\nReturn ONLY valid JSON: { "club_en": "Club Name", "club_ar": "اسم النادي بالعربية", "country": "country in english lowercase" }\nIf truly unknown return {"club_en":null,"club_ar":null,"country":null}`,
    }],
  });

  try {
    const raw = msg.content[0].text.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function translateOne(tr) {
  const rawTweets  = JSON.parse(tr.raw_tweets || '[]');
  const tweetText  = rawTweets[0] || '';

  // Run Claude translation and Wikipedia photo fetch in parallel
  const [msg, photo_url] = await Promise.all([
    anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: JSON.stringify({
          player:        tr.player,
          from_club:     tr.from_club,
          to_club:       tr.to_club,
          tweet_preview: tweetText.slice(0, 300),
        }),
      }],
    }),
    fetchWikipediaPhoto(tr.player),
  ]);

  const raw      = msg.content[0].text.trim();
  const jsonText = raw.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'').trim();
  const result   = JSON.parse(jsonText);

  return { ...result, photo_url };
}

export async function translatePending() {
  const pending = getUntranslated();
  if (!pending.length) return;

  console.log(`[translate] ${pending.length} transfer(s) to process`);

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
      const photo = result.photo_url ? '📷' : '—';
      console.log(`[translate] ✓ ${tr.player} → ${result.player_ar} | ${result.from_club_country} → ${result.to_club_country} ${photo}`);
    } catch (err) {
      console.error(`[translate] ✗ ${tr.player}: ${err.message}`);
    }
  }

  console.log('[translate] Done.');
}
