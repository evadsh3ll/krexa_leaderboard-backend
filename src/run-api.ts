/**
 * Browserless runner for the #KrexaBillChallenge.
 *
 *   tsx src/run-api.ts --once     one cycle: search → OCR → DB, then exit
 *   tsx src/run-api.ts --watch    loop every INTERVAL_MIN minutes (default)
 *
 * Pipeline (no Chrome):
 *   1. X GraphQL search for the campaign tag(s)        (src/xapi.ts)
 *   2. for each post with an image → vision OCR        (src/vision.ts)
 *      → bill amount + platform + vendor + date
 *   3. upsert one row per post into Postgres           (src/db.ts → krexa_posts)
 *
 * Idempotent: a local master (data/<campaign>_api_master.json) remembers which
 * posts were already OCR'd, so reruns never re-bill the same screenshot.
 *
 * This is a parallel path to the browser scraper (src/scraper.ts) — that code is
 * unchanged. Pick whichever host fits; both write the same krexa_posts table.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { collectViaTwscrape } from './collect';
import { startApiServer } from './api-server';
import type { ApiPost } from './xapi';
import { ocrImage } from './vision';
import { syncMaster, getLeaderboard, type LeaderboardRow } from './db';
import { toCsv } from './csv';
import { getConfig } from './config';
import { logger } from './logger';
import type { Master, MasterPost } from './scraper';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function queries(): string[] {
  return (process.env.X_QUERIES ?? '#krexabillchallenge')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function loadMaster(path: string, campaign: string, qs: string[]): Master {
  if (existsSync(path)) {
    try {
      const m = JSON.parse(readFileSync(path, 'utf8')) as Master;
      if (m && m.posts) return m;
    } catch (e) {
      logger.warn(`could not parse ${path} — starting fresh: ${e instanceof Error ? e.message : e}`);
    }
  }
  const now = new Date().toISOString();
  return { campaign, queries: qs, first_run: now, last_run: now, runs: [], posts: {} };
}

/** Merge a query's API posts into the master. Returns new-post count. */
function merge(master: Master, query: string, posts: ApiPost[]): number {
  const now = new Date().toISOString();
  let added = 0;
  for (const p of posts) {
    const existing = master.posts[p.id];
    if (existing) {
      existing.last_captured = now;
      if (!existing.queries.includes(query)) existing.queries.push(query);
      existing.replies = Math.max(existing.replies, p.replies);
      existing.retweets = Math.max(existing.retweets, p.retweets);
      existing.likes = Math.max(existing.likes, p.likes);
      existing.bookmarks = Math.max(existing.bookmarks, p.bookmarks);
      existing.views = Math.max(existing.views, p.views);
      if ((!existing.images || existing.images.length === 0) && p.images.length > 0) existing.images = p.images;
    } else {
      master.posts[p.id] = {
        id: p.id,
        url: p.url,
        handle: p.handle,
        name: p.name,
        ts: p.ts,
        text: p.text,
        type: p.type,
        repost_by: '',
        hasMedia: p.images.length > 0,
        images: p.images,
        replies: p.replies,
        retweets: p.retweets,
        likes: p.likes,
        bookmarks: p.bookmarks,
        views: p.views,
        queries: [query],
        first_captured: now,
        last_captured: now,
        ocr_done: false,
        ocr_text: '',
        is_bill: false,
        bill_platform: '',
        bill_amount: '',
        bill_currency: '',
        bill_vendor: '',
        bill_date: '',
      } satisfies MasterPost;
      added++;
    }
  }
  return added;
}

