import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a football transfer data extraction system. Analyze tweets from journalist Fabrizio Romano and return a single JSON object — nothing else, no markdown, no explanation.

Fields:
  player      : string | null   — full player name
  from_club   : string | null   — selling / current club
  to_club     : string | null   — buying / destination club
  fee         : string | null   — transfer fee (e.g. "€85m", "free transfer", "loan")
  status      : one of "confirmed" | "agreement" | "advanced_talks" | "talks" | "interest" | "loan" | "rejected" | "cancelled" | "not_transfer"
  confidence  : number 0–1

Confidence guidance (from Romano's well-known signals):
  "Here we go!"           → 0.99
  "done deal" / "signed"  → 0.99
  "agreement" / "done"    → 0.90
  "advanced talks"        → 0.75
  "in talks"              → 0.60
  "opening bid" / "offer" → 0.50
  "interest" / "contact"  → 0.30
  no clear signal         → 0.10

If the tweet is not about a player transfer or signing, set status to "not_transfer" and player to null.`;

const jsonBlockRe = /```(?:json)?\s*([\s\S]*?)```/;

export async function extractTransferData(tweetText) {
  const msg = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 256,
    system:     SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: `Tweet: "${tweetText}"` },
    ],
  });

  const raw = msg.content[0].text.trim();
  const jsonText = jsonBlockRe.exec(raw)?.[1]?.trim() ?? raw;

  try {
    return JSON.parse(jsonText);
  } catch {
    console.error('[claude] Failed to parse response:', raw.slice(0, 200));
    return null;
  }
}
