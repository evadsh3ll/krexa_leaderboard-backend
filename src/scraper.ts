/**
 * X (Twitter) campaign mention scraper for the #KrexaBillChallenge — read-only.
 *
 * Captures EVERY post matching the campaign queries (hashtags / @krexa_xyz
 * mentions), de-duplicates by post ID, MERGES across runs into a master store,
 * OCRs any bill screenshot on each post, and rebuilds the leaderboard the Krexa
 * site consumes. Running it repeatedly during the campaign accumulates data
 * without loss or duplication.
 *
 * Read-only: only scrolls search-result pages. No posting, liking, following.
 *
 * Completeness note: X "Latest" search returns roughly the last ~7-10 days of
 * results. Run on a schedule (the --watch loop does this). The merge step
 * guarantees nothing is lost between runs as long as you run before posts age
 * out of the search window.
 */
import { chromium, type Page } from 'patchright';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { humanScroll, humanPause, sleep } from './human';
import { toCsv } from './csv';
import { ocrImage } from './vision';
import { buildLeaderboard, leaderboardCsvRows } from './leaderboard';
import { getConfig } from './config';
import { logger } from './logger';

export interface MentionPost {
  id: string;
  url: string;
  handle: string;
  name: string;
  ts: string;
  text: string;
  type: 'original' | 'reply' | 'quote' | 'repost';
  repost_by: string;
  hasMedia: boolean;
  images: string[];
  replies: number;
  retweets: number;
  likes: number;
  bookmarks: number;
  views: number;
}

export interface MasterPost extends MentionPost {
  queries: string[];
  first_captured: string;
  last_captured: string;
  // --- bill OCR ---
  ocr_done: boolean;
  ocr_text: string;
  is_bill: boolean;
  bill_platform: string; // which AI product the bill is for (Claude / Codex / ...)
  bill_amount: string;
  bill_currency: string;
  bill_vendor: string;
  bill_date: string;
}

export interface Master {
  campaign: string;
  queries: string[];
  first_run: string;
  last_run: string;
  runs: { ts: string; queries: string[]; captured: number; new: number; ocr: number }[];
  posts: Record<string, MasterPost>;
}

// Collector runs inside the page. Passed as a STRING (not a closure) so esbuild's
// keepNames __name() wrapper can't leak into the evaluate body.
const COLLECT_JS = `(function(){
  function parseCount(s){
    if(!s) return 0;
    var m=String(s).replace(/,/g,'').match(/([\\d.]+)\\s*([KMB]?)/i);
    if(!m) return 0;
    var n=parseFloat(m[1]); var u=m[2]?m[2].toUpperCase():'';
    var mult=u==='K'?1e3:u==='M'?1e6:u==='B'?1e9:1;
    return Math.round(n*mult);
  }
  function metricFromAria(el, kwSrc){
    if(!el) return 0;
    var aria=(el.getAttribute('aria-label')||'').match(new RegExp('([\\\\d.,KMB]+)\\\\s*'+kwSrc,'i'));
    if(aria) return parseCount(aria[1]);
    var txt=el.innerText||''; var num=txt.match(/[\\d.,KMB]+/);
    return num?parseCount(num[0]):0;
  }
  var arts=document.querySelectorAll('article[data-testid="tweet"]');
  var out=[];
  for(var i=0;i<arts.length;i++){
    var a=arts[i];
    var statusLink=a.querySelector('a[href*="/status/"]');
    var url=statusLink?statusLink.href:'';
    var idM=url.match(/status\\/(\\d+)/); var id=idM?idM[1]:'';
    if(!id) continue;
    var hM=url.match(/(?:x|twitter)\\.com\\/([^/]+)\\/status/);
    var handle=hM?hM[1]:'';
    var nameEl=a.querySelector('[data-testid="User-Name"]');
    var name='';
    if(nameEl&&nameEl.innerText){
      var nlines=nameEl.innerText.split('\\n');
      for(var j=0;j<nlines.length;j++){ var ln=nlines[j].trim(); if(ln && ln.charAt(0)!=='@' && ln!=='·'){ name=ln; break; } }
    }
    var timeEl=a.querySelector('time');
    var ts=timeEl?(timeEl.getAttribute('datetime')||''):'';
    var textEl=a.querySelector('[data-testid="tweetText"]');
    var text=textEl?textEl.innerText:'';
    var hasMedia=!!(a.querySelector('[data-testid="tweetPhoto"]')||a.querySelector('video')||a.querySelector('[data-testid="videoPlayer"]')||a.querySelector('[data-testid="card.wrapper"]'));
    var photoEls=a.querySelectorAll('[data-testid="tweetPhoto"] img, img[src*="pbs.twimg.com/media"]');
    var images=[]; var seenImg={};
    for(var p2=0;p2<photoEls.length;p2++){ var isrc=photoEls[p2].src||''; if(isrc && isrc.indexOf('pbs.twimg.com/media')>-1 && !seenImg[isrc]){ seenImg[isrc]=1; images.push(isrc.replace(/([?&]name=)\\w+/,'$1large')); } }
    var sc=a.querySelector('[data-testid="socialContext"]');
    var socialCtx=sc?sc.innerText:'';
    var isRepost=/reposted/i.test(socialCtx);
    var repostBy = isRepost ? socialCtx.replace(/reposted/i,'').trim() : '';
    var isReply=!!a.querySelector('[data-testid="reply-context"]')||/Replying to/i.test(((a.innerText||'').slice(0,200)));
    var isQuote=false;
    var nested=a.querySelectorAll('a[href*="/status/"]');
    for(var q=0;q<nested.length;q++){
      var nm=(nested[q].href||'').match(/status\\/(\\d+)/);
      if(nm&&nm[1]&&nm[1]!==id){ isQuote=true; break; }
    }
    var type = isRepost?'repost':(isReply?'reply':(isQuote?'quote':'original'));
    var replies=metricFromAria(a.querySelector('[data-testid="reply"]'),'repl');
    var retweets=metricFromAria(a.querySelector('[data-testid="retweet"]'),'repost|retweet');
    var likes=metricFromAria(a.querySelector('[data-testid="like"], [data-testid="unlike"]'),'like');
    var bookmarks=metricFromAria(a.querySelector('[data-testid="bookmark"], [data-testid="removeBookmark"]'),'bookmark');
    var analyticsLink=a.querySelector('a[href$="/analytics"], a[aria-label*="View post analytics" i]');
    var views=metricFromAria(analyticsLink,'view');
    if(!views){
      var group=a.querySelector('[role="group"]');
      var aria=group?(group.getAttribute('aria-label')||''):'';
      var vm=aria.match(/([\\d.,KMB]+)\\s*view/i);
      if(vm) views=parseCount(vm[1]);
    }
    out.push({id:id,url:url,handle:handle,name:name,ts:ts,text:text,type:type,repost_by:repostBy,hasMedia:hasMedia,images:images,replies:replies,retweets:retweets,likes:likes,bookmarks:bookmarks,views:views});
  }
  return out;
})()`;