/** OCR every post with an un-processed image. Idempotent via ocr_done. */
async function ocrPending(master: Master): Promise<number> {
  const pending = Object.values(master.posts).filter((p) => !p.ocr_done && p.images?.length > 0);
  if (pending.length === 0) {
    logger.info('OCR: nothing pending');
    return 0;
  }
  logger.info(`OCR: ${pending.length} post(s) with images`);
  let done = 0;
  for (const p of pending) {
    const texts: string[] = [];
    let best: Awaited<ReturnType<typeof ocrImage>> | null = null;
    let anyOk = false;
    for (const src of p.images) {
      const r = await ocrImage(src);
      if (r.ok) {
        anyOk = true;
        if (r.text) texts.push(r.text);
        if (!best || (r.is_bill && !best.is_bill)) best = r;
      }
      await sleep(300);
    }
    if (anyOk) {
      p.ocr_done = true;
      p.ocr_text = texts.join('\n---\n');
      p.is_bill = best?.is_bill ?? false;
      p.bill_platform = best?.platform ?? '';
      p.bill_amount = best?.amount ?? '';
      p.bill_currency = best?.currency ?? '';
      p.bill_vendor = best?.vendor ?? '';
      p.bill_date = best?.date ?? '';
      done++;
      logger.info(
        `OCR ${done}/${pending.length}: @${p.handle} ${p.is_bill ? `BILL ${p.bill_platform || '?'} ${p.bill_currency}${p.bill_amount}` : 'no-bill'}`,
      );
    } else {
      logger.warn(`OCR: images failed for @${p.handle} (${p.url}) — retry next run`);
    }
  }
  return done;
}

function mentionRows(master: Master): Record<string, unknown>[] {
  return Object.values(master.posts)
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
    .map((p) => ({
      post_id: p.id,
      platform: p.bill_platform,
      is_bill: p.is_bill,
      bill_amount: p.bill_amount,
      bill_currency: p.bill_currency,
      handle: p.handle,
      name: p.name,
      posted_at: p.ts,
      text: p.text.replace(/\s+/g, ' ').trim(),
      ocr_text: (p.ocr_text ?? '').replace(/\s+/g, ' ').trim(),
      image_urls: (p.images ?? []).join(' | '),
      likes: p.likes,
      retweets: p.retweets,
      views: p.views,
      url: p.url,
    }));
}

export interface CycleStats {
  captured: number;
  new: number;
  ocr: number;
  bills: number;
  totalPosts: number;
}

