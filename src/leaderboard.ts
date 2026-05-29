import type { Master, MasterPost } from './scraper';

/**
 * The site-facing artifact. One entry per author (entrant), ranked. The Krexa
 * leaderboard site consumes this — either by fetching it from the built-in HTTP
 * server (GET /leaderboard.json) or via the webhook push.
 *
 * Ranking for the #KrexaBillChallenge: a "bill" post (image OCR'd and classified
 * as a bill/receipt/transaction) is the unit that counts. We sort by bill count,
 * then total bill amount, then engagement — but the raw numbers are all present
 * so the site can re-rank however it wants.
 */

export interface BillSample {
  url: string;
  amount: string;
  currency: string;
  vendor: string;
  date: string;
  posted_at: string;
  image: string;
}

export interface LeaderboardEntry {
  rank: number;
  handle: string;
  name: string;
  profile_url: string;
  posts: number;
  bills: number;
  bill_total: number;
  currencies: string[];
  originals: number;
  quotes: number;
  replies: number;
  reposts: number;
  likes: number;
  retweets: number;
  views: number;
  first_post: string;
  last_post: string;
  post_urls: string[];
  bill_samples: BillSample[];
}

export interface Leaderboard {
  campaign: string;
  queries: string[];
  updated_at: string;
  totals: { posts: number; authors: number; bills: number; bill_total: number };
  entries: LeaderboardEntry[];
}

const num = (s: string): number => {
  const n = parseFloat(String(s).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

export function buildLeaderboard(master: Master): Leaderboard {
  const byAuthor = new Map<string, MasterPost[]>();
  for (const p of Object.values(master.posts)) {
    const key = (p.handle || p.repost_by || 'unknown').toLowerCase();
    const arr = byAuthor.get(key) ?? [];
    arr.push(p);
    byAuthor.set(key, arr);
  }

  const entries: LeaderboardEntry[] = [...byAuthor.values()].map((ps) => {
    const tss = ps.map((p) => p.ts).filter(Boolean).sort();
    const countType = (t: string) => ps.filter((p) => p.type === t).length;
    const bills = ps.filter((p) => p.is_bill);
    const currencies = Array.from(new Set(bills.map((p) => p.bill_currency).filter(Boolean)));
    const handle = ps[0]!.handle || (ps[0]!.repost_by || 'unknown');
    return {
      rank: 0,
      handle,
      name: ps[0]!.name || '',
      profile_url: ps[0]!.handle ? `https://x.com/${ps[0]!.handle}` : '',
      posts: ps.length,
      bills: bills.length,
      bill_total: Math.round(bills.reduce((s, p) => s + num(p.bill_amount), 0) * 100) / 100,
      currencies,
      originals: countType('original'),
      quotes: countType('quote'),
      replies: countType('reply'),
      reposts: countType('repost'),
      likes: ps.reduce((s, p) => s + p.likes, 0),
      retweets: ps.reduce((s, p) => s + p.retweets, 0),
      views: ps.reduce((s, p) => s + p.views, 0),
      first_post: tss[0] ?? '',
      last_post: tss.at(-1) ?? '',
      post_urls: ps.map((p) => p.url),
      bill_samples: bills.map((p) => ({
        url: p.url,
        amount: p.bill_amount,
        currency: p.bill_currency,
        vendor: p.bill_vendor,
        date: p.bill_date,
        posted_at: p.ts,
        image: p.images?.[0] ?? '',
      })),
    };
  });

  // sort: bills desc → bill_total desc → posts desc → views desc
  entries.sort(
    (a, b) =>
      b.bills - a.bills || b.bill_total - a.bill_total || b.posts - a.posts || b.views - a.views,
  );
  entries.forEach((e, i) => (e.rank = i + 1));

  return {
    campaign: master.campaign,
    queries: master.queries,
    updated_at: new Date().toISOString(),
    totals: {
      posts: Object.keys(master.posts).length,
      authors: entries.length,
      bills: entries.reduce((s, e) => s + e.bills, 0),
      bill_total: Math.round(entries.reduce((s, e) => s + e.bill_total, 0) * 100) / 100,
    },
    entries,
  };
}

/** Flat, spreadsheet-friendly rows (nested bill_samples collapsed to scalars). */
export function leaderboardCsvRows(lb: Leaderboard): Record<string, unknown>[] {
  return lb.entries.map((e) => ({
    rank: e.rank,
    handle: e.handle,
    name: e.name,
    profile_url: e.profile_url,
    posts: e.posts,
    bills: e.bills,
    bill_total: e.bill_total,
    currencies: e.currencies.join(' '),
    originals: e.originals,
    quotes: e.quotes,
    replies: e.replies,
    reposts: e.reposts,
    likes: e.likes,
    retweets: e.retweets,
    views: e.views,
    first_post: e.first_post,
    last_post: e.last_post,
    bill_vendors: e.bill_samples.map((b) => b.vendor).filter(Boolean).join(' | '),
    bill_amounts: e.bill_samples.map((b) => `${b.currency}${b.amount}`).filter((s) => s.length > 1).join(' | '),
    post_urls: e.post_urls.join(' | '),
  }));
}