const END_MARKER_JS = `(function(){
  var nodes=document.querySelectorAll('div, span');
  for(var i=0;i<nodes.length;i++){
    var t=(nodes[i].textContent||'').trim().toLowerCase();
    if(t==="you've reached the end"||t==='you have reached the end'||t==='no more posts'||t==='no results for') return true;
  }
  return false;
})()`;

const NO_RESULTS_JS = `(function(){
  var nodes=document.querySelectorAll('div, span');
  for(var i=0;i<nodes.length;i++){
    var t=(nodes[i].textContent||'').trim();
    if(/^No results for/i.test(t)) return true;
  }
  return false;
})()`;

async function collect(page: Page): Promise<MentionPost[]> {
  return (await page.evaluate(COLLECT_JS)) as MentionPost[];
}

/** Harvest every post for a single query off the "Latest" tab (patient scroll loop). */
async function harvest(page: Page, query: string): Promise<Map<string, MentionPost>> {
  const cfg = getConfig();
  const url = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`;
  logger.info(`query "${query}" → ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await sleep(2500);
  await humanPause(1500, 2500);

  if (/\/(i\/flow\/login|login)\b/.test(page.url())) {
    throw new Error('redirected to login — the X session is not logged in (attach to a signed-in Chrome)');
  }

  try {
    await page.locator('article[data-testid="tweet"]').first().waitFor({ state: 'visible', timeout: 15_000 });
  } catch {
    const empty = await page.evaluate(NO_RESULTS_JS).catch(() => false);
    if (empty) {
      logger.info(`query "${query}": no results yet (empty)`);
      return new Map();
    }
    logger.warn(`query "${query}": no tweets visible after 15s — proceeding (may be empty or slow)`);
  }

  const seen = new Map<string, MentionPost>();
  for (const p of await collect(page)) if (!seen.has(p.id)) seen.set(p.id, p);

  let idle = 0;
  let round = 0;
  const t0 = Date.now();
  while (seen.size < cfg.MAX_POSTS && idle < cfg.MAX_IDLE_ROUNDS) {
    round++;
    const before = seen.size;
    const hBefore = (await page.evaluate('document.documentElement.scrollHeight').catch(() => 0)) as number;

    await humanScroll(page, 1200);
    await humanPause(800, 1800);
    await sleep(400 + Math.random() * 600);

    for (const p of await collect(page)) if (!seen.has(p.id)) seen.set(p.id, p);
    const added = seen.size - before;
    const hAfter = (await page.evaluate('document.documentElement.scrollHeight').catch(() => 0)) as number;
    const grew = hAfter > hBefore;

    if (added === 0 && !grew) {
      idle++;
      if (await page.evaluate(END_MARKER_JS).catch(() => false)) {
        logger.info(`query "${query}": end-of-results marker — stopping (${seen.size} posts)`);
        break;
      }
      const wait = Math.min(8000, 1500 + idle * 800);
      logger.info(`query "${query}" round ${round}: +0 (total ${seen.size}, idle ${idle}/${cfg.MAX_IDLE_ROUNDS}) — wait ${wait}ms`);
      await sleep(wait);
      await page.keyboard.press('End').catch(() => {});
      await sleep(700);
      await page.evaluate('window.scrollBy(0, 2000)').catch(() => {});
      await sleep(700);
      if (idle % 3 === 0) {
        await page.evaluate('window.scrollBy(0, -1800)').catch(() => {});
        await sleep(500);
        await page.evaluate('window.scrollBy(0, 3500)').catch(() => {});
        await sleep(1000);
      }
    } else {
      idle = 0;
      logger.info(`query "${query}" round ${round}: +${added} (total ${seen.size}${grew ? ' grew' : ''})`);
    }
    if (round % 12 === 0) await sleep(3000 + Math.random() * 4000);
  }
  const mins = ((Date.now() - t0) / 60_000).toFixed(1);
  logger.info(`query "${query}": captured ${seen.size} posts in ${round} rounds (${mins}m)`);
  return seen;
}