async function cycle(): Promise<CycleStats> {
  const cfg = getConfig();
  const qs = queries();
  const campaign = cfg.CAMPAIGN;
  logger.info(`api cycle — queries: ${qs.join(', ')}`);

  mkdirSync(cfg.DATA_DIR, { recursive: true });
  const masterPath = join(cfg.DATA_DIR, `${campaign}_api_master.json`);
  const mentionsCsv = join(cfg.DATA_DIR, `${campaign}_api_mentions.csv`);
  const master = loadMaster(masterPath, campaign, qs);

  let captured = 0;
  let added = 0;
  for (const q of qs) {
    const posts = await collectViaTwscrape(q, cfg.MAX_POSTS);
    logger.info(`fetched ${posts.length} for "${q}"`);
    captured += posts.length;
    added += merge(master, q, posts);
    await sleep(1500);
  }

  const ocrDone = cfg.OCR ? await ocrPending(master) : 0;

  master.last_run = new Date().toISOString();
  master.queries = Array.from(new Set([...master.queries, ...qs]));
  master.runs.push({ ts: master.last_run, queries: qs, captured, new: added, ocr: ocrDone });

  writeFileSync(masterPath, JSON.stringify(master, null, 2));
  writeFileSync(mentionsCsv, toCsv(mentionRows(master)));

  if (cfg.DATABASE_URL) {
    try {
      // Only verified bills go to the leaderboard DB. The search query is
      // #krexabillchallenge, so every post already carries the tag; we additionally
      // require is_bill=true (an actual bill screenshot was read off the image).
      const billsMaster: Master = {
        ...master,
        posts: Object.fromEntries(Object.entries(master.posts).filter(([, p]) => p.is_bill)),
      };
      const n = await syncMaster(billsMaster);
      logger.info(`db: upserted ${n} bill rows into krexa_posts`);
    } catch (e) {
      logger.error(`db sync failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    logger.warn('DATABASE_URL not set — wrote files only (no DB push)');
  }

  const bills = Object.values(master.posts).filter((p) => p.is_bill).length;
  const totalPosts = Object.keys(master.posts).length;
  logger.info(`cycle done: ${captured} fetched, ${added} new, ${ocrDone} OCR'd, ${bills} bills total`);
  return { captured, new: added, ocr: ocrDone, bills, totalPosts };
}

// --- shared run state (interval loop + manual /run trigger go through this) ---
let running = false;
let lastRunAt: string | null = null;
let lastError: string | null = null;
let lastStats: CycleStats | null = null;
let consecutiveFails = 0;

/** Run one cycle unless one is already in flight. Never throws. */
async function runGuarded(trigger: string): Promise<void> {
  if (running) {
    logger.warn(`run requested by ${trigger} but a cycle is already running — skipped`);
    return;
  }
  running = true;
  logger.info(`cycle start (${trigger})`);
  try {
    lastStats = await cycle();
    lastError = null;
    consecutiveFails = 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    lastError = msg;
    consecutiveFails++;
    if (msg.startsWith('AUTH_FAILED')) {
      logger.error(`*** ACTION NEEDED — ${msg} (failure ${consecutiveFails}/5) ***`);
    } else {
      logger.error(`cycle failed (${consecutiveFails}/5): ${e instanceof Error ? (e.stack ?? msg) : msg}`);
    }
  } finally {
    lastRunAt = new Date().toISOString();
    running = false;
  }
}

/** Build the ranked leaderboard the frontend renders. Reads the DB if configured,
 *  otherwise falls back to the local master file (so it works in files-only mode). */
async function leaderboardData(): Promise<{ updated_at: string; count: number; entries: LeaderboardRow[] }> {
  const cfg = getConfig();
  let entries: LeaderboardRow[];
  if (cfg.DATABASE_URL) {
    entries = await getLeaderboard();
  } else {
    const path = join(cfg.DATA_DIR, `${cfg.CAMPAIGN}_api_master.json`);
    const master: Master = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { posts: {} } as Master;
    entries = Object.values(master.posts)
      .filter((p) => p.is_bill)
      .map((p) => ({
        rank: 0,
        platform: p.bill_platform,
        amount: p.bill_amount ? Number(String(p.bill_amount).replace(/[^\d.]/g, '')) || null : null,
        currency: p.bill_currency,
        vendor: p.bill_vendor,
        handle: p.handle,
        name: p.name,
        profile_url: p.handle ? `https://x.com/${p.handle}` : '',
        post_url: p.url,
        image_url: p.images?.[0] ?? '',
        posted_at: p.ts || null,
        likes: p.likes,
        retweets: p.retweets,
        views: p.views,
      }))
      .sort((a, b) => (b.amount ?? -1) - (a.amount ?? -1))
      .map((e, i) => ({ ...e, rank: i + 1 }));
  }
  return { updated_at: new Date().toISOString(), count: entries.length, entries };
}

function status(): Record<string, unknown> {
  const cfg = getConfig();
  return {
    running,
    last_run_at: lastRunAt,
    last_error: lastError,
    interval_min: cfg.INTERVAL_MIN,
    queries: queries(),
    db: cfg.DATABASE_URL ? 'postgres' : 'files-only',
    ...(lastStats ? { last: lastStats } : {}),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const once = args.includes('--once');
  const cfg = getConfig();

  if (once) {
    await runGuarded('--once');
    process.exit(lastError ? 1 : 0);
  }

  // watch mode: start the HTTP control surface (health + manual /run) AND loop.
  startApiServer({
    port: cfg.PORT,
    getStatus: status,
    triggerRun: () => {
      if (running) return { started: false };
      void runGuarded('manual /run'); // fire-and-forget; poll /health for result
      return { started: true };
    },
    getLeaderboard: leaderboardData,
  });

  logger.info(`watch mode — fetching every ${cfg.INTERVAL_MIN} min (browserless / X GraphQL)`);
  for (;;) {
    await runGuarded('interval');
    // Don't loop forever pretending to be healthy: after 5 straight failures,
    // exit non-zero so the supervisor (Render/pm2/systemd) flags it + restarts.
    if (consecutiveFails >= 5) {
      logger.error(`${consecutiveFails} consecutive failures — exiting(1) so the supervisor flags it`);
      process.exit(1);
    }
    logger.info(`sleeping ${cfg.INTERVAL_MIN} min`);
    await sleep(cfg.INTERVAL_MIN * 60_000);
  }
}

main().catch((e) => {
  logger.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
