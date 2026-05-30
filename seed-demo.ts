/**
 * Seed fake leaderboard entries for frontend testing.
 *
 *   npx tsx seed-demo.ts            insert 50 fake bills ($20-100)
 *   npx tsx seed-demo.ts --count 80
 *   npx tsx seed-demo.ts --clear   remove all demo rows
 *
 * Fake rows have post_id like 'demo-<n>' so they never collide with real scraped
 * posts and are easy to delete. Every link (post + profile) points at the
 * rickroll, per request. Uses DATABASE_URL from .env.
 */
import 'dotenv/config';
import pg from 'pg';

const RICKROLL = 'https://youtu.be/dQw4w9WgXcQ?si=TUIi1Tlul8sFP9DK';

function makePool(): pg.Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set in .env');
  let cs = url;
  try {
    const u = new URL(url);
    u.searchParams.delete('sslmode');
    cs = u.toString();
  } catch {
    /* use as-is */
  }
  const local = /localhost|127\.0\.0\.1/.test(url);
  return new pg.Pool({ connectionString: cs, ssl: local ? false : { rejectUnauthorized: false }, max: 4 });
}

const PLATFORMS = ['Claude', 'OpenAI', 'Anthropic', 'ChatGPT', 'Codex', 'Cursor', 'Gemini'];
const VENDORS: Record<string, string> = {
  Claude: 'Anthropic, PBC',
  Anthropic: 'Anthropic, PBC',
  OpenAI: 'OpenAI, LLC',
  ChatGPT: 'OpenAI, LLC',
  Codex: 'OpenAI, LLC',
  Cursor: 'Anysphere Inc.',
  Gemini: 'Google LLC',
};
const ADJ = ['token', 'prompt', 'vibe', 'midnight', 'terminal', 'agent', 'context', 'ai', 'gpu', 'compute'];
const NOUN = ['addict', 'gremlin', 'wizard', 'maxxer', 'pilled', 'enjoyer', 'cowboy', 'goblin', 'fiend', 'degen'];

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)]!;

function fakeRow(i: number) {
  const platform = pick(PLATFORMS);
  const amount = Math.round(rnd(20, 100) * 100) / 100;
  const handle = `${pick(ADJ)}_${pick(NOUN)}${Math.floor(rnd(1, 999))}`;
  const name = `${pick(ADJ)} ${pick(NOUN)}`.replace(/\b\w/g, (c) => c.toUpperCase());
  const postedAt = new Date(Date.now() - rnd(0, 5 * 24 * 3600 * 1000)).toISOString();
  const img = `https://placehold.co/420x620/png?text=${encodeURIComponent(`${platform}\n$${amount}`)}`;
  return {
    post_id: `demo-${i}`,
    campaign: 'krexa',
    platform,
    is_bill: true,
    amount,
    currency: '$',
    vendor: VENDORS[platform] ?? platform,
    post_url: RICKROLL,
    handle,
    name,
    profile_url: RICKROLL,
    image_url: img,
    post_text: `My ${platform} bill is criminal #KrexaBillChallenge @krexa_xyz`,
    post_type: 'original',
    likes: Math.floor(rnd(0, 500)),
    retweets: Math.floor(rnd(0, 80)),
    replies: Math.floor(rnd(0, 40)),
    views: Math.floor(rnd(100, 50000)),
    posted_at: postedAt,
    matched_queries: '#krexabillchallenge',
  };
}

const COLS = [
  'post_id', 'campaign', 'platform', 'is_bill', 'amount', 'currency', 'vendor', 'post_url', 'handle', 'name',
  'profile_url', 'image_url', 'post_text', 'post_type', 'likes', 'retweets', 'replies', 'views', 'posted_at',
  'matched_queries', 'first_captured', 'last_captured', 'updated_at',
];

async function main() {
  const args = process.argv.slice(2);
  const pool = makePool();
  try {
    if (args.includes('--clear')) {
      const r = await pool.query("DELETE FROM krexa_posts WHERE post_id LIKE 'demo-%'");
      console.log(`cleared ${r.rowCount} demo rows`);
      return;
    }
    const count = Number(args[args.indexOf('--count') + 1]) || 50;
    const now = new Date().toISOString();
    const ph = COLS.map((_, i) => `$${i + 1}`).join(',');
    const sql = `INSERT INTO krexa_posts (${COLS.join(',')}) VALUES (${ph})
      ON CONFLICT (post_id) DO UPDATE SET platform=EXCLUDED.platform, amount=EXCLUDED.amount,
        currency=EXCLUDED.currency, vendor=EXCLUDED.vendor, post_url=EXCLUDED.post_url,
        handle=EXCLUDED.handle, name=EXCLUDED.name, profile_url=EXCLUDED.profile_url,
        image_url=EXCLUDED.image_url, views=EXCLUDED.views, updated_at=now()`;
    for (let i = 1; i <= count; i++) {
      const r = fakeRow(i);
      await pool.query(sql, [
        r.post_id, r.campaign, r.platform, r.is_bill, r.amount, r.currency, r.vendor, r.post_url, r.handle, r.name,
        r.profile_url, r.image_url, r.post_text, r.post_type, r.likes, r.retweets, r.replies, r.views, r.posted_at,
        r.matched_queries, now, now, now,
      ]);
    }
    console.log(`inserted/updated ${count} demo bill rows (links → rickroll)`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