function loadMaster(path: string, campaign: string, queries: string[]): Master {
  if (existsSync(path)) {
    try {
      const m = JSON.parse(readFileSync(path, 'utf8')) as Master;
      if (m && m.posts) return m;
    } catch (e) {
      logger.warn(`could not parse existing master (${path}) — starting fresh: ${e instanceof Error ? e.message : e}`);
    }
  }
  const now = new Date().toISOString();
  return { campaign, queries, first_run: now, last_run: now, runs: [], posts: {} };
}

/** Merge this run's per-query captures into the master, return count of new posts. */
function mergeIntoMaster(master: Master, perQuery: Map<string, Map<string, MentionPost>>): number {
  const now = new Date().toISOString();
  let added = 0;
  for (const [query, posts] of perQuery) {
    for (const [id, p] of posts) {
      const existing = master.posts[id];
      if (existing) {
        existing.last_captured = now;
        if (!existing.queries.includes(query)) existing.queries.push(query);
        existing.replies = Math.max(existing.replies, p.replies);
        existing.retweets = Math.max(existing.retweets, p.retweets);
        existing.likes = Math.max(existing.likes, p.likes);
        existing.bookmarks = Math.max(existing.bookmarks, p.bookmarks);
        existing.views = Math.max(existing.views, p.views);
        if ((!existing.images || existing.images.length === 0) && p.images && p.images.length > 0) {
          existing.images = p.images;
        }
      } else {
        master.posts[id] = {
          ...p,
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
        };
        added++;
      }
    }
  }
  return added;
}

/**
 * Run vision OCR over every master post that has an image and hasn't been OCR'd.
 * Idempotent: ocr_done gates reruns so the same screenshot is never re-billed.
 * Failures keep ocr_done false so a later run retries them.
 */
async function runOcr(master: Master): Promise<number> {
  const pending = Object.values(master.posts).filter((p) => !p.ocr_done && p.images && p.images.length > 0);
  if (pending.length === 0) {
    logger.info('OCR: no posts with un-processed images');
    return 0;
  }
  logger.info(`OCR: ${pending.length} post(s) with images to process`);
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
      logger.info(`OCR ${done}/${pending.length}: @${p.handle} ${p.is_bill ? `BILL ${p.bill_platform || '?'} ${p.bill_currency}${p.bill_amount}` : 'no-bill'}`);
    } else {
      logger.warn(`OCR: all images failed for @${p.handle} (${p.url}) — will retry next run`);
    }
  }
  logger.info(`OCR: processed ${done}/${pending.length} posts`);
  return done;
}

