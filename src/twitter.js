import Parser from 'rss-parser';

const parser = new Parser({ timeout: 10_000 });

const NITTER_INSTANCES = [
  'https://nitter.privacydev.net',
  'https://nitter.poast.org',
  'https://nitter.1d4.us',
  'https://nitter.kavin.rocks',
  'https://nitter.net',
];

const NEWS_FEEDS = [
  { name: 'Sky Sports',  url: 'https://www.skysports.com/rss/12040' },
  { name: 'BBC Sport',   url: 'https://feeds.bbci.co.uk/sport/football/rss.xml' },
  { name: '90min',       url: 'https://www.90min.com/posts.rss' },
];

const HANDLE = 'FabrizioRomano';

function extractId(link = '') {
  return /\/status\/(\d+)/.exec(link)?.[1] ?? null;
}

function stripHtml(html = '') {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function isNewer(tweetId, sinceId) {
  if (!sinceId) return true;
  return BigInt(tweetId) > BigInt(sinceId);
}

async function fetchNitterTweets(sinceId) {
  for (const base of NITTER_INSTANCES) {
    try {
      const feed = await parser.parseURL(`${base}/${HANDLE}/rss`);
      console.log(`[rss] Nitter ${base} (${feed.items.length} items)`);
      return feed.items
        .map(item => ({
          id:         extractId(item.link),
          text:       stripHtml(item.contentSnippet || item.content || item.title || ''),
          created_at: item.pubDate,
          source:     'Fabrizio Romano',
        }))
        .filter(t => t.id && t.text && isNewer(t.id, sinceId))
        .reverse();
    } catch (err) {
      console.warn(`[rss] ${base} failed: ${err.message}`);
    }
  }
  console.warn('[rss] All Nitter instances failed');
  return [];
}

async function fetchNewsFeeds() {
  const results = await Promise.allSettled(
    NEWS_FEEDS.map(async ({ name, url }) => {
      const feed = await parser.parseURL(url);
      console.log(`[rss] ${name} (${feed.items.length} items)`);
      return feed.items.map(item => ({
        id:         item.link || item.guid || '',
        text:       `${item.title || ''} — ${stripHtml(item.contentSnippet || item.content || '')}`.slice(0, 600),
        created_at: item.pubDate || item.isoDate,
        source:     name,
      })).filter(t => t.id && t.text);
    })
  );

  return results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);
}

/**
 * Fetches new Twitter tweets (filtered by sinceId) + all news RSS items.
 * News items use their URL as ID; dedup is handled by tweet_log INSERT OR IGNORE.
 */
export async function fetchNewTweets(_unusedUserId, sinceId = null) {
  const [twitterTweets, newsItems] = await Promise.all([
    fetchNitterTweets(sinceId),
    fetchNewsFeeds(),
  ]);
  return [...twitterTweets, ...newsItems];
}

export async function resolveUserId(_username) {
  return { id: 'nitter-rss', name: 'Fabrizio Romano (nitter RSS)' };
}
