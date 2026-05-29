import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { getConfig } from './config';
import { logger } from './logger';
import type { Master, MasterPost } from './scraper';

/**
 * Postgres sink. After each scrape the master is upserted here, one row per X
 * post, and the hosted Krexa site reads from this table (filter is_bill=true,
 * rank by amount/platform — whatever the site wants).
 *
 * Connection via DATABASE_URL (Render Postgres / Supabase / Neon / any Postgres).
 * SSL is on by default for hosted DBs; set DATABASE_SSL=false for a local one.
 */

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (pool) return pool;
  const cfg = getConfig();
  if (!cfg.DATABASE_URL) throw new Error('DATABASE_URL not set');
  const local = /localhost|127\.0\.0\.1/.test(cfg.DATABASE_URL);
  const ssl = process.env.DATABASE_SSL === 'false' || local ? false : { rejectUnauthorized: false };
  pool = new pg.Pool({ connectionString: cfg.DATABASE_URL, ssl, max: 4 });
  return pool;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS krexa_posts (
  post_id        text PRIMARY KEY,
  campaign       text NOT NULL DEFAULT '',
  platform       text NOT NULL DEFAULT '',   -- AI product the bill is for (Claude/Codex/...)
  is_bill        boolean NOT NULL DEFAULT false,
  post_url       text NOT NULL DEFAULT '',
  handle         text NOT NULL DEFAULT '',
  name           text NOT NULL DEFAULT '',
  profile_url    text NOT NULL DEFAULT '',
  amount         numeric,                     -- bill total (NULL if none/unknown)
  currency       text NOT NULL DEFAULT '',
  vendor         text NOT NULL DEFAULT '',
  bill_date      text NOT NULL DEFAULT '',
  post_text      text NOT NULL DEFAULT '',
  ocr_text       text NOT NULL DEFAULT '',
  image_url      text NOT NULL DEFAULT '',
  post_type      text NOT NULL DEFAULT '',
  likes          integer NOT NULL DEFAULT 0,
  retweets       integer NOT NULL DEFAULT 0,
  replies        integer NOT NULL DEFAULT 0,
  views          integer NOT NULL DEFAULT 0,
  posted_at      timestamptz,
  matched_queries text NOT NULL DEFAULT '',
  first_captured timestamptz,
  last_captured  timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS krexa_posts_bill_idx     ON krexa_posts (is_bill, platform);
CREATE INDEX IF NOT EXISTS krexa_posts_handle_idx   ON krexa_posts (handle);
CREATE INDEX IF NOT EXISTS krexa_posts_campaign_idx ON krexa_posts (campaign);
`;

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  await getPool().query(SCHEMA);
  schemaReady = true;
}

const num = (s: string): number | null => {
  const n = parseFloat(String(s).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const ts = (s: string): string | null => (s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null);

const UPSERT = `
INSERT INTO krexa_posts (
  post_id, campaign, platform, is_bill, post_url, handle, name, profile_url,
  amount, currency, vendor, bill_date, post_text, ocr_text, image_url, post_type,
  likes, retweets, replies, views, posted_at, matched_queries, first_captured, last_captured, updated_at
) VALUES (
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24, now()
)
ON CONFLICT (post_id) DO UPDATE SET
  platform=EXCLUDED.platform, is_bill=EXCLUDED.is_bill, post_url=EXCLUDED.post_url,
  handle=EXCLUDED.handle, name=EXCLUDED.name, profile_url=EXCLUDED.profile_url,
  amount=EXCLUDED.amount, currency=EXCLUDED.currency, vendor=EXCLUDED.vendor,
  bill_date=EXCLUDED.bill_date, post_text=EXCLUDED.post_text, ocr_text=EXCLUDED.ocr_text,
  image_url=EXCLUDED.image_url, post_type=EXCLUDED.post_type,
  likes=GREATEST(krexa_posts.likes, EXCLUDED.likes),
  retweets=GREATEST(krexa_posts.retweets, EXCLUDED.retweets),
  replies=GREATEST(krexa_posts.replies, EXCLUDED.replies),
  views=GREATEST(krexa_posts.views, EXCLUDED.views),
  posted_at=EXCLUDED.posted_at, matched_queries=EXCLUDED.matched_queries,
  last_captured=EXCLUDED.last_captured, updated_at=now();
`;

function rowParams(campaign: string, p: MasterPost): unknown[] {
  return [
    p.id,
    campaign,
    p.bill_platform ?? '',
    Boolean(p.is_bill),
    p.url,
    p.handle ?? '',
    p.name ?? '',
    p.handle ? `https://x.com/${p.handle}` : '',
    num(p.bill_amount ?? ''),
    p.bill_currency ?? '',
    p.bill_vendor ?? '',
    p.bill_date ?? '',
    (p.text ?? '').replace(/\s+/g, ' ').trim(),
    (p.ocr_text ?? '').trim(),
    p.images?.[0] ?? '',
    p.type ?? '',
    p.likes | 0,
    p.retweets | 0,
    p.replies | 0,
    p.views | 0,
    ts(p.ts ?? ''),
    (p.queries ?? []).join(' | '),
    ts(p.first_captured ?? ''),
    ts(p.last_captured ?? ''),
  ];
}

/** Upsert every post in the given master into Postgres. Returns rows written. */
export async function syncMaster(master: Master): Promise<number> {
  await ensureSchema();
  const client = await getPool().connect();
  let n = 0;
  try {
    await client.query('BEGIN');
    for (const p of Object.values(master.posts)) {
      await client.query(UPSERT, rowParams(master.campaign, p));
      n++;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return n;
}

/** Read the master.json written by the last run and sync it. No-op if no DATABASE_URL. */
export async function syncFromDisk(): Promise<void> {
  const cfg = getConfig();
  if (!cfg.DATABASE_URL) return;
  const path = join(cfg.DATA_DIR, `${cfg.CAMPAIGN}_campaign_master.json`);
  if (!existsSync(path)) {
    logger.warn('db: master.json not found — nothing to sync');
    return;
  }
  const master = JSON.parse(readFileSync(path, 'utf8')) as Master;
  try {
    const n = await syncMaster(master);
    const bills = Object.values(master.posts).filter((p) => p.is_bill).length;
    logger.info(`db: synced ${n} posts to krexa_posts (${bills} bills)`);
  } catch (e) {
    logger.error(`db: sync failed — ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function closeDb(): Promise<void> {
  if (pool) await pool.end().catch(() => {});
  pool = null;
}