function buildMentionRows(master: Master): Record<string, unknown>[] {
  return Object.values(master.posts)
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
    .map((p) => ({
      post_id: p.id,
      handle: p.handle,
      name: p.name,
      type: p.type,
      repost_by: p.repost_by,
      posted_at: p.ts,
      text: p.text.replace(/\s+/g, ' ').trim(),
      likes: p.likes,
      retweets: p.retweets,
      replies: p.replies,
      bookmarks: p.bookmarks,
      views: p.views,
      has_media: p.hasMedia,
      image_urls: (p.images ?? []).join(' | '),
      is_bill: p.is_bill ?? false,
      bill_platform: p.bill_platform ?? '',
      bill_amount: p.bill_amount ?? '',
      bill_currency: p.bill_currency ?? '',
      bill_vendor: p.bill_vendor ?? '',
      bill_date: p.bill_date ?? '',
      ocr_text: (p.ocr_text ?? '').replace(/\s+/g, ' ').trim(),
      matched_queries: p.queries.join(' | '),
      url: p.url,
      first_captured: p.first_captured,
      last_captured: p.last_captured,
    }));
}

export interface RunStats {
  campaign: string;
  captured: number;
  new: number;
  ocr: number;
  totalPosts: number;
  totalAuthors: number;
  bills: number;
  files: { master: string; mentions: string; leaderboard: string };
}

/**
 * One full cycle: connect → harvest all queries → merge → OCR → write
 * master.json + mentions.csv + leaderboard.json. Returns stats. The browser is
 * connected over CDP (a logged-in Chrome the caller is responsible for running).
 */
export async function runOnce(): Promise<RunStats> {
  const cfg = getConfig();
  logger.info(`campaign "${cfg.CAMPAIGN}" — queries: ${cfg.QUERIES.join(', ')}${cfg.OCR ? ' — OCR on' : ''}`);

  const browser = await chromium.connectOverCDP(cfg.CDP_URL);
  let captured = 0;
  const perQuery = new Map<string, Map<string, MentionPost>>();
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error('no browser context — is Chrome running with --remote-debugging-port=9222?');
    const pages = context.pages();
    const page = pages.find((p) => /(^|\.)(x|twitter)\.com/.test(new URL(p.url()).hostname)) ?? pages[0];
    if (!page) throw new Error('no open tab found');
    await page.bringToFront();

    for (const q of cfg.QUERIES) {
      const got = await harvest(page, q);
      perQuery.set(q, got);
      captured += got.size;
      await humanPause(2000, 4000);
    }
  } finally {
    // free the tab before the (pure-API) OCR phase
    await browser.close().catch(() => {});
  }

  mkdirSync(cfg.DATA_DIR, { recursive: true });
  const masterPath = join(cfg.DATA_DIR, `${cfg.CAMPAIGN}_campaign_master.json`);
  const mentionsCsv = join(cfg.DATA_DIR, `${cfg.CAMPAIGN}_campaign_mentions.csv`);
  const leaderboardJson = join(cfg.DATA_DIR, `${cfg.CAMPAIGN}_leaderboard.json`);
  const leaderboardCsv = join(cfg.DATA_DIR, `${cfg.CAMPAIGN}_leaderboard.csv`);

  const master = loadMaster(masterPath, cfg.CAMPAIGN, cfg.QUERIES);
  const newCount = mergeIntoMaster(master, perQuery);
  master.last_run = new Date().toISOString();
  master.queries = Array.from(new Set([...master.queries, ...cfg.QUERIES]));

  let ocrDone = 0;
  if (cfg.OCR) ocrDone = await runOcr(master);
  master.runs.push({ ts: master.last_run, queries: cfg.QUERIES, captured, new: newCount, ocr: ocrDone });

  const leaderboard = buildLeaderboard(master);
  writeFileSync(masterPath, JSON.stringify(master, null, 2));
  writeFileSync(mentionsCsv, toCsv(buildMentionRows(master)));
  writeFileSync(leaderboardJson, JSON.stringify(leaderboard, null, 2));
  writeFileSync(leaderboardCsv, toCsv(leaderboardCsvRows(leaderboard)));

  const totalPosts = Object.keys(master.posts).length;
  const totalAuthors = leaderboard.entries.length;
  const bills = Object.values(master.posts).filter((p) => p.is_bill).length;
  logger.info(`run done: captured ${captured} (pre-dedupe), ${newCount} new, ${ocrDone} OCR'd`);
  logger.info(`master total: ${totalPosts} posts · ${totalAuthors} authors · ${bills} bills`);
  logger.info(`wrote: ${masterPath} · ${mentionsCsv} · ${leaderboardJson} · ${leaderboardCsv}`);

  return {
    campaign: cfg.CAMPAIGN,
    captured,
    new: newCount,
    ocr: ocrDone,
    totalPosts,
    totalAuthors,
    bills,
    files: { master: masterPath, mentions: mentionsCsv, leaderboard: leaderboardJson },
  };
}
